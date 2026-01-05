/**
 * =============================================================================
 * ARQUIVO: src/bot.ts
 * Main Application Entry Point
 * 
 * Refactored to use modular architecture:
 * - Centralized Configuration
 * - Factory-based Services (Database, AI, Context, Media, Game)
 * - Middleware (Rate Limiter)
 * - Functional Error Handling
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
import { createContextService } from './assistant/context';
import { gameService } from './game/services/game.service'; // Legacy service (to be refactored later)
import { todoService } from './services/todo.service'; // Legacy service

// --- Handlers & Middleware ---
import { createMediaHandler } from './bot/handlers/media';
import { createLeaderboardHandler } from './bot/handlers/leaderboard';
import { createRateLimiter } from './bot/middleware/rate-limiter';
import { createDuylhouHandler } from './bot/handlers/duylhou'; 
import { createAIHandler } from './bot/handlers/ai';

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
    persistIntervalMs: 5 * 60 * 1000, // 5 minutes
    linkExpiryMs: 24 * 60 * 60 * 1000, // 24 hours
    conversationMaxMessages: 20, // Keep last 20 messages per user
    leaderboardRetentionDays: 30, // Keep rankings for 30 days
    sessionMaxAgeDays: 90, // Keep sessions for 90 days
    cleanupIntervalMs: 60 * 60 * 1000, // Run cleanup every hour
  });

  if (dbError || !db) {
    auditLog.record(dbError?.code || 'DB_INIT_FAIL', { error: dbError?.message });
    process.exit(1);
  }

  // 3. Initialize Services
  const [geminiError, geminiService] = createGeminiService({
    apiKey: config.assistant.geminiApiKey,
    model: config.assistant.geminiModel,
  });

  if (geminiError || !geminiService) {
    auditLog.record(geminiError?.code || 'AI_INIT_FAIL', { error: geminiError?.message });
    process.exit(1);
  }

  const [contextError, contextService] = createContextService({
    database: db,
    maxMessages: config.assistant.maxHistoryMessages,
  });

  if (contextError || !contextService) {
    auditLog.record(contextError?.code || 'CTX_INIT_FAIL', { error: contextError?.message });
    process.exit(1);
  }

  // 4. Initialize Handlers & Middleware
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

  const aiHandler = createAIHandler({
      geminiService,
      contextService,
      botUsername: '@Spell_ZauberBot', // Hardcoded for now, or could fetch from bot info
      systemPrompt: config.assistant.systemPrompt,
      token: config.bot.token,
  });

  const [rlError, rateLimiter] = createRateLimiter({
    maxRequests: 5,
    windowMs: 60 * 1000,
  });

  // 5. Setup Bot
  const bot = new Bot(config.bot.token);

  // Register Middleware
  if (rateLimiter) {
    // Wrap global message handling logic if needed, or Apply to specific commands
    // For now, we apply it manually inside handlers or via a global middleware
    bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (userId && !rateLimiter.isAllowed(userId)) {
        // Simple check, real wrap logic is in the handler factory usually
        // But since createRateLimiter returns a specific 'wrap' function, we can use it on specific handlers
        // Or implement global check here:
        const resetMs = rateLimiter.getResetTime(userId);
        if (resetMs > 0) {
             // Rate limited
             return; 
        }
      }
      await next();
    });
  }

  // Command: Start
  bot.command('start', (ctx) => ctx.reply('Bot started! 🚀'));

  // Command: Game
  bot.command('game', async (ctx) => {
    try {
      await ctx.replyWithGame(config.bot.gameShortName);
    } catch (e) {
      console.error('Error sending game:', e);
      await ctx.reply('⚠️ Game not found.');
    }
  });

  // Command: Leaderboard
  bot.command('leaderboard', leaderboardHandler.handleCommand);

  // Command: TODO (Legacy)
  bot.hears(/#TODO/i, async (ctx) => {
      // Security: Only Admin can use this
      if (ctx.from?.id !== config.bot.adminId) {
          return ctx.reply('⚠️ Somente o administrador pode usar este comando.');
      }

      const text = ctx.message?.text || '';
      const user = ctx.from?.first_name || 'Desconhecido';
      const task = text.replace(/#TODO/i, '').trim();
      if (!task) return ctx.reply('⚠️ Use: #TODO Sua tarefa');
      try {
          await todoService.addTodo(task, user);
          await ctx.reply(`✅ Tarefa anotada!\n📝 *${task}*`, { parse_mode: 'Markdown' });
      } catch (e) { await ctx.reply('❌ Erro.'); }
  });

  // Message Handler (Media + AI + Duylhou)
  bot.on('message', async (ctx) => {
    // 1. Check for Rate Limit (consume slot)
    // (Ideally integrated via middleware, simplified here)
    
    // 2. Check for Social Media Links (Media Handler)
    await mediaHandler.handleMessage(ctx);

    // 3. Check for Repeated Links (Duylhou)
    await duylhouHandler.handleMessage(ctx);

    // 4. AI Logic
    await aiHandler.handleMessage(ctx);
  });

  // Callback Queries
  bot.on('callback_query:game_short_name', async (ctx) => {
    const url = `${config.server.url}/index.html`; 
    await ctx.answerCallbackQuery({ url });
  });

  // --- Express Server (Game API) ---
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../public'))); 

  // Game API Routes (Legacy - should be refactored to new architecture eventually)
  app.get('/api/game/state', async (req, res) => {
      const userId = Number(req.query.userId);
      if (!userId) return res.status(400).json({ error: 'Missing userId' });
      const session = await gameService.getSession(userId);
      res.json({
          phase: session.state,
          generation: session.generation,
          gender: session.gender,
          team: session.team,
          badges: session.badges,
          round: session.round,
          items: session.items,
          lastEventResult: session.lastEventResult
      });
  });
  
  // ... (Other Game API routes omitted for brevity, keeping legacy flow) ...
  app.post('/api/game/action', async (req, res) => {
    const { userId, action, selection } = req.body;
    
    if (!userId) {
        return res.status(400).json({ error: 'Missing userId' });
    }
    
    let session = await gameService.getSession(userId);
    
    try {
        switch (action) {
            case 'CONFIRM_GEN':
                // Safe transition: only moves forward if in GEN_ROULETTE
                // Calling twice does nothing (idempotent)
                session = await gameService.confirmGeneration(userId);
                break;
                
            case 'SELECT_GENDER':
                // Validates selection and only works in GENDER_ROULETTE state
                if (selection === 'male' || selection === 'female') {
                    session = await gameService.selectGender(userId, selection);
                }
                break;
                
            case 'SPIN_STARTER':
                await gameService.spinStarter(userId);
                // Re-fetch to get updated session with new team member
                session = await gameService.getSession(userId);
                break;

            case 'SPIN_START_ADVENTURE':
                await gameService.spinStartAdventure(userId);
                session = await gameService.getSession(userId);
                break;
                
            case 'RESET':
                session = await gameService.resetSession(userId);
                break;
                
            // ... other existing cases
        }
        
        res.json({
            phase: session.state,
            generation: session.generation,
            gender: session.gender,
            team: session.team,
            badges: session.badges,
            round: session.round,
            items: session.items,
            lastEventResult: session.lastEventResult,
            lastEvent: session.lastEvent
        });
        
    } catch (e) {
        console.error('Action error:', e);
        res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Start Server & Bot
  app.listen(config.server.port, () => {
    console.log(`Web Server running on port ${config.server.port}`);
  });

  // Error Handling
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
  console.log('Bot started with new architecture!');

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('Shutting down...');
    await db.shutdown();
    await bot.stop();
    process.exit(0);
  });
}

// Run Main
main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});