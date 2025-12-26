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
import { AppError, Result } from '../assistant/types';
import { auditLog } from '../assistant/audit-log';
import {
  DatabaseSchema,
  DatabaseConfig,
  ConversationRecord,
  LinkRecord,
  RateLimitRecord,
  GameSessionRecord,
  DuylhouIncident,
  DuylhouLeaderboardEntry,
  DB_ERROR_CODES,
} from './types';

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
  
  // Game sessions
  getGameSession: (userId: number) => GameSessionRecord | null;
  saveGameSession: (session: GameSessionRecord) => void;
  deleteGameSession: (userId: number) => void;
  
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
  sessionsRemoved: number;
  rateLimitsRemoved: number;
}

/**
 * Database statistics
 */
export interface DatabaseStats {
  conversations: number;
  links: number;
  incidents: number;
  leaderboardEntries: number;
  gameSessions: number;
  rateLimits: number;
  lastCleanup: number | null;
  lastSaved: number;
}

/**
 * Default empty database schema
 */
function createEmptySchema(): DatabaseSchema {
  return {
    conversations: [],
    links: [],
    rateLimits: [],
    gameSessions: [],
    duylhouIncidents: [],
    duylhouLeaderboard: [],
    meta: {
      version: 1,
      lastSaved: Date.now(),
      conversationNextId: 1,
      linkNextId: 1,
      duylhouIncidentNextId: 1,
    },
  };
}

/**
 * Calculates days between two timestamps
 */
