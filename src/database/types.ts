/**
 * =============================================================================
 * Database Types - Core types for the centralized database
 * =============================================================================
 */

/**
 * Conversation message stored in database
 */
export interface ConversationRecord {
  id: number;
  userId: number;
  chatId: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;  // Unix timestamp ms
}

/**
 * Link record for duplicate detection (Duylhou feature)
 */
export interface LinkRecord {
  id: number;
  url: string;
  normalizedUrl: string;  // URL without tracking params, etc.
  chatId: number;
  userId: number;
  messageId: number;
  createdAt: number;  // Unix timestamp ms
  expiresAt: number;  // Unix timestamp ms (24h from creation)
}

/**
 * Duylhou incident record - tracks when someone posted a duplicate
 */
export interface DuylhouIncident {
  id: number;
  offenderId: number;     // The user who posted the duplicate
  originalUserId: number; // The user who posted originally
  chatId: number;
  normalizedUrl: string;
  createdAt: number;      // Unix timestamp ms
  month: string;          // YYYY-MM format for monthly aggregation
}

/**
 * Monthly leaderboard record - persisted ranking
 */
export interface DuylhouLeaderboardEntry {
  userId: number;
  month: string;          // YYYY-MM format
  count: number;          // Number of Duylhou incidents
  lastIncidentAt: number; // Unix timestamp ms
}

/**
 * Rate limit record
 */
export interface RateLimitRecord {
  userId: number;
  timestamps: number[];  // Unix timestamps ms
}

/**
 * A single raw group-chat message buffered for use by the /summary command.
 * Persisted per chat so the buffer survives bot restarts.
 */
export interface ChatMessageRecord {
  id: number;
  /** Telegram chat ID this message belongs to. */
  chatId: number;
  /** Sender's Telegram user ID. */
  userId: number;
  /** Sender's display name at the time of the message. */
  username: string;
  /** Plain-text message content. */
  text: string;
  /** Unix timestamp (ms) when the message was received. */
  createdAt: number;
}

/**
 * A persisted `/summary` output so the group does not lose its last summary
 * on bot restart.  Only the most-recent summary per chat is shown to users;
 * older ones are kept for a configurable retention window then cleaned up.
 */
export interface SummaryRecord {
  id: number;
  /** The chat the summary was generated for. */
  chatId: number;
  /** Human-readable time-range label the user requested (e.g. "2h30m"). */
  rangeLabel: string;
  /** Number of raw messages that were fed into Gemini. */
  messageCount: number;
  /** The full formatted summary text that was sent to the chat. */
  summary: string;
  /** Unix timestamp (ms) when the summary was generated. */
  createdAt: number;
}

/**
 * A single admin todo item persisted in the central database.
 */
export interface TodoRecord {
  id: number;
  /** Free-text task description entered by the admin. */
  text: string;
  /** Display name of the admin who created the task. */
  user: string;
  /** Human-readable creation timestamp (São Paulo TZ). */
  createdAt: string;
}

/**
 * A single long-term memory fragment for a user.
 * Used by the memory service for RAG-lite retrieval.
 *
 * ISOLATION: Each record is strictly tied to a single userId.
 * Cross-user access is prevented at the database API level.
 */
export interface UserMemoryRecord {
  /** Auto-incremented unique ID. */
  id: number;
  /** Telegram user ID — the isolation key. NEVER query across users. */
  userId: number;
  /** Category of this memory. */
  type: 'preference' | 'fact' | 'interest';
  /** The actual knowledge content (short, dense description). */
  content: string;
  /** Extracted keywords for retrieval matching. */
  keywords: string[];
  /** Confidence score 0-1 (higher = more certain). */
  confidence: number;
  /** Which command created this memory. */
  source: string;
  /** Unix timestamp (ms) when created. */
  createdAt: number;
  /** Unix timestamp (ms) when last used in a prompt. */
  lastAccessedAt: number;
  /** How many times this memory has been used. */
  accessCount: number;
}

/**
 * All collections in the database
 */
export interface DatabaseSchema {
  conversations: ConversationRecord[];
  links: LinkRecord[];
  rateLimits: RateLimitRecord[];
  duylhouIncidents: DuylhouIncident[];
  duylhouLeaderboard: DuylhouLeaderboardEntry[];
  todos: TodoRecord[];
  summaries: SummaryRecord[];
  /** Raw group-chat message buffer used by /summary. */
  chatMessages: ChatMessageRecord[];
  /** Long-term user memories for RAG-lite retrieval. */
  userMemories: UserMemoryRecord[];
  meta: {
    version: number;
    lastSaved: number;
    conversationNextId: number;
    linkNextId: number;
    duylhouIncidentNextId: number;
    todoNextId: number;
    summaryNextId: number;
    chatMessageNextId: number;
    userMemoryNextId: number;
  };
}

/**
 * Database configuration
 */
export interface DatabaseConfig {
  dataDir: string;
  persistIntervalMs: number;  // How often to persist to disk
  linkExpiryMs: number;       // How long links are remembered (default 24h)
  conversationMaxMessages: number;  // Max messages per user/chat (default 10)
  leaderboardRetentionDays: number; // How long to keep leaderboard data (default 30)
  cleanupIntervalMs: number;        // How often to run cleanup (default 24h)
  /** Maximum age (ms) of buffered chat messages before they are purged (default 24 h). */
  chatBufferMaxAgeMs?: number;
  /** Maximum memories per user before eviction (default 50). */
  maxMemoriesPerUser?: number;
  /** Days after which unused memories start decaying (default 30). */
  memoryDecayDays?: number;
}

/**
 * Database error codes
 */
export const DB_ERROR_CODES = {
  INIT_FAILED: 'DB_001',
  PERSIST_FAILED: 'DB_002',
  LOAD_FAILED: 'DB_003',
  QUERY_FAILED: 'DB_004',
  INVALID_DATA: 'DB_005',
} as const;
