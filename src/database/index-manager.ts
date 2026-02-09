/**
 * @module database/index-manager
 *
 * Owns every in-memory index that sits on top of {@link DatabaseSchema}.
 * Exposes:
 *   - A single {@link IndexManager} object that holds all Map instances.
 *   - {@link rebuildAllIndexes} — rebuilds every index from the schema
 *     arrays in one pass (called after load and after migrations).
 *   - {@link rebuildFromIndexes} — inverse direction: writes every index
 *     back into the schema arrays so the object is ready to serialise.
 *
 * The manager is intentionally stateless beyond the Maps it holds.
 * Business logic (add / find / cleanup) stays in `database.ts`.
 */

import {
  DatabaseSchema,
  ConversationRecord,
  LinkRecord,
  RateLimitRecord,
  DuylhouIncident,
  DuylhouLeaderboardEntry,
  SummaryRecord,
  ChatMessageRecord,
  UserMemoryRecord,
} from './types';

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

/**
 * All in-memory indexes grouped into a single object so they can be
 * passed around without a long parameter list.
 */
export interface IndexManager {
  /** `"userId:chatId"` → ordered conversation records. */
  conversations: Map<string, ConversationRecord[]>;
  /** `"normalizedUrl:chatId"` → link record (only non-expired). */
  links: Map<string, LinkRecord>;
  /** `userId` → rate-limit timestamps. */
  rateLimits: Map<number, RateLimitRecord>;
  /** `"userId:month"` → leaderboard entry. */
  duylhouLeaderboard: Map<string, DuylhouLeaderboardEntry>;
  /** `incident.id` → incident record. */
  duylhouIncidents: Map<number, DuylhouIncident>;
  /** `chatId` → latest summary for that chat. */
  summaries: Map<number, SummaryRecord>;
  /** `chatId` → buffered raw group-chat messages, sorted oldest-first. */
  chatMessages: Map<number, ChatMessageRecord[]>;
  /** `userId` → user memories, sorted with most recently accessed first. */
  userMemories: Map<number, UserMemoryRecord[]>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a fresh {@link IndexManager} with every map empty.
 */
export const createIndexManager = (): IndexManager => ({
  conversations: new Map(),
  links: new Map(),
  rateLimits: new Map(),
  duylhouLeaderboard: new Map(),
  duylhouIncidents: new Map(),
  summaries: new Map(),
  chatMessages: new Map(),
  userMemories: new Map(),
});

// ---------------------------------------------------------------------------
// Rebuild: schema → indexes
// ---------------------------------------------------------------------------

/**
 * Populates every map in `indexes` from the corresponding arrays in
 * `schema`.  Existing map contents are cleared first so the function
 * is idempotent — safe to call more than once.
 *
 * @param indexes - The index manager to populate.
 * @param schema  - The authoritative schema (loaded from disk or freshly
 *                  migrated).
 */
export const rebuildAllIndexes = (indexes: IndexManager, schema: DatabaseSchema): void => {
  // --- conversations ---
  indexes.conversations.clear();
  for (const record of schema.conversations) {
    const key = `${record.userId}:${record.chatId}`;
    const existing = indexes.conversations.get(key) || [];
    existing.push(record);
    indexes.conversations.set(key, existing);
  }
  // Sort each list by createdAt ascending (oldest first).
  for (const records of indexes.conversations.values()) {
    records.sort((a, b) => a.createdAt - b.createdAt);
  }

  // --- links (skip expired) ---
  indexes.links.clear();
  const now = Date.now();
  for (const record of schema.links) {
    if (record.expiresAt > now) {
      indexes.links.set(`${record.normalizedUrl}:${record.chatId}`, record);
    }
  }

  // --- rate limits ---
  indexes.rateLimits.clear();
  for (const record of schema.rateLimits) {
    indexes.rateLimits.set(record.userId, record);
  }

  // --- duylhou leaderboard ---
  indexes.duylhouLeaderboard.clear();
  for (const entry of schema.duylhouLeaderboard) {
    indexes.duylhouLeaderboard.set(`${entry.userId}:${entry.month}`, entry);
  }

  // --- duylhou incidents ---
  indexes.duylhouIncidents.clear();
  for (const incident of schema.duylhouIncidents) {
    indexes.duylhouIncidents.set(incident.id, incident);
  }

  // --- summaries (keep only latest per chatId) ---
  indexes.summaries.clear();
  for (const rec of schema.summaries) {
    const existing = indexes.summaries.get(rec.chatId);
    if (!existing || rec.createdAt > existing.createdAt) {
      indexes.summaries.set(rec.chatId, rec);
    }
  }

  // --- chat messages buffer (persistent /summary backing store) ---
  indexes.chatMessages.clear();
  for (const record of schema.chatMessages) {
    const existing = indexes.chatMessages.get(record.chatId) || [];
    existing.push(record);
    indexes.chatMessages.set(record.chatId, existing);
  }
  // Ensure each list is sorted oldest-first after bulk load.
  for (const records of indexes.chatMessages.values()) {
    records.sort((a, b) => a.createdAt - b.createdAt);
  }

  // --- user memories ---
  indexes.userMemories.clear();
  if (schema.userMemories) {
    for (const record of schema.userMemories) {
      const existing = indexes.userMemories.get(record.userId) || [];
      existing.push(record);
      indexes.userMemories.set(record.userId, existing);
    }
    // Sort memories by lastAccessedAt descending (most recent first).
    for (const records of indexes.userMemories.values()) {
      records.sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);
    }
  }
};

// ---------------------------------------------------------------------------
// Rebuild: indexes → schema (pre-flush)
// ---------------------------------------------------------------------------

/**
 * Writes every index back into the matching arrays on `schema` so
 * the object is fully up to date before it is serialised to disk.
 *
 * `todos` is intentionally excluded — it lives directly on the schema
 * and has no separate index.
 *
 * @param indexes - Current in-memory indexes (source of truth).
 * @param schema  - The schema object whose arrays will be overwritten.
 */
export const rebuildFromIndexes = (indexes: IndexManager, schema: DatabaseSchema): void => {
  schema.conversations = [];
  for (const records of indexes.conversations.values()) {
    schema.conversations.push(...records);
  }

  schema.links = Array.from(indexes.links.values());
  schema.rateLimits = Array.from(indexes.rateLimits.values());
  schema.duylhouLeaderboard = Array.from(indexes.duylhouLeaderboard.values());
  schema.duylhouIncidents = Array.from(indexes.duylhouIncidents.values());
  schema.summaries = Array.from(indexes.summaries.values());

  schema.chatMessages = [];
  for (const records of indexes.chatMessages.values()) {
    schema.chatMessages.push(...records);
  }

  schema.userMemories = [];
  for (const records of indexes.userMemories.values()) {
    schema.userMemories.push(...records);
  }
};
