/**
 * =============================================================================
 * Database Module - Public API
 * =============================================================================
 */

export { createDatabase } from './database';
export type { Database, LeaderboardRanking, CleanupResult, DatabaseStats } from './database';

export {
  DB_ERROR_CODES,
} from './types';

export type {
  DatabaseConfig,
  DatabaseSchema,
  ConversationRecord,
  LinkRecord,
  RateLimitRecord,
  DuylhouIncident,
  DuylhouLeaderboardEntry,
  TodoRecord,
  SummaryRecord,
  ChatMessageRecord,
  UserMemoryRecord,
} from './types';

export {
  extractUrls,
  normalizeUrl,
  extractAndNormalizeUrls,
} from './link-utils';
