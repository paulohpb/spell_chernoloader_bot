/**
 * =============================================================================
 * Application Configuration
 * 
 * All environment variable access happens here. Configuration is passed
 * to factories/services rather than reading globals deep inside functions.
 * =============================================================================
 */

import 'dotenv/config';

/**
 * Bot configuration
 */
export interface BotConfig {
  token: string;
  gameShortName: string;
  targetGroupId: number;
  adminId: number;
}

/**
 * Server configuration
 */
export interface ServerConfig {
  port: number;
  url: string;
}

/**
 * Full application configuration
 */
export interface AppConfig {
  bot: BotConfig;
  server: ServerConfig;
  database: DatabaseConfigOptions;
  nodeEnv: string;
}

/**
 * Configuration error codes
 */
export const CONFIG_ERROR_CODES = {
  MISSING_BOT_TOKEN: 'CONFIG_001',
  INVALID_PORT: 'CONFIG_003',
} as const;

/**
 * Creates a configuration error
 */
function createConfigError(code: string, message: string) { // Changed AppError to any for now
  return {
    code,
    category: 'CONFIGURATION',
    message,
  };
}

/**
 * Reads a required environment variable
 */
function requireEnv(name: string, errorCode: string): [any | null, string | null] {
  const value = process.env[name];
  if (!value) {
    const error = createConfigError(errorCode, `Missing required environment variable: ${name}`);
    console.error(`ERROR: ${error.message} (Code: ${error.code}, Variable: ${name})`);
    return [error, null];
  }
  return [null, value];
}

/**
 * Reads an optional environment variable with a default
 */
function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

/**
 * Reads an optional numeric environment variable with a default
 */
function optionalEnvNumber(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}



/**
 * Loads and validates the application configuration.
 * 
 * @returns Result tuple with [error, config]
 */
export function loadConfig(): [any | null, AppConfig | null] {
  // Required: Bot token
  const [tokenError, botToken] = requireEnv('BOT_TOKEN', CONFIG_ERROR_CODES.MISSING_BOT_TOKEN);
  if (tokenError) {
    return [tokenError, null];
  }

  // Optional configurations with defaults
  const port = optionalEnvNumber('PORT', 3000);
  const serverUrl = optionalEnv('SERVER_URL', `http://localhost:${port}`);
  const gameShortName = optionalEnv('GAME_SHORT_NAME', 'chernomon');
  const targetGroupId = optionalEnvNumber('TARGET_GROUP_ID', -1001110648969);
  const adminId = optionalEnvNumber('ADMIN_ID', 0);
  const nodeEnv = optionalEnv('NODE_ENV', 'development');
  
  // Database configuration
  const dataDir = optionalEnv('DATA_DIR', './data');
  const persistIntervalMs = optionalEnvNumber('DB_PERSIST_INTERVAL_MS', 30000); // 30 seconds
  const linkExpiryMs = optionalEnvNumber('LINK_EXPIRY_MS', 24 * 60 * 60 * 1000); // 24 hours
  const conversationMaxMessages = optionalEnvNumber('CONVERSATION_MAX_MESSAGES', 10); // Last 10 messages
  const leaderboardRetentionDays = optionalEnvNumber('LEADERBOARD_RETENTION_DAYS', 30); // 30 days
  const sessionMaxAgeDays = optionalEnvNumber('SESSION_MAX_AGE_DAYS', 90); // 3 months
  const cleanupIntervalMs = optionalEnvNumber('CLEANUP_INTERVAL_MS', 24 * 60 * 60 * 1000); // Daily

  const config: AppConfig = {
    bot: {
      token: botToken!,
      gameShortName,
      targetGroupId,
      adminId,
    },
    server: {
      port,
      url: serverUrl,
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

  return [null, config];
}
