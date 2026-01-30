/**
 * =============================================================================
 * ARQUIVO: src/bot.ts
 * Main Application Entry Point
 *
 * Refactored: AI assistant is now command-based only.
 * The bot no longer engages in freeform conversation.
 * Available AI commands: /summary
 * =============================================================================
 */

import { Bot, GrammyError, HttpError } from 'grammy';
import express from 'express';
import cors from 'cors';
import path from 'path';

// --- Configuration & Logging ---
import { loadConfig } from './config';
import { auditLog } from './assistant/audit-log';
import { formatError } from './assistant/errors';

// --- Services ---
import { createDatabase } from './database';
import { createGeminiService } from './assistant/services/gemini.service';
import { gameService } from './game/services/game.service';
import { getGymLeader } from './game/data/gym-leaders';
import { todoService } from './services/todo.service';

// --- Handlers & Middleware ---
import { createMediaHandler } from './bot/handlers/media';
import { createLeaderboardHandler } from './bot/handlers/leaderboard';
import { createRateLimiter } from './bot/middleware/rate-limiter';
import { createDuylhouHandler } from './bot/handlers/duylhou';
import { createSummaryHandler } from './bot/handlers/summary';

// --- Main Application Logic ---

async function main() {
  // 1. Load Configuration
  const [configError, config] = loadConfig();
  if (configError || !config) {
    console.error('Failed to load configuration:', configError ? formatError(configError) : 'Unknown error');
    process.exit(1);
  }

  // 2. Initialize Database
  const [dbError, db] = createDatabase({
    dataDir: path.join(__dirname, '../data'),
    persistIntervalMs: 5 * 60 * 1000,
    linkExpiryMs: 24 * 60 * 60 * 1000,
    conversationMaxMessages: 20,
    leaderboardRetentionDays: 30,
    sessionMaxAgeDays: 90,
    cleanupIntervalMs: 60 * 60 * 1000,
  });

  if (dbError || !db) {
    auditLog.record(dbError?.code || 'DB_INIT_FAIL', { error: dbError?.message });
    process.exit(1);
  }

  // 3. Initialize Gemini Service (used for /summary command)
  const [geminiError, geminiService] = createGeminiService({
    apiKey: config.assistant.geminiApiKey,
    model: config.assistant.geminiModel,
  });

  if (geminiError || !geminiService) {
    auditLog.record(geminiError?.code || 'AI_INIT_FAIL', { error: geminiError?.message });
    process.exit(1);
  }

  // 4. Initialize Handlers
  const mediaHandler = createMediaHandler({
    targetGroupId: config.bot.targetGroupId,
  });

  const duylhouHandler = createDuylhouHandler({
    database: db,
    targetChatIds: [config.bot.targetGroupId],
  });

  const leaderboardHandler = createLeaderboardHandler({
    database: db,
  });

  const summaryHandler = createSummaryHandler({
    geminiService,
  });

  const [rlError, rateLimiter] = createRateLimiter({
    maxRequests: 5,
    windowMs: 60 * 1000,
  });

  // 5. Setup Bot
  const bot = new Bot(config.bot.token);

  // Register rate limiter middleware
  if (rateLimiter) {
    bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (userId && !rateLimiter.isAllowed(userId)) {
        return;
      }
      await next();
    });
  }

  // --- Commands ---

  bot.command('start', (ctx) => ctx.reply('Bot started! 🤖'));

  bot.command('game', async (ctx) => {
    try {
      // Try sending as a registered game first
      await ctx.replyWithGame(config.bot.gameShortName);
    } catch (e: any) {
      console.error('Error sending game via replyWithGame:', e?.message || e);
      
      // Fallback: Send as a Web App button if game isn't registered with BotFather
      try {
        const gameUrl = `${config.server.url}/index.html`;
        await ctx.reply('🎮 Chernomon Roulette', {
          reply_markup: {
            inline_keyboard: [[
              { text: '🎲 Play Chernomon!', web_app: { url: gameUrl } }
            ]]
          }
        });
      } catch (fallbackErr) {
        console.error('Fallback game button also failed:', fallbackErr);
        await ctx.reply('🎮 Game is not available right now. Make sure SERVER_URL is set to a public HTTPS URL.');
      }
    }
  });

  bot.command('leaderboard', leaderboardHandler.handleCommand);

  bot.command('summary', summaryHandler.handleCommand);

  // Legacy TODO command
  bot.hears(/#TODO/i, async (ctx) => {
    if (ctx.from?.id !== config.bot.adminId) {
      return ctx.reply('🚫 Somente o administrador pode usar este comando.');
    }

    const text = ctx.message?.text || '';
    const user = ctx.from?.first_name || 'Desconhecido';
    const task = text.replace(/#TODO/i, '').trim();
    if (!task) return ctx.reply('📝 Use: #TODO Sua tarefa');
    try {
      await todoService.addTodo(task, user);
      await ctx.reply(`✅ Tarefa anotada!\n📌 *${task}*`, { parse_mode: 'Markdown' });
    } catch (e) {
      await ctx.reply('❌ Erro.');
    }
  });

  // --- Message Handler (Media + Duylhou + Message Collection) ---
  bot.on('message', async (ctx) => {
    // 1. Collect messages for /summary (passive, no response)
    summaryHandler.collectMessage(ctx);

    // 2. Check for Social Media Links (Media Handler)
    await mediaHandler.handleMessage(ctx);

    // 3. Check for Repeated Links (Duylhou)
    await duylhouHandler.handleMessage(ctx);

    // NOTE: No more freeform AI responses here.
    // AI functionality is now exclusively command-based (/summary).
  });

  // Callback Queries (Game)
  bot.on('callback_query:game_short_name', async (ctx) => {
    const userId = ctx.from?.id || '';
    const url = `${config.server.url}/index.html?userId=${userId}`;
    await ctx.answerCallbackQuery({ url });
  });

  // --- Express Server (Game API) ---
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../public')));

  const buildGameResponse = (session: any) => {
    const response: any = {
      phase: session.state,
      generation: session.generation,
      gender: session.gender,
      team: session.team,
      badges: session.badges,
      round: session.round,
      items: session.items,
      lastEventResult: session.lastEventResult,
      lastEvent: session.lastEvent,
      lastCapturedPokemon: session.lastCapturedPokemon || null,
    };

    // Include gym leader data when in GYM_BATTLE state
    if (session.state === 'GYM_BATTLE') {
      const leader = getGymLeader(session.generation, session.badges);
      response.gymLeader = leader;
    }

    return response;
  };

  app.get('/api/game/state', async (req, res) => {
    const userId = Number(req.query.userId);
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    const session = await gameService.getSession(userId);
    res.json(buildGameResponse(session));
  });

  app.post('/api/game/action', async (req, res) => {
    const { userId, action, selection } = req.body;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    let session = await gameService.getSession(userId);

    try {
      switch (action) {
        case 'CONFIRM_GEN':
          session = await gameService.confirmGeneration(userId);
          break;
        case 'SELECT_GENDER':
          if (selection === 'male' || selection === 'female') {
            session = await gameService.selectGender(userId, selection);
          }
          break;
        case 'SPIN_STARTER':
          await gameService.spinStarter(userId);
          session = await gameService.getSession(userId);
          break;
        case 'SPIN_START_ADVENTURE':
          await gameService.spinStartAdventure(userId);
          session = await gameService.getSession(userId);
          break;
        case 'SPIN_MAIN_ADVENTURE':
          await gameService.spinMainAdventure(userId);
          session = await gameService.getSession(userId);
          break;
        case 'GYM_FIGHT':
          await gameService.fightGym(userId);
          session = await gameService.getSession(userId);
          break;
        case 'EVOLVE':
          await gameService.checkEvolution(userId);
          session = await gameService.getSession(userId);
          break;
        case 'RESET':
          session = await gameService.resetSession(userId);
          break;
      }

      res.json(buildGameResponse(session));
    } catch (e) {
      console.error('Action error:', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Start Server & Bot
  app.listen(config.server.port, () => {
    console.log(`Web Server running on port ${config.server.port}`);
  });

  bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`Error while handling update ${ctx.update.update_id}:`);
    const e = err.error;

    if (e instanceof GrammyError) {
      if (e.description.includes('kicked from the group')) {
        console.warn('⚠️ Bot was kicked from a group. Ignoring update.');
        return;
      }
      console.error('Error in request:', e.description);
    } else if (e instanceof HttpError) {
      console.error('Could not contact Telegram:', e);
    } else {
      console.error('Unknown error:', e);
    }
  });

  bot.start();
  console.log('Bot started! AI is now command-based only (/summary).');

  process.on('SIGINT', async () => {
    console.log('Shutting down...');
    await db.shutdown();
    await bot.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
