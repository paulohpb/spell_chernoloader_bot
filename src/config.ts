/**
 * =============================================================================
 * Application Configuration
 *
 * All environment variable access happens here. Configuration is passed
 * to factories/services rather than reading globals deep inside functions.
 *
 * Refactored: Removed conversational AI persona (SYSTEM_PROMPT).
 * AI is now command-based only. The summary prompt lives in the handler.
 * =============================================================================
 */

import 'dotenv/config';
import { AppError } from './assistant/types';
import { auditLog } from './assistant/audit-log';

export interface BotConfig {
  token: string;
  gameShortName: string;
  targetGroupId: number;
  adminId: number;
}

export interface ServerConfig {
  port: number;
  url: string;
}

export interface AssistantConfig {
  geminiApiKey: string;
  geminiModel: string;
  maxHistoryMessages: number;
}

export interface DatabaseConfigOptions {
  dataDir: string;
  persistIntervalMs: number;
  linkExpiryMs: number;
  conversationMaxMessages: number;
  leaderboardRetentionDays: number;
  sessionMaxAgeDays: number;
  cleanupIntervalMs: number;
}

export interface AppConfig {
  bot: BotConfig;
  server: ServerConfig;
  assistant: AssistantConfig;
  database: DatabaseConfigOptions;
  nodeEnv: string;
}

export const CONFIG_ERROR_CODES = {
  MISSING_BOT_TOKEN: 'CONFIG_001',
  MISSING_GEMINI_KEY: 'CONFIG_002',
  INVALID_PORT: 'CONFIG_003',
} as const;

function createConfigError(code: string, message: string): AppError {
  return { code, category: 'CONFIGURATION', message };
}

function requireEnv(name: string, errorCode: string): [AppError | null, string | null] {
  const value = process.env[name];
  if (!value) {
    const error = createConfigError(errorCode, `Missing required environment variable: ${name}`);
    auditLog.record(error.code, { message: error.message, variable: name });
    return [error, null];
  }
  return [null, value];
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

function optionalEnvNumber(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Loads and validates the application configuration.
 */
export function loadConfig(): [AppError | null, AppConfig | null] {
  const [tokenError, botToken] = requireEnv('BOT_TOKEN', CONFIG_ERROR_CODES.MISSING_BOT_TOKEN);
  if (tokenError) return [tokenError, null];

  const [geminiError, geminiApiKey] = requireEnv('GEMINI_API_KEY', CONFIG_ERROR_CODES.MISSING_GEMINI_KEY);
  if (geminiError) return [geminiError, null];

  const port = optionalEnvNumber('PORT', 3000);
  const serverUrl = optionalEnv('SERVER_URL', `http://localhost:${port}`);
  const gameShortName = optionalEnv('GAME_SHORT_NAME', 'chernomon');
  const targetGroupId = optionalEnvNumber('TARGET_GROUP_ID', -1000000000000);
  const adminId = optionalEnvNumber('ADMIN_ID', 0);
  const geminiModel = optionalEnv('GEMINI_MODEL', 'gemini-2.5-flash');
  const maxHistoryMessages = optionalEnvNumber('MAX_HISTORY_MESSAGES', 20);
  const nodeEnv = optionalEnv('NODE_ENV', 'development');

  const dataDir = optionalEnv('DATA_DIR', './data');
  const persistIntervalMs = optionalEnvNumber('DB_PERSIST_INTERVAL_MS', 30000);
  const linkExpiryMs = optionalEnvNumber('LINK_EXPIRY_MS', 24 * 60 * 60 * 1000);
  const conversationMaxMessages = optionalEnvNumber('CONVERSATION_MAX_MESSAGES', 10);
  const leaderboardRetentionDays = optionalEnvNumber('LEADERBOARD_RETENTION_DAYS', 30);
  const sessionMaxAgeDays = optionalEnvNumber('SESSION_MAX_AGE_DAYS', 90);
  const cleanupIntervalMs = optionalEnvNumber('CLEANUP_INTERVAL_MS', 24 * 60 * 60 * 1000);

  const config: AppConfig = {
    bot: {
      token: botToken!,
      gameShortName,
      targetGroupId,
      adminId,
    },
    server: { port, url: serverUrl },
    assistant: {
      geminiApiKey: geminiApiKey!,
      geminiModel,
      maxHistoryMessages,
    },
    database: {
      dataDir,
      persistIntervalMs,
      linkExpiryMs,
      conversationMaxMessages,
      leaderboardRetentionDays,
      sessionMaxAgeDays,
      cleanupIntervalMs,
    },
    nodeEnv,
  };

  auditLog.trace('Configuration loaded successfully');
  return [null, config];
}