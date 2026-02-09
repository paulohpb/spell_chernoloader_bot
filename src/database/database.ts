/**
 * =============================================================================
 * Centralized Database - Single source of truth for all persistent data
 * 
 * Features:
 * - In-memory cache for fast reads
 * - Batched writes to disk (configurable interval)
 * - Automatic cleanup of expired data
 * - Thread-safe operations with locks
 * =============================================================================
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { AppError } from '../assistant/types';
import { auditLog } from '../assistant/audit-log';
import {
  DatabaseSchema,
  DatabaseConfig,
  ConversationRecord,
  LinkRecord,
  DuylhouIncident,
  DuylhouLeaderboardEntry,
  TodoRecord,
  SummaryRecord,
  ChatMessageRecord,
  UserMemoryRecord,
  DB_ERROR_CODES,
} from './types';
import { createEmptySchema, applyMigrations } from './schema-migrator';
import { createIndexManager, rebuildAllIndexes, rebuildFromIndexes, IndexManager } from './index-manager';

/**
 * Leaderboard entry with rank
 */
export interface LeaderboardRanking {
  userId: number;
  count: number;
  rank: number;
  lastIncidentAt: number;
}

/**
 * Database interface
 */
export interface Database {
  // Conversations
  getConversations: (userId: number, chatId?: number, limit?: number) => ConversationRecord[];
  addConversation: (record: Omit<ConversationRecord, 'id' | 'createdAt'>) => ConversationRecord;
  clearConversations: (userId: number, chatId?: number) => number;

  // Links (Duylhou feature)
  findLink: (normalizedUrl: string, chatId: number) => LinkRecord | null;
  addLink: (record: Omit<LinkRecord, 'id' | 'createdAt' | 'expiresAt'>) => LinkRecord;
  cleanupExpiredLinks: () => number;

  // Duylhou incidents & leaderboard
  recordDuylhouIncident: (offenderId: number, originalUserId: number, chatId: number, normalizedUrl: string) => DuylhouIncident;
  getDuylhouLeaderboard: (month?: string, limit?: number) => LeaderboardRanking[];
  getCurrentMonth: () => string;
  cleanupOldIncidents: (monthsToKeep?: number) => number;

  // Rate limits
  getRateLimitTimestamps: (userId: number) => number[];
  setRateLimitTimestamps: (userId: number, timestamps: number[]) => void;
  cleanupRateLimits: (windowMs: number) => number;

  // Todos
  addTodo: (record: { text: string; user: string }) => TodoRecord;
  getTodos: () => TodoRecord[];

  // Summaries
  addSummary: (record: { chatId: number; rangeLabel: string; messageCount: number; summary: string }) => SummaryRecord;
  getLatestSummary: (chatId: number) => SummaryRecord | null;

  // Chat message buffer (persistent backing store for /summary)
  addChatMessage: (record: Omit<ChatMessageRecord, 'id' | 'createdAt'>) => [AppError | null, ChatMessageRecord | null];
  getChatMessages: (chatId: number, since?: number) => [AppError | null, ChatMessageRecord[] | null];

  // User memories (long-term knowledge per user - strictly isolated)
  getUserMemories: (userId: number) => UserMemoryRecord[];
  addUserMemory: (record: Omit<UserMemoryRecord, 'id' | 'createdAt' | 'lastAccessedAt' | 'accessCount'>) => UserMemoryRecord;
  updateUserMemory: (id: number, updates: Partial<UserMemoryRecord>) => void;
  deleteUserMemory: (id: number) => void;
  markMemoryAccessed: (id: number) => void;
  clearUserMemories: (userId: number) => number;

  // Cleanup & maintenance
  runCleanup: () => CleanupResult;
  getStats: () => DatabaseStats;

  // Utilities
  now: () => number;
  flush: () => Promise<AppError | null>;
  shutdown: () => Promise<void>;
}

/**
 * Result of a cleanup operation
 */
export interface CleanupResult {
  conversationsRemoved: number;
  linksRemoved: number;
  incidentsRemoved: number;
  leaderboardEntriesRemoved: number;
  rateLimitsRemoved: number;
  chatMessagesRemoved: number;
  memoriesRemoved: number;
}

/**
 * Database statistics
 */
export interface DatabaseStats {
  conversations: number;
  links: number;
  incidents: number;
  leaderboardEntries: number;
  rateLimits: number;
  chatMessages: number;
  userMemories: number;
  lastCleanup: number | null;
  lastSaved: number;
}

/**
 * Gets the current month in YYYY-MM format
 */
