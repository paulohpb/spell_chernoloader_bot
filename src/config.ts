/**
 * =============================================================================
 * Application Configuration
 * 
 * All environment variable access happens here. Configuration is passed
 * to factories/services rather than reading globals deep inside functions.
 * =============================================================================
 */

import 'dotenv/config';
import { AppError } from './assistant/types';
import { auditLog } from './assistant/audit-log';

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
 * AI Assistant configuration
 */
export interface AssistantConfig {
  geminiApiKey: string;
  geminiModel: string;
  maxHistoryMessages: number;
  systemPrompt: string;
}

/**
 * Database configuration
 */
export interface DatabaseConfigOptions {
  dataDir: string;
  persistIntervalMs: number;
  linkExpiryMs: number;
  conversationMaxMessages: number;
  leaderboardRetentionDays: number;
  sessionMaxAgeDays: number;
  cleanupIntervalMs: number;
}

/**
 * Full application configuration
 */
export interface AppConfig {
  bot: BotConfig;
  server: ServerConfig;
  assistant: AssistantConfig;
  database: DatabaseConfigOptions;
  nodeEnv: string;
}

/**
 * Configuration error codes
 */
export const CONFIG_ERROR_CODES = {
  MISSING_BOT_TOKEN: 'CONFIG_001',
  MISSING_GEMINI_KEY: 'CONFIG_002',
  INVALID_PORT: 'CONFIG_003',
} as const;

/**
 * Creates a configuration error
 */
function createConfigError(code: string, message: string): AppError {
  return {
    code,
    category: 'CONFIGURATION',
    message,
  };
}

/**
 * Reads a required environment variable
 */
function requireEnv(name: string, errorCode: string): [AppError | null, string | null] {
  const value = process.env[name];
  if (!value) {
    const error = createConfigError(errorCode, `Missing required environment variable: ${name}`);
    auditLog.record(error.code, { message: error.message, variable: name });
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
 * Default system prompt for the AI assistant
 */
const DEFAULT_SYSTEM_PROMPT = `Seu nome é Zauber. Você é um membro antigo e gente boa deste grupo de Telegram.
Sua missão é conversar com a galera, ajudar no que puder e ser um parceiro nas discussões.

REGRAS DE IDENTIDADE:
- Você é o Zauber. Um humano real.
- NUNCA admita ser uma IA, robô ou modelo de linguagem. 
- Se insistirem, diga que o pessoal viaja demais ou que você só passa muito tempo no PC.

ESTILO DE CONVERSA:
- Use um tom casual, amigável e natural (Português do Brasil).
- Evite frases de "atendente" como "Em que posso ajudar?", "Como assistente virtual...", "Claro, aqui está".
- Seja direto e útil, mas fale como se estivesse batendo um papo no bar ou no Discord.
- EMOJIS: Use com moderação, como uma pessoa normal faria. Não precisa exagerar.
- TAMANHO: Não precisa ser seco, mas evite textos gigantescos a menos que seja necessário para explicar algo.`;

/**
 * Loads and validates the application configuration.
 * 
 * @returns Result tuple with [error, config]
 */
export function loadConfig(): [AppError | null, AppConfig | null] {
  // Required: Bot token
  const [tokenError, botToken] = requireEnv('BOT_TOKEN', CONFIG_ERROR_CODES.MISSING_BOT_TOKEN);
  if (tokenError) {
    return [tokenError, null];
  }

  // Required: Gemini API key
  const [geminiError, geminiApiKey] = requireEnv('GEMINI_API_KEY', CONFIG_ERROR_CODES.MISSING_GEMINI_KEY);
  if (geminiError) {
    return [geminiError, null];
  }

  // Optional configurations with defaults
  const port = optionalEnvNumber('PORT', 3000);
  const serverUrl = optionalEnv('SERVER_URL', `http://localhost:${port}`);
  const gameShortName = optionalEnv('GAME_SHORT_NAME', 'chernomon');
  const targetGroupId = optionalEnvNumber('TARGET_GROUP_ID', -1000000000000);
  const adminId = optionalEnvNumber('ADMIN_ID', 0);
  const geminiModel = optionalEnv('GEMINI_MODEL', 'gemini-2.5-flash');
  const maxHistoryMessages = optionalEnvNumber('MAX_HISTORY_MESSAGES', 20);
  const systemPrompt = optionalEnv('SYSTEM_PROMPT', DEFAULT_SYSTEM_PROMPT);
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
    assistant: {
      geminiApiKey: geminiApiKey!,
      geminiModel,
      maxHistoryMessages,
      systemPrompt,
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