function daysBetween(ts1: number, ts2: number): number {
  return Math.abs(ts2 - ts1) / (24 * 60 * 60 * 1000);
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
    sessionMaxAgeDays = 90,
    cleanupIntervalMs = 24 * 60 * 60 * 1000, // 24 hours
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
  let conversationIndex = new Map<string, ConversationRecord[]>();  // "userId:chatId" -> records
  let linkIndex = new Map<string, LinkRecord>();  // "normalizedUrl:chatId" -> record
  let rateLimitIndex = new Map<number, RateLimitRecord>();  // userId -> record
  let gameSessionIndex = new Map<number, GameSessionRecord>();  // userId -> session
  let duylhouLeaderboardIndex = new Map<string, DuylhouLeaderboardEntry>();  // "userId:month" -> entry

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
   * Rebuilds all indexes from schema data
   */
  function rebuildIndexes(): void {
    // Conversations index
    conversationIndex = new Map();
    for (const record of schema.conversations) {
      const key = `${record.userId}:${record.chatId}`;
      const existing = conversationIndex.get(key) || [];
      existing.push(record);
      conversationIndex.set(key, existing);
    }
    // Sort each conversation list by createdAt
    for (const records of conversationIndex.values()) {
      records.sort((a, b) => a.createdAt - b.createdAt);
    }

    // Links index
    linkIndex = new Map();
    const now = Date.now();
    for (const record of schema.links) {
      if (record.expiresAt > now) {
        const key = `${record.normalizedUrl}:${record.chatId}`;
        linkIndex.set(key, record);
      }
    }

    // Rate limits index
    rateLimitIndex = new Map();
    for (const record of schema.rateLimits) {
      rateLimitIndex.set(record.userId, record);
    }

    // Game sessions index
    gameSessionIndex = new Map();
    for (const session of schema.gameSessions) {
      gameSessionIndex.set(session.userId, session);
    }

    // Duylhou leaderboard index
    duylhouLeaderboardIndex = new Map();
    for (const entry of schema.duylhouLeaderboard) {
      const key = `${entry.userId}:${entry.month}`;
      duylhouLeaderboardIndex.set(key, entry);
    }
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
          auditLog.trace(`Database loaded: ${schema.conversations.length} conversations, ${schema.links.length} links, ${schema.gameSessions.length} game sessions`);
        } else {
          auditLog.trace('Database file invalid, starting fresh');
          schema = createEmptySchema();
        }
      } else {
        auditLog.trace('No database file found, starting fresh');
        schema = createEmptySchema();
      }

      rebuildIndexes();
      initialized = true;

      // Start periodic persist timer
      persistTimer = setInterval(() => {
        if (dirty) {
          flush().catch(() => {});
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
   * Persists current state to disk
   */
  async function flush(): Promise<AppError | null> {
    if (!initialized || !dirty) return null;

    await acquireLock();

    // Rebuild schema arrays from indexes before saving
    schema.conversations = [];
    for (const records of conversationIndex.values()) {
      schema.conversations.push(...records);
    }

    schema.links = Array.from(linkIndex.values());
    schema.rateLimits = Array.from(rateLimitIndex.values());
    schema.gameSessions = Array.from(gameSessionIndex.values());
    schema.duylhouLeaderboard = Array.from(duylhouLeaderboardIndex.values());
    schema.meta.lastSaved = Date.now();

    const result = await fs.writeFile(filePath, JSON.stringify(schema, null, 2), 'utf-8')
      .then(() => {
        dirty = false;
        return null;
      })
      .catch((e: Error) => {
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

  function getConversations(
    userId: number,
    chatId?: number,
    limit?: number
  ): ConversationRecord[] {
    if (!initialized) return [];

    if (chatId !== undefined) {
      const key = `${userId}:${chatId}`;
      const records = conversationIndex.get(key) || [];
      return limit ? records.slice(-limit) : records;
    }

    // Get all conversations for user across all chats
    const allRecords: ConversationRecord[] = [];
    for (const [key, records] of conversationIndex.entries()) {
      if (key.startsWith(`${userId}:`)) {
        allRecords.push(...records);
      }
    }
    allRecords.sort((a, b) => a.createdAt - b.createdAt);
    return limit ? allRecords.slice(-limit) : allRecords;
  }

  function addConversation(
    record: Omit<ConversationRecord, 'id' | 'createdAt'>
  ): ConversationRecord {
    const fullRecord: ConversationRecord = {
      ...record,
      id: schema.meta.conversationNextId++,
      createdAt: Date.now(),
    };

    const key = `${record.userId}:${record.chatId}`;
    const existing = conversationIndex.get(key) || [];
    existing.push(fullRecord);
    conversationIndex.set(key, existing);

    markDirty();
    return fullRecord;
  }

  function clearConversations(userId: number, chatId?: number): number {
    let count = 0;

    if (chatId !== undefined) {
      const key = `${userId}:${chatId}`;
      const records = conversationIndex.get(key);
      if (records) {
        count = records.length;
        conversationIndex.delete(key);
      }
    } else {
      const keysToDelete: string[] = [];
      for (const [key, records] of conversationIndex.entries()) {
        if (key.startsWith(`${userId}:`)) {
          count += records.length;
          keysToDelete.push(key);
        }
      }
      for (const key of keysToDelete) {
        conversationIndex.delete(key);
      }
    }

    if (count > 0) markDirty();
    return count;
  }

  // =========================================================================
  // Links (Duylhou feature)
  // =========================================================================

  function findLink(normalizedUrl: string, chatId: number): LinkRecord | null {
    if (!initialized) return null;

    const key = `${normalizedUrl}:${chatId}`;
    const record = linkIndex.get(key);
    
    if (record && record.expiresAt > Date.now()) {
      return record;
    }
    
    // Expired, remove it
    if (record) {
      linkIndex.delete(key);
      markDirty();
    }
    
    return null;
  }

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

    const key = `${record.normalizedUrl}:${record.chatId}`;
    linkIndex.set(key, fullRecord);

    markDirty();
    return fullRecord;
  }

  function cleanupExpiredLinks(): number {
    const now = Date.now();
    let count = 0;

    for (const [key, record] of linkIndex.entries()) {
      if (record.expiresAt <= now) {
        linkIndex.delete(key);
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
   * Records a Duylhou incident and updates the leaderboard
   */
  function recordDuylhouIncident(
    offenderId: number,
    originalUserId: number,
    chatId: number,
    normalizedUrl: string
  ): DuylhouIncident {
    const now = Date.now();
    const month = getCurrentMonth();

    // Create incident record
    const incident: DuylhouIncident = {
      id: schema.meta.duylhouIncidentNextId++,
      offenderId,
      originalUserId,
      chatId,
      normalizedUrl,
      createdAt: now,
      month,
    };

    schema.duylhouIncidents.push(incident);

    // Update leaderboard
    const leaderboardKey = `${offenderId}:${month}`;
    let entry = duylhouLeaderboardIndex.get(leaderboardKey);

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
      duylhouLeaderboardIndex.set(leaderboardKey, entry);
    }

    markDirty();
    auditLog.trace(`Duylhou incident recorded: user ${offenderId} now has ${entry.count} incidents in ${month}`);
    
    return incident;
  }

  /**
   * Gets the leaderboard for a given month (or current month if not specified)
   */
  function getDuylhouLeaderboard(month?: string, limit: number = 10): LeaderboardRanking[] {
    const targetMonth = month || getCurrentMonth();
    
    // Collect all entries for the target month
    const entries: DuylhouLeaderboardEntry[] = [];
    for (const entry of duylhouLeaderboardIndex.values()) {
      if (entry.month === targetMonth) {
        entries.push(entry);
      }
    }

    // Sort by count descending, then by lastIncidentAt ascending (earlier = higher rank on tie)
    entries.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.lastIncidentAt - b.lastIncidentAt;
    });

    // Apply limit and add rank
    const rankings: LeaderboardRanking[] = [];
    let currentRank = 1;
    let previousCount = -1;
    let previousRank = 1;

    for (let i = 0; i < Math.min(entries.length, limit); i++) {
      const entry = entries[i];
      
      // Handle ties - same count gets same rank
      if (entry.count === previousCount) {
        rankings.push({
          userId: entry.userId,
          count: entry.count,
          rank: previousRank,
          lastIncidentAt: entry.lastIncidentAt,
        });
      } else {
        previousRank = currentRank;
        previousCount = entry.count;
        rankings.push({
          userId: entry.userId,
          count: entry.count,
          rank: currentRank,
          lastIncidentAt: entry.lastIncidentAt,
        });
      }
      currentRank++;
    }

    return rankings;
  }

  /**
   * Cleans up old incidents (keeps only specified months)
   */
  function cleanupOldIncidents(monthsToKeep: number = 2): number {
    const now = new Date();
    const cutoffDate = new Date(now.getFullYear(), now.getMonth() - monthsToKeep, 1);
    const cutoffMonth = formatMonth(cutoffDate);

    // Remove old incidents
    const originalLength = schema.duylhouIncidents.length;
    schema.duylhouIncidents = schema.duylhouIncidents.filter(
      incident => incident.month >= cutoffMonth
    );
    const incidentsRemoved = originalLength - schema.duylhouIncidents.length;

    // Remove old leaderboard entries
    let leaderboardRemoved = 0;
    for (const [key, entry] of duylhouLeaderboardIndex.entries()) {
      if (entry.month < cutoffMonth) {
        duylhouLeaderboardIndex.delete(key);
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
    const record = rateLimitIndex.get(userId);
    return record?.timestamps || [];
  }

  function setRateLimitTimestamps(userId: number, timestamps: number[]): void {
    if (timestamps.length === 0) {
      rateLimitIndex.delete(userId);
    } else {
      rateLimitIndex.set(userId, { userId: userId, timestamps });
    }
    markDirty();
  }

  function cleanupRateLimits(windowMs: number): number {
    const now = Date.now();
    const cutoff = now - windowMs;
    let count = 0;

    for (const [userId, record] of rateLimitIndex.entries()) {
      const validTimestamps = record.timestamps.filter(ts => ts > cutoff);
      if (validTimestamps.length === 0) {
        rateLimitIndex.delete(userId);
        count++;
      } else if (validTimestamps.length !== record.timestamps.length) {
        record.timestamps = validTimestamps;
      }
    }

    if (count > 0) markDirty();
    return count;
  }

  // =========================================================================
  // Game Sessions
  // =========================================================================

  function getGameSession(userId: number): GameSessionRecord | null {
    return gameSessionIndex.get(userId) || null;
  }

  function saveGameSession(session: GameSessionRecord): void {
    gameSessionIndex.set(session.userId, session);
    markDirty();
  }

  function deleteGameSession(userId: number): void {
    if (gameSessionIndex.delete(userId)) {
      markDirty();
    }
  }

  // =========================================================================
  // Cleanup & Maintenance
  // =========================================================================

  /**
   * Runs comprehensive cleanup of all database collections.
   * Called periodically (daily by default) and on startup.
   */
  function runCleanup(): CleanupResult {
    const now = Date.now();
    const result: CleanupResult = {
      conversationsRemoved: 0,
      linksRemoved: 0,
      incidentsRemoved: 0,
      leaderboardEntriesRemoved: 0,
      sessionsRemoved: 0,
      rateLimitsRemoved: 0,
    };

    auditLog.trace('Starting database cleanup...');

    // 1. Cleanup conversations - keep only last N messages per user/chat
    for (const [key, records] of conversationIndex.entries()) {
      if (records.length > conversationMaxMessages) {
        const toRemove = records.length - conversationMaxMessages;
        records.splice(0, toRemove);  // Remove oldest (they're sorted by createdAt)
        result.conversationsRemoved += toRemove;
      }
    }

    // 2. Cleanup expired links (24h expiry)
    result.linksRemoved = cleanupExpiredLinks();

    // 3. Cleanup old Duylhou incidents and leaderboard entries (30 days)
    const leaderboardCutoff = new Date(now);
    leaderboardCutoff.setDate(leaderboardCutoff.getDate() - leaderboardRetentionDays);
    const leaderboardCutoffMonth = formatMonth(leaderboardCutoff);

    // Remove old incidents
    const originalIncidentCount = schema.duylhouIncidents.length;
    schema.duylhouIncidents = schema.duylhouIncidents.filter(
      incident => incident.month >= leaderboardCutoffMonth
    );
    result.incidentsRemoved = originalIncidentCount - schema.duylhouIncidents.length;

    // Remove old leaderboard entries
    for (const [key, entry] of duylhouLeaderboardIndex.entries()) {
      if (entry.month < leaderboardCutoffMonth) {
        duylhouLeaderboardIndex.delete(key);
        result.leaderboardEntriesRemoved++;
      }
    }

    // 4. Cleanup stale game sessions (3 months / 90 days)
    const sessionCutoffMs = now - (sessionMaxAgeDays * 24 * 60 * 60 * 1000);
    
    // We need to check if sessions have any activity indicator
    // Since PlayerSession doesn't have a lastActivity field, we'll need to 
    // track this differently. For now, we'll add a check based on round/badges
    // being 0 (abandoned sessions) that are older than the cutoff.
    // 
    // TODO: Add lastActivity tracking to game sessions for proper cleanup
    // For now, we'll skip session cleanup as we can't determine age
    // without modifying the PlayerSession type

    // 5. Cleanup empty rate limit entries
    for (const [limitUserId, record] of rateLimitIndex.entries()) {
      if (record.timestamps.length === 0) {
        rateLimitIndex.delete(limitUserId);
        result.rateLimitsRemoved++;
      }
    }

    // Mark as dirty if anything was cleaned
    const totalRemoved = 
      result.conversationsRemoved + 
      result.linksRemoved + 
      result.incidentsRemoved + 
      result.leaderboardEntriesRemoved +
      result.sessionsRemoved +
      result.rateLimitsRemoved;

    if (totalRemoved > 0) {
      markDirty();
    }

    lastCleanup = now;

    auditLog.trace(
      `Cleanup complete: ${result.conversationsRemoved} conversations, ` +
      `${result.linksRemoved} links, ${result.incidentsRemoved} incidents, ` +
      `${result.leaderboardEntriesRemoved} leaderboard entries, ` +
      `${result.rateLimitsRemoved} rate limits removed`
    );

    return result;
  }

  /**
   * Gets current database statistics
   */
  function getStats(): DatabaseStats {
    let conversationCount = 0;
    for (const records of conversationIndex.values()) {
      conversationCount += records.length;
    }

    return {
      conversations: conversationCount,
      links: linkIndex.size,
      incidents: schema.duylhouIncidents.length,
      leaderboardEntries: duylhouLeaderboardIndex.size,
      gameSessions: gameSessionIndex.size,
      rateLimits: rateLimitIndex.size,
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
    getGameSession,
    saveGameSession,
    deleteGameSession,
    runCleanup,
    getStats,
    now,
    flush,
    shutdown,
  };

  return [null, database];
}