function formatMonth(date: Date): string {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Creates a database error
 */
function createDbError(code: string, message: string, details?: string): AppError {
  return {
    code,
    category: 'CONFIGURATION',
    message,
    details,
  };
}

/**
 * Creates the centralized database.
 * 
 * Factory function pattern - returns a closure of methods.
 * 
 * @param config - Database configuration
 * @returns Result tuple with [error, database]
 */
export function createDatabase(
  config: DatabaseConfig
): [AppError | null, Database | null] {
  const {
    dataDir,
    persistIntervalMs,
    linkExpiryMs,
    conversationMaxMessages = 10,
    leaderboardRetentionDays = 30,
    cleanupIntervalMs = 24 * 60 * 60 * 1000, // 24 hours
    chatBufferMaxAgeMs = 24 * 60 * 60 * 1000, // 24 hours — matches MAX_HOURS in summary handler
    maxMemoriesPerUser = 50,
    memoryDecayDays = 30,
  } = config;

  const filePath = path.join(dataDir, 'database.json');

  // In-memory state
  let schema: DatabaseSchema = createEmptySchema();
  let initialized = false;
  let dirty = false;  // Track if we need to persist
  let persistTimer: NodeJS.Timeout | null = null;
  let cleanupTimer: NodeJS.Timeout | null = null;
  let locked = false;
  let initPromise: Promise<void> | null = null;
  let lastCleanup: number | null = null;

  // Indexes for fast lookups (built from schema)
  const indexes: IndexManager = createIndexManager();

  /**
   * Acquires lock for write operations
   */
  async function acquireLock(): Promise<void> {
    while (locked) {
      await new Promise(resolve => setImmediate(resolve));
    }
    locked = true;
  }

  /**
   * Releases the lock
   */
  function releaseLock(): void {
    locked = false;
  }

  /**
   * Initializes the database, loading from disk if available
   */
  async function init(): Promise<AppError | null> {
    if (initialized) return null;
    if (initPromise) {
      await initPromise;
      return null;
    }

    initPromise = (async () => {
      // Ensure data directory exists
      await fs.mkdir(dataDir, { recursive: true }).catch((e: Error) => {
        auditLog.record(DB_ERROR_CODES.INIT_FAILED, { error: e.message, dataDir });
      });

      // Try to load existing data
      const loadResult = await fs.readFile(filePath, 'utf-8')
        .then((data): [null, string] => [null, data])
        .catch((): [null, null] => [null, null]);

      if (loadResult[1]) {
        const parseResult = await Promise.resolve()
          .then(() => JSON.parse(loadResult[1]!) as DatabaseSchema)
          .catch(() => null);

        if (parseResult && parseResult.meta) {
          schema = parseResult;

          // Forward-migration: seed any fields that did not exist at v1.
          applyMigrations(schema);

          auditLog.trace(`Database loaded: ${schema.conversations.length} conversations, ${schema.links.length} links, ${schema.userMemories?.length || 0} memories`);
        } else {
          auditLog.trace('Database file invalid, starting fresh');
          schema = createEmptySchema();
        }
      } else {
        auditLog.trace('No database file found, starting fresh');
        schema = createEmptySchema();
      }

      rebuildAllIndexes(indexes, schema);
      initialized = true;

      // Start periodic persist timer
      persistTimer = setInterval(() => {
        if (dirty) {
          flush().catch(() => { });
        }
      }, persistIntervalMs);
      persistTimer.unref();

      // Start periodic cleanup timer (daily by default)
      cleanupTimer = setInterval(() => {
        runCleanup();
      }, cleanupIntervalMs);
      cleanupTimer.unref();

      // Run initial cleanup on startup
      runCleanup();

    })();

    await initPromise;
    return null;
  }

  /**
   * Marks data as dirty (needs persist)
   */
  function markDirty(): void {
    dirty = true;
  }

  /**
   * Persists current state to disk using an atomic write pattern:
   *   1. Serialise into a temporary file next to the real one.
   *   2. `rename` it over the real file.
   *
   * `rename` within the same filesystem is atomic on every major OS, so a
   * crash between step 1 and step 2 leaves the previous valid file intact.
   */
  async function flush(): Promise<AppError | null> {
    if (!initialized || !dirty) return null;

    await acquireLock();

    // Rebuild schema arrays from indexes before saving
    rebuildFromIndexes(indexes, schema);
    // todos lives directly on schema (no separate index) — already up to date.
    schema.meta.lastSaved = Date.now();

    const tmpPath = filePath + '.tmp';

    const result = await fs.writeFile(tmpPath, JSON.stringify(schema, null, 2), 'utf-8')
      .then(() => fs.rename(tmpPath, filePath))   // atomic swap
      .then(() => {
        dirty = false;
        return null;
      })
      .catch((e: Error) => {
        // Best-effort cleanup of the tmp file so it does not linger.
        fs.unlink(tmpPath).catch(() => { });

        const error = createDbError(
          DB_ERROR_CODES.PERSIST_FAILED,
          'Failed to persist database',
          e.message
        );
        auditLog.record(error.code, { error: e.message });
        return error;
      });

    releaseLock();
    return result;
  }

  /**
   * Returns current timestamp
   */
  function now(): number {
    return Date.now();
  }

  // =========================================================================
  // Conversations
  // =========================================================================

  /**
   * Returns conversation records for a user, optionally scoped to a single
   * chat and/or capped to the most recent `limit` entries.
   *
   * @param userId - Telegram user ID.
   * @param chatId  - If provided, restrict to this chat.
   * @param limit   - If provided, return only the last N records.
   * @returns Matching records sorted by createdAt ascending.
   */
  function getConversations(
    userId: number,
    chatId?: number,
    limit?: number
  ): ConversationRecord[] {
    if (!initialized) return [];

    if (chatId !== undefined) {
      const key = `${userId}:${chatId}`;
      const records = indexes.conversations.get(key) || [];
      return limit ? records.slice(-limit) : records;
    }

    // Aggregate across all chats for this user.
    const allRecords: ConversationRecord[] = [];
    for (const [key, records] of indexes.conversations.entries()) {
      if (key.startsWith(`${userId}:`)) {
        allRecords.push(...records);
      }
    }
    allRecords.sort((a, b) => a.createdAt - b.createdAt);
    return limit ? allRecords.slice(-limit) : allRecords;
  }

  /**
   * Appends a new conversation record and marks the database dirty.
   *
   * @param record - All fields except the auto-generated `id` and `createdAt`.
   * @returns The full record with id and timestamp populated.
   */
  function addConversation(
    record: Omit<ConversationRecord, 'id' | 'createdAt'>
  ): ConversationRecord {
    const fullRecord: ConversationRecord = {
      ...record,
      id: schema.meta.conversationNextId++,
      createdAt: Date.now(),
    };

    const key = `${record.userId}:${record.chatId}`;
    const existing = indexes.conversations.get(key) || [];
    existing.push(fullRecord);
    indexes.conversations.set(key, existing);

    markDirty();
    return fullRecord;
  }

  /**
   * Removes all conversation records for a user, optionally scoped to one chat.
   *
   * @param userId - Telegram user ID.
   * @param chatId  - If provided, only clear this chat's history.
   * @returns Number of records that were removed.
   */
  function clearConversations(userId: number, chatId?: number): number {
    let count = 0;

    if (chatId !== undefined) {
      const key = `${userId}:${chatId}`;
      const records = indexes.conversations.get(key);
      if (records) {
        count = records.length;
        indexes.conversations.delete(key);
      }
    } else {
      const keysToDelete: string[] = [];
      for (const [key, records] of indexes.conversations.entries()) {
        if (key.startsWith(`${userId}:`)) {
          count += records.length;
          keysToDelete.push(key);
        }
      }
      for (const key of keysToDelete) {
        indexes.conversations.delete(key);
      }
    }

    if (count > 0) markDirty();
    return count;
  }

  // =========================================================================
  // Links (Duylhou feature)
  // =========================================================================

  /**
   * Looks up a non-expired link by its normalised URL within a chat.
   * Lazily evicts the record from the index when it has expired.
   *
   * @param normalizedUrl - The canonical form produced by {@link normalizeUrl}.
   * @param chatId         - Telegram chat ID.
   * @returns The matching record, or `null` when absent or expired.
   */
  function findLink(normalizedUrl: string, chatId: number): LinkRecord | null {
    if (!initialized) return null;

    const key = `${normalizedUrl}:${chatId}`;
    const record = indexes.links.get(key);

    if (record && record.expiresAt > Date.now()) {
      return record;
    }

    // Expired — evict lazily.
    if (record) {
      indexes.links.delete(key);
      markDirty();
    }

    return null;
  }

  /**
   * Registers a new link in the index.  The expiry timestamp is set
   * automatically from the configured {@link linkExpiryMs}.
   *
   * @param record - All fields except auto-generated `id`, `createdAt`, `expiresAt`.
   * @returns The fully-populated record.
   */
  function addLink(
    record: Omit<LinkRecord, 'id' | 'createdAt' | 'expiresAt'>
  ): LinkRecord {
    const now = Date.now();
    const fullRecord: LinkRecord = {
      ...record,
      id: schema.meta.linkNextId++,
      createdAt: now,
      expiresAt: now + linkExpiryMs,
    };

    indexes.links.set(`${record.normalizedUrl}:${record.chatId}`, fullRecord);

    markDirty();
    return fullRecord;
  }

  /**
   * Iterates the link index and removes every entry whose `expiresAt`
   * timestamp is in the past.
   *
   * @returns Number of links evicted.
   */
  function cleanupExpiredLinks(): number {
    const now = Date.now();
    let count = 0;

    for (const [key, record] of indexes.links.entries()) {
      if (record.expiresAt <= now) {
        indexes.links.delete(key);
        count++;
      }
    }

    if (count > 0) {
      markDirty();
      auditLog.trace(`Cleaned up ${count} expired links`);
    }

    return count;
  }

  // =========================================================================
  // Duylhou Incidents & Leaderboard
  // =========================================================================

  /**
   * Gets the current month in YYYY-MM format
   */
  function getCurrentMonth(): string {
    return formatMonth(new Date());
  }

  /**
   * Records a Duylhou incident and updates the leaderboard.
   * The incident is stored in {@link duylhouIncidentIndex} so that
   * flush() can reliably rebuild `schema.duylhouIncidents` from the
   * index, matching the pattern used by every other collection.
   */
  function recordDuylhouIncident(
    offenderId: number,
    originalUserId: number,
    chatId: number,
    normalizedUrl: string
  ): DuylhouIncident {
    const now = Date.now();
    const month = getCurrentMonth();

    const incident: DuylhouIncident = {
      id: schema.meta.duylhouIncidentNextId++,
      offenderId,
      originalUserId,
      chatId,
      normalizedUrl,
      createdAt: now,
      month,
    };

    // Write to index (source of truth for flush)
    indexes.duylhouIncidents.set(incident.id, incident);

    // Update leaderboard
    const leaderboardKey = `${offenderId}:${month}`;
    let entry = indexes.duylhouLeaderboard.get(leaderboardKey);

    if (entry) {
      entry.count++;
      entry.lastIncidentAt = now;
    } else {
      entry = {
        userId: offenderId,
        month,
        count: 1,
        lastIncidentAt: now,
      };
      indexes.duylhouLeaderboard.set(leaderboardKey, entry);
    }

    markDirty();
    auditLog.trace(`Duylhou incident recorded: user ${offenderId} now has ${entry.count} incidents in ${month}`);

    return incident;
  }

  /**
   * Assigns dense ranks to a sorted array of leaderboard entries.
   * Entries with the same `count` receive the same rank; the next
   * distinct count gets the next sequential integer.
   *
   * @param entries - Pre-sorted descending by count (ties broken by lastIncidentAt asc).
   * @param limit   - Maximum number of rankings to return.
   * @returns Array with rank populated.
   */
  function assignRanks(entries: DuylhouLeaderboardEntry[], limit: number): LeaderboardRanking[] {
    const rankings: LeaderboardRanking[] = [];
    let rank = 1;
    let prevCount = -1;

    for (let i = 0; i < Math.min(entries.length, limit); i++) {
      const entry = entries[i];
      if (entry.count !== prevCount) {
        rank = i + 1;
        prevCount = entry.count;
      }
      rankings.push({
        userId: entry.userId,
        count: entry.count,
        rank,
        lastIncidentAt: entry.lastIncidentAt,
      });
    }
    return rankings;
  }

  /**
   * Gets the leaderboard for a given month (defaults to current month).
   * Entries are sorted by incident count descending; ties are broken by
   * earliest last-incident timestamp (earlier = higher rank).
   *
   * @param month - Target month in YYYY-MM format, or undefined for current.
   * @param limit - Maximum entries to return (default 10).
   * @returns Ranked leaderboard slice.
   */
  function getDuylhouLeaderboard(month?: string, limit: number = 10): LeaderboardRanking[] {
    const targetMonth = month || getCurrentMonth();

    const entries: DuylhouLeaderboardEntry[] = [];
    for (const entry of indexes.duylhouLeaderboard.values()) {
      if (entry.month === targetMonth) {
        entries.push(entry);
      }
    }

    entries.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.lastIncidentAt - b.lastIncidentAt;
    });

    return assignRanks(entries, limit);
  }

  /**
   * Cleans up old incidents (keeps only specified months).
   * Operates on {@link duylhouIncidentIndex} — the single source of truth.
   */
  function cleanupOldIncidents(monthsToKeep: number = 2): number {
    const now = new Date();
    const cutoffDate = new Date(now.getFullYear(), now.getMonth() - monthsToKeep, 1);
    const cutoffMonth = formatMonth(cutoffDate);

    // Remove old incidents from the index
    let incidentsRemoved = 0;
    for (const [id, incident] of indexes.duylhouIncidents.entries()) {
      if (incident.month < cutoffMonth) {
        indexes.duylhouIncidents.delete(id);
        incidentsRemoved++;
      }
    }

    // Remove old leaderboard entries
    let leaderboardRemoved = 0;
    for (const [key, entry] of indexes.duylhouLeaderboard.entries()) {
      if (entry.month < cutoffMonth) {
        indexes.duylhouLeaderboard.delete(key);
        leaderboardRemoved++;
      }
    }

    if (incidentsRemoved > 0 || leaderboardRemoved > 0) {
      markDirty();
      auditLog.trace(`Cleaned up ${incidentsRemoved} old incidents and ${leaderboardRemoved} leaderboard entries`);
    }

    return incidentsRemoved;
  }

  // =========================================================================
  // Rate Limits
  // =========================================================================

  function getRateLimitTimestamps(userId: number): number[] {
    const record = indexes.rateLimits.get(userId);
    return record?.timestamps || [];
  }

  function setRateLimitTimestamps(userId: number, timestamps: number[]): void {
    if (timestamps.length === 0) {
      indexes.rateLimits.delete(userId);
    } else {
      indexes.rateLimits.set(userId, { userId, timestamps });
    }
    markDirty();
  }

  function cleanupRateLimits(windowMs: number): number {
    const now = Date.now();
    const cutoff = now - windowMs;
    let count = 0;

    for (const [userId, record] of indexes.rateLimits.entries()) {
      const validTimestamps = record.timestamps.filter(ts => ts > cutoff);
      if (validTimestamps.length === 0) {
        indexes.rateLimits.delete(userId);
        count++;
      } else if (validTimestamps.length !== record.timestamps.length) {
        record.timestamps = validTimestamps;
      }
    }

    if (count > 0) markDirty();
    return count;
  }

  // =========================================================================
  // Todos
  // =========================================================================

  /**
   * Appends a new todo item to the persisted list.
   *
   * @param record - Text and the admin's display name.
   * @returns The full record including the auto-assigned id and timestamp.
   */
  function addTodo(record: { text: string; user: string }): TodoRecord {
    const todo: TodoRecord = {
      id: schema.meta.todoNextId++,
      text: record.text,
      user: record.user,
      createdAt: new Date().toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      }),
    };

    schema.todos.push(todo);
    markDirty();
    auditLog.trace(`Todo #${todo.id} added by ${todo.user}`);
    return todo;
  }

  /**
   * Returns all persisted todo items in insertion order (oldest first).
   */
  function getTodos(): TodoRecord[] {
    return [...schema.todos];
  }

  // =========================================================================
  // Summaries
  // =========================================================================

  /**
   * Persists a new summary for a chat.  The index keeps only the latest
   * summary per chatId so `getLatestSummary` is O(1), but the full
   * `schema.summaries` array (rebuilt at flush time from the index) retains
   * the history for the configured retention window.
   *
   * @param record - The summary payload (chatId, rangeLabel, messageCount, summary text).
   * @returns The full persisted record with its auto-assigned id and timestamp.
   */
  function addSummary(record: { chatId: number; rangeLabel: string; messageCount: number; summary: string }): SummaryRecord {
    const full: SummaryRecord = {
      id: schema.meta.summaryNextId++,
      chatId: record.chatId,
      rangeLabel: record.rangeLabel,
      messageCount: record.messageCount,
      summary: record.summary,
      createdAt: Date.now(),
    };

    indexes.summaries.set(full.chatId, full);
    markDirty();
    auditLog.trace(`Summary #${full.id} persisted for chat ${full.chatId}`);
    return full;
  }

  /**
   * Returns the most-recent persisted summary for the given chat, or
   * `null` when none exists.
   *
   * @param chatId - The Telegram chat ID to look up.
   */
  function getLatestSummary(chatId: number): SummaryRecord | null {
    return indexes.summaries.get(chatId) ?? null;
  }

  // =========================================================================
  // Chat Message Buffer (persistent backing store for /summary)
  // =========================================================================

  /**
   * Appends a raw group-chat message to the per-chat buffer and trims the
   * list to {@link conversationMaxMessages}, removing the oldest entries.
   * Marks the database dirty so the next flush cycle writes it to disk.
   *
   * Returns a Result tuple so callers can handle the "not yet initialised"
   * edge-case gracefully without throwing.
   *
   * @param record - All fields except the auto-generated `id` and `createdAt`.
   * @returns `[null, record]` on success, `[AppError, null]` when the DB is
   *          not yet ready.
   */
  function addChatMessage(
    record: Omit<ChatMessageRecord, 'id' | 'createdAt'>,
  ): [AppError | null, ChatMessageRecord | null] {
    if (!initialized) {
      return [
        createDbError(DB_ERROR_CODES.QUERY_FAILED, 'Database not yet initialized'),
        null,
      ];
    }

    const fullRecord: ChatMessageRecord = {
      ...record,
      id: schema.meta.chatMessageNextId++,
      createdAt: Date.now(),
    };

    const existing = indexes.chatMessages.get(record.chatId) || [];
    existing.push(fullRecord);
    indexes.chatMessages.set(record.chatId, existing);

    // Enforce cap — remove oldest entries that exceed the limit.
    if (existing.length > conversationMaxMessages) {
      existing.splice(0, existing.length - conversationMaxMessages);
    }

    markDirty();
    return [null, fullRecord];
  }

  /**
   * Returns all buffered messages for a chat, optionally filtered to those
   * received at or after `since` (Unix ms timestamp).  The result is always
   * sorted oldest-first.
   *
   * @param chatId - The Telegram chat ID to query.
   * @param since  - Optional lower-bound timestamp (inclusive).
   * @returns `[null, records]` on success, `[AppError, null]` when not ready.
   */
  function getChatMessages(
    chatId: number,
    since?: number,
  ): [AppError | null, ChatMessageRecord[] | null] {
    if (!initialized) {
      return [
        createDbError(DB_ERROR_CODES.QUERY_FAILED, 'Database not yet initialized'),
        null,
      ];
    }

    const all = indexes.chatMessages.get(chatId) || [];
    const filtered =
      since !== undefined ? all.filter((m) => m.createdAt >= since) : [...all];

    return [null, filtered];
  }

  // =========================================================================
  // User Memories (long-term knowledge per user - strictly isolated)
  // =========================================================================

  /**
   * Returns all memories for a specific user.
   * ISOLATION: Only returns memories where userId matches exactly.
   *
   * @param userId - Telegram user ID (isolation key).
   * @returns Array of memories for this user only.
   */
  function getUserMemories(userId: number): UserMemoryRecord[] {
    if (!initialized) return [];
    return indexes.userMemories.get(userId) || [];
  }

  /**
   * Adds a new memory for a user.
   * ISOLATION: Memory is tagged with userId and can only be retrieved
   * by that same userId.
   *
   * @param record - All fields except auto-generated ones.
   * @returns The fully-populated record.
   */
  function addUserMemory(
    record: Omit<UserMemoryRecord, 'id' | 'createdAt' | 'lastAccessedAt' | 'accessCount'>,
  ): UserMemoryRecord {
    const now = Date.now();
    const fullRecord: UserMemoryRecord = {
      ...record,
      id: schema.meta.userMemoryNextId++,
      createdAt: now,
      lastAccessedAt: now,
      accessCount: 0,
    };

    const existing = indexes.userMemories.get(record.userId) || [];
    existing.push(fullRecord);
    indexes.userMemories.set(record.userId, existing);

    markDirty();
    auditLog.trace(`Memory #${fullRecord.id} added for user ${record.userId}: ${record.type}`);
    return fullRecord;
  }

  /**
   * Updates an existing memory by ID.
   * ISOLATION: Only updates if the memory exists; does not cross users.
   *
   * @param id      - Memory ID to update.
   * @param updates - Partial updates to apply.
   */
  function updateUserMemory(id: number, updates: Partial<UserMemoryRecord>): void {
    // Find the memory across all users (we have the ID)
    for (const [, memories] of indexes.userMemories.entries()) {
      const index = memories.findIndex((m) => m.id === id);
      if (index !== -1) {
        // Apply updates (but never change userId - that's the isolation key)
        const { userId: _, ...safeUpdates } = updates;
        Object.assign(memories[index], safeUpdates);
        markDirty();
        return;
      }
    }
  }

  /**
   * Deletes a memory by ID.
   *
   * @param id - Memory ID to delete.
   */
  function deleteUserMemory(id: number): void {
    for (const [userId, memories] of indexes.userMemories.entries()) {
      const index = memories.findIndex((m) => m.id === id);
      if (index !== -1) {
        memories.splice(index, 1);
        if (memories.length === 0) {
          indexes.userMemories.delete(userId);
        }
        markDirty();
        return;
      }
    }
  }

  /**
   * Marks a memory as accessed (updates lastAccessedAt and accessCount).
   *
   * @param id - Memory ID to mark.
   */
  function markMemoryAccessed(id: number): void {
    for (const memories of indexes.userMemories.values()) {
      const memory = memories.find((m) => m.id === id);
      if (memory) {
        memory.lastAccessedAt = Date.now();
        memory.accessCount++;
        markDirty();
        return;
      }
    }
  }

  /**
   * Clears all memories for a specific user.
   * ISOLATION: Only affects the specified user.
   *
   * @param userId - Telegram user ID.
   * @returns Number of memories deleted.
   */
  function clearUserMemories(userId: number): number {
    const memories = indexes.userMemories.get(userId);
    if (!memories) return 0;

    const count = memories.length;
    indexes.userMemories.delete(userId);
    markDirty();
    auditLog.trace(`Cleared ${count} memories for user ${userId}`);
    return count;
  }

  // =========================================================================
  // Cleanup & Maintenance
  // =========================================================================

  /**
   * Trims each per-user/chat conversation list down to
   * {@link conversationMaxMessages}, removing the oldest entries first.
   *
   * @returns Total number of records removed across all keys.
   */
  function cleanupConversations(): number {
    let removed = 0;
    for (const [, records] of indexes.conversations.entries()) {
      if (records.length > conversationMaxMessages) {
        const toRemove = records.length - conversationMaxMessages;
        records.splice(0, toRemove);
        removed += toRemove;
      }
    }
    return removed;
  }

  /**
   * Removes buffered chat messages older than {@link chatBufferMaxAgeMs} and
   * then re-enforces the per-chat {@link conversationMaxMessages} cap.
   * Both conditions are checked so that a chat which suddenly goes quiet
   * still has its old entries evicted on the next cleanup cycle.
   *
   * @returns Total number of records removed.
   */
  function cleanupChatMessages(): number {
    const cutoff = Date.now() - chatBufferMaxAgeMs;
    let removed = 0;

    for (const [chatId, records] of indexes.chatMessages.entries()) {
      // 1. Evict time-expired messages.
      const afterExpiry = records.filter((m) => m.createdAt > cutoff);
      removed += records.length - afterExpiry.length;

      // 2. Enforce the per-chat cap on whatever is left.
      const capped =
        afterExpiry.length > conversationMaxMessages
          ? afterExpiry.slice(afterExpiry.length - conversationMaxMessages)
          : afterExpiry;
      removed += afterExpiry.length - capped.length;

      if (capped.length === 0) {
        indexes.chatMessages.delete(chatId);
      } else {
        indexes.chatMessages.set(chatId, capped);
      }
    }

    return removed;
  }

  /**
   * Removes Duylhou incidents and leaderboard entries whose month
   * predates the retention window derived from
   * {@link leaderboardRetentionDays}.
   *
   * @param cutoffMonth - YYYY-MM string; anything strictly below this is evicted.
   * @returns Object with counts of incidents and leaderboard entries removed.
   */
  function cleanupIncidentsAndLeaderboard(cutoffMonth: string): { incidents: number; leaderboard: number } {
    let incidents = 0;
    for (const [id, incident] of indexes.duylhouIncidents.entries()) {
      if (incident.month < cutoffMonth) {
        indexes.duylhouIncidents.delete(id);
        incidents++;
      }
    }

    let leaderboard = 0;
    for (const [key, entry] of indexes.duylhouLeaderboard.entries()) {
      if (entry.month < cutoffMonth) {
        indexes.duylhouLeaderboard.delete(key);
        leaderboard++;
      }
    }

    return { incidents, leaderboard };
  }

  /**
   * Removes rate-limit entries that have zero remaining timestamps
   * (i.e. the user's window has fully expired).
   *
   * @returns Number of user entries removed.
   */
  function cleanupEmptyRateLimits(): number {
    let count = 0;
    for (const [userId, record] of indexes.rateLimits.entries()) {
      if (record.timestamps.length === 0) {
        indexes.rateLimits.delete(userId);
        count++;
      }
    }
    return count;
  }

  /**
   * Cleans up old, unused user memories.
   * Evicts memories that haven't been accessed in memoryDecayDays
   * and enforces the per-user limit.
   *
   * @returns Number of memories removed.
   */
  function cleanupUserMemories(): number {
    const cutoff = Date.now() - memoryDecayDays * 24 * 60 * 60 * 1000;
    let removed = 0;

    for (const [userId, memories] of indexes.userMemories.entries()) {
      // Remove memories not accessed since cutoff
      const active = memories.filter((m) => m.lastAccessedAt > cutoff);
      removed += memories.length - active.length;

      // Enforce per-user limit (keep most recently accessed)
      if (active.length > maxMemoriesPerUser) {
        active.sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);
        const toKeep = active.slice(0, maxMemoriesPerUser);
        removed += active.length - toKeep.length;
        indexes.userMemories.set(userId, toKeep);
      } else if (active.length === 0) {
        indexes.userMemories.delete(userId);
      } else {
        indexes.userMemories.set(userId, active);
      }
    }

    return removed;
  }

  /**
   * Runs comprehensive cleanup of all database collections.
   * Called periodically (daily by default) and on startup.
   *
   * @returns Aggregated counts of every item that was removed.
   */
  function runCleanup(): CleanupResult {
    auditLog.trace('Starting database cleanup...');

    const result: CleanupResult = {
      conversationsRemoved: cleanupConversations(),
      linksRemoved: cleanupExpiredLinks(),
      incidentsRemoved: 0,
      leaderboardEntriesRemoved: 0,
      rateLimitsRemoved: cleanupEmptyRateLimits(),
      chatMessagesRemoved: cleanupChatMessages(),
      memoriesRemoved: cleanupUserMemories(),
    };

    // Leaderboard / incidents cutoff derived from retention config.
    const cutoffDate = new Date(Date.now());
    cutoffDate.setDate(cutoffDate.getDate() - leaderboardRetentionDays);
    const { incidents, leaderboard } = cleanupIncidentsAndLeaderboard(formatMonth(cutoffDate));
    result.incidentsRemoved = incidents;
    result.leaderboardEntriesRemoved = leaderboard;

    const totalRemoved =
      result.conversationsRemoved +
      result.linksRemoved +
      result.incidentsRemoved +
      result.leaderboardEntriesRemoved +
      result.rateLimitsRemoved +
      result.memoriesRemoved;

    if (totalRemoved > 0) markDirty();

    lastCleanup = Date.now();

    auditLog.trace(
      `Cleanup complete: ${result.conversationsRemoved} conversations, ` +
      `${result.linksRemoved} links, ${result.incidentsRemoved} incidents, ` +
      `${result.leaderboardEntriesRemoved} leaderboard entries, ` +
      `${result.rateLimitsRemoved} rate limits, ` +
      `${result.chatMessagesRemoved} chat messages, ` +
      `${result.memoriesRemoved} memories removed`
    );

    return result;
  }

  /**
   * Returns a snapshot of current collection sizes and housekeeping timestamps.
   */
  function getStats(): DatabaseStats {
    let conversationCount = 0;
    for (const records of indexes.conversations.values()) {
      conversationCount += records.length;
    }

    let chatMessageCount = 0;
    for (const records of indexes.chatMessages.values()) {
      chatMessageCount += records.length;
    }

    let memoryCount = 0;
    for (const records of indexes.userMemories.values()) {
      memoryCount += records.length;
    }

    return {
      conversations: conversationCount,
      links: indexes.links.size,
      incidents: indexes.duylhouIncidents.size,
      leaderboardEntries: indexes.duylhouLeaderboard.size,
      rateLimits: indexes.rateLimits.size,
      chatMessages: chatMessageCount,
      userMemories: memoryCount,
      lastCleanup,
      lastSaved: schema.meta.lastSaved,
    };
  }

  // =========================================================================
  // Shutdown
  // =========================================================================

  async function shutdown(): Promise<void> {
    if (persistTimer) {
      clearInterval(persistTimer);
      persistTimer = null;
    }
    if (cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
    await flush();
    auditLog.trace('Database shutdown complete');
  }

  // Initialize on creation
  init().catch((e) => {
    auditLog.record(DB_ERROR_CODES.INIT_FAILED, { error: String(e) });
  });

  const database: Database = {
    getConversations,
    addConversation,
    clearConversations,
    findLink,
    addLink,
    cleanupExpiredLinks,
    recordDuylhouIncident,
    getDuylhouLeaderboard,
    getCurrentMonth,
    cleanupOldIncidents,
    getRateLimitTimestamps,
    setRateLimitTimestamps,
    cleanupRateLimits,
    addTodo,
    getTodos,
    addSummary,
    getLatestSummary,
    addChatMessage,
    getChatMessages,
    getUserMemories,
    addUserMemory,
    updateUserMemory,
    deleteUserMemory,
    markMemoryAccessed,
    clearUserMemories,
    runCleanup,
    getStats,
    now,
    flush,
    shutdown,
  };

  return [null, database];
}
