/**
 * =============================================================================
 * ARQUIVO: src/bot.ts
 * Main Application Entry Point
 *
 * Commands (all AI-powered ones are rate-limited via rateLimiter.wrap):
 *   /summary   – summarise recent chat history
 *   /news      – scrape + summarise a quoted news article
 *   /videosum  – download + summarise a quoted video
 *   #TODO      – admin-only task capture (persisted in the central database)
 *
 * Express server exposes a /health endpoint so container orchestrators can
 * probe liveness without the bot token.
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
import { createScraperService } from './assistant/services/scraper.service';
import { createVideoExtractorService } from './assistant/services/video-extractor.service';
import { createMemoryService } from './assistant/services/memory.service';

// --- Handlers & Middleware ---
import { createMediaHandler } from './bot/handlers/media';
import { createRateLimiter } from './bot/middleware/rate-limiter';
import { createDuylhouHandler } from './bot/handlers/duylhou';
import { createSummaryHandler } from './bot/handlers/summary';
import { createNewsHandler } from './bot/handlers/news';
import { createVideoSumHandler } from './bot/handlers/videosum';
import { createTraduzirHandler } from './bot/handlers/traduzir';
import { escapeMarkdownV2 } from './bot/handlers/telegram-formatting';

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
    cleanupIntervalMs: 60 * 60 * 1000,
  });

  if (dbError || !db) {
    auditLog.record(dbError?.code || 'DB_INIT_FAIL', { error: dbError?.message });
    process.exit(1);
  }

  // 3. Initialize Gemini Service
  const [geminiError, geminiService] = createGeminiService({
    apiKey: config.assistant.geminiApiKey,
    model: config.assistant.geminiModel,
  });

  if (geminiError || !geminiService) {
    auditLog.record(geminiError?.code || 'AI_INIT_FAIL', { error: geminiError?.message });
    process.exit(1);
  }

  // 4. Initialize Scraper Service
  const [scraperError, scraperService] = createScraperService({});

  if (scraperError || !scraperService) {
    auditLog.record('SCRAPER_INIT_FAIL', { error: 'Failed to initialize scraper service' });
    process.exit(1);
  }

  // 5. Initialize Video Extractor Service
  const [videoExtractorError, videoExtractorService] = createVideoExtractorService({});

  if (videoExtractorError || !videoExtractorService) {
    auditLog.record(
      videoExtractorError?.code || 'VIDEO_EXTRACTOR_INIT_FAIL',
      { error: videoExtractorError?.message || 'Failed to initialize video extractor' },
    );
    process.exit(1);
  }

  // 6. Rate Limiter  (created early — used to wrap every AI command below)
  const [rlError, rateLimiter] = createRateLimiter({
    maxRequests: 5,
    windowMs: 60 * 1000,
    database: db,   // persist across restarts
  });

  if (rlError || !rateLimiter) {
    auditLog.record('RATE_LIMIT_INIT_FAIL', { error: rlError?.message });
    process.exit(1);
  }

  // 7. Initialize Memory Service
  const [memoryError, memoryService] = createMemoryService(db, geminiService, {
    maxMemoriesPerUser: 50, // Match DB cap
    memoryTokenBudget: 1000, // Character limit for memory context
  });

  if (memoryError || !memoryService) {
    auditLog.record('MEMORY_INIT_FAIL', { error: memoryError?.message });
    // Memory is optional but we want to log if it fails
  }

  // 8. Initialize Handlers
  const mediaHandler = createMediaHandler({
    targetGroupId: config.bot.targetGroupId,
  });

  const duylhouHandler = createDuylhouHandler({
    database: db,
    targetChatIds: [config.bot.targetGroupId],
    // Sticker file_id is loaded from .env — see .env.example for instructions
    // on how to obtain it.  When empty the handler falls back to a text reply.
    duylhouStickerFileId: config.bot.duylhouStickerFileId,
  });

  const summaryHandler = createSummaryHandler({
    geminiService,
    database: db,
  });

  const newsHandler = createNewsHandler({
    geminiService,
    scraperService,
  });
  if (memoryService) newsHandler.setMemoryService(memoryService);

  const videoSumHandler = createVideoSumHandler({
    geminiService,
    videoExtractorService,
  });
  if (memoryService) videoSumHandler.setMemoryService(memoryService);

  const traduzirHandler = createTraduzirHandler({
    geminiService,
    scraperService,
  });
  if (memoryService) traduzirHandler.setMemoryService(memoryService);

  // 9. Setup Bot
  const bot = new Bot(config.bot.token);

  // --- Commands ---

  bot.command('start', (ctx) => ctx.reply('Bot started! 🤖'));

  // AI commands wrapped individually so each one consumes a rate-limit slot
  // AND replies with the reset time when the limit is hit.
  bot.command('summary', rateLimiter.wrap(summaryHandler.handleCommand));
  bot.command('news', rateLimiter.wrap(newsHandler.handleCommand));
  bot.command('videosum', rateLimiter.wrap(videoSumHandler.handleCommand));
  bot.command('traduzir', rateLimiter.wrap(traduzirHandler.handleCommand));

  // --- #TODO (admin-only, persisted via centralised database) ---
  bot.hears(/#TODO/i, async (ctx) => {
    if (ctx.from?.id !== config.bot.adminId) {
      return ctx.reply('🚫 Somente o administrador pode usar este comando\\.', {
        parse_mode: 'MarkdownV2',
      });
    }

    const text = ctx.message?.text || '';
    const user = ctx.from?.first_name || 'Desconhecido';
    const task = text.replace(/#TODO/i, '').trim();
    if (!task) {
      return ctx.reply('📝 Use: \\#TODO Sua tarefa', { parse_mode: 'MarkdownV2' });
    }

    try {
      db.addTodo({ text: task, user });
      const escapedTask = escapeMarkdownV2(task);
      await ctx.reply(`✅ Tarefa anotada\\!\n📌 *${escapedTask}*`, {
        parse_mode: 'MarkdownV2',
      });
    } catch (e) {
      await ctx.reply('❌ Erro\\.');
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
  });

  // --- Express Server ---
  const app = express();
  app.use(cors());
  app.use(express.json());

  /**
   * Health-check endpoint.  Returns 200 with a tiny JSON body so
   * load-balancers / container runtimes can confirm the process is alive
   * without needing the Telegram token.
   */
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  app.listen(config.server.port, () => {
    console.log(`Web Server running on port ${config.server.port}`);
  });

  // --- Grammy error handler ---
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
  console.log('Bot started! AI commands: /summary, /news, /videosum');

  // --- Graceful shutdown (both SIGINT from keyboard and SIGTERM from
  //     container runtimes) ---
  const shutdown = async () => {
    console.log('Shutting down…');
    await db.shutdown();
    await bot.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
