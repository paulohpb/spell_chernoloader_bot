/**
 * =============================================================================
 * Database Types - Core types for the centralized database
 * =============================================================================
 */

import { PlayerSession } from '../game/types';

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
 * Game session record (re-export for convenience)
 */
export type GameSessionRecord = PlayerSession;

/**
 * All collections in the database
 */
export interface DatabaseSchema {
  conversations: ConversationRecord[];
  links: LinkRecord[];
  rateLimits: RateLimitRecord[];
  gameSessions: GameSessionRecord[];
  duylhouIncidents: DuylhouIncident[];
  duylhouLeaderboard: DuylhouLeaderboardEntry[];
  meta: {
    version: number;
    lastSaved: number;
    conversationNextId: number;
    linkNextId: number;
    duylhouIncidentNextId: number;
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
  sessionMaxAgeDays: number;        // Max age for game sessions (default 90)
  cleanupIntervalMs: number;        // How often to run cleanup (default 24h)
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
