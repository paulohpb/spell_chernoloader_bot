/**
 * =============================================================================
 * Rate Limiter Middleware - Limits requests per user using sliding window
 * 
 * Higher-order function that wraps command handlers with rate limiting.
 * Uses timestamp-based sliding window for accurate rate limiting.
 * Thread-safe using a lock mechanism for concurrent request handling.
 * 
 * Can optionally use the centralized database for persistence, or run
 * in-memory only for ephemeral rate limiting.
 * =============================================================================
 */

import { Context } from 'grammy';
import { AppError, Result } from '../../assistant/types';
import { auditLog } from '../../assistant/audit-log';
import { Database } from '../../database';

/**
 * Rate limiter error codes
 */
export const RATE_LIMIT_ERROR_CODES = {
  LIMIT_EXCEEDED: 'RATE_001',
  INVALID_CONFIG: 'RATE_002',
} as const;

/**
 * Rate limiter configuration
 */
export interface RateLimiterConfig {
  maxRequests: number;      // Maximum requests allowed in the window
  windowMs: number;         // Time window in milliseconds
  database?: Database;      // Optional: use database for persistence
}

/**
 * Locked user info for monitoring
 */
export interface LockedUserInfo {
  userId: number;
  requestCount: number;
  oldestRequestAge: number;  // ms since oldest request in window
}

/**
 * Rate limiter interface
 */
export interface RateLimiter {
  wrap: <T extends Context>(
    handler: (ctx: T) => Promise<void>
  ) => (ctx: T) => Promise<void>;
  
  isAllowed: (userId: number) => boolean;
  getRemainingRequests: (userId: number) => number;
  getResetTime: (userId: number) => number;  // ms until window resets
  getLockedUsers: () => LockedUserInfo[];    // monitoring: users with locked state
}

/**
 * User's rate limit state
 */
interface UserRateState {
  timestamps: number[];  // Timestamps of requests within the window
  locked: boolean;       // Simple lock for concurrency
}

/**
 * Creates a rate limiter error
 */
function createRateLimitError(code: string, message: string, details?: string): AppError {
  return {
    code,
    category: 'LLM',
    message,
    details,
  };
}

/**
 * Acquires a simple async lock
 */
async function acquireLock(state: UserRateState): Promise<void> {
  // Spin-wait with yielding until lock is free
  while (state.locked) {
    await new Promise(resolve => setImmediate(resolve));
  }
  state.locked = true;
}

/**
 * Releases the lock
 */
function releaseLock(state: UserRateState): void {
  state.locked = false;
}

/**
 * Creates a rate limiter.
 * 
 * Factory function pattern - returns a closure of methods.
 * 
 * @param config - Rate limiter configuration
 * @returns Result tuple with [error, limiter]
 * 
 * @example
 * ```ts
 * const [err, limiter] = createRateLimiter({ maxRequests: 5, windowMs: 60000 });
 * 
 * // Wrap a handler
 * const limitedHandler = limiter.wrap(async (ctx) => {
 *   await ctx.reply('Hello!');
 * });
 * 
 * // Use in bot
 * bot.command('ask', limitedHandler);
 * ```
 */
export function createRateLimiter(
  config: RateLimiterConfig
): [AppError | null, RateLimiter | null] {
  const { maxRequests, windowMs, database } = config;

  // Validate config
  if (maxRequests <= 0 || windowMs <= 0) {
    const error = createRateLimitError(
      RATE_LIMIT_ERROR_CODES.INVALID_CONFIG,
      'Invalid rate limiter configuration',
      `maxRequests and windowMs must be positive. Got: maxRequests=${maxRequests}, windowMs=${windowMs}`
    );
    auditLog.record(error.code, { maxRequests, windowMs });
    return [error, null];
  }

  // Per-user rate limit state (in-memory cache, synced with database if provided)
  const userStates = new Map<number, UserRateState>();

  /**
   * Gets or creates user state, loading from database if available
   */
  function getUserState(userId: number): UserRateState {
    let state = userStates.get(userId);
    if (!state) {
      // Try to load from database
      const timestamps = database?.getRateLimitTimestamps(userId) || [];
      state = { timestamps, locked: false };
      userStates.set(userId, state);
    }
    return state;
  }

  /**
   * Syncs state to database if available
   */
  function syncToDatabase(userId: number, state: UserRateState): void {
    if (database) {
      database.setRateLimitTimestamps(userId, state.timestamps);
    }
  }

  /**
   * Cleans up expired timestamps from the window
   */
  function cleanupTimestamps(state: UserRateState, now: number): void {
    const windowStart = now - windowMs;
    // Filter to keep only timestamps within the window
    state.timestamps = state.timestamps.filter(ts => ts > windowStart);
  }

  /**
   * Checks if a user is allowed to make a request (without consuming)
   */
  function isAllowed(userId: number): boolean {
    const state = getUserState(userId);
    const now = Date.now();
    
    // Clean expired timestamps
    cleanupTimestamps(state, now);
    
    return state.timestamps.length < maxRequests;
  }

  /**
   * Gets remaining requests for a user
   */
  function getRemainingRequests(userId: number): number {
    const state = getUserState(userId);
    const now = Date.now();
    
    cleanupTimestamps(state, now);
    
    return Math.max(0, maxRequests - state.timestamps.length);
  }

  /**
   * Gets milliseconds until the rate limit window resets
   */
  function getResetTime(userId: number): number {
    const state = getUserState(userId);
    const now = Date.now();
    
    cleanupTimestamps(state, now);
    
    if (state.timestamps.length === 0) {
      return 0;
    }

    // Oldest timestamp determines when a slot opens up
    const oldestTimestamp = state.timestamps[0];
    const resetAt = oldestTimestamp + windowMs;
    
    return Math.max(0, resetAt - now);
  }

  /**
   * Attempts to consume a request slot for the user.
   * Returns true if allowed, false if rate limited.
   */
  async function tryConsume(userId: number): Promise<boolean> {
    const state = getUserState(userId);
    
    await acquireLock(state);
    
    const now = Date.now();
    cleanupTimestamps(state, now);
    
    if (state.timestamps.length >= maxRequests) {
      releaseLock(state);
      return false;
    }
    
    // Record the request
    state.timestamps.push(now);
    
    // Sync to database
    syncToDatabase(userId, state);
    
    releaseLock(state);
    return true;
  }

  /**
   * Wraps a handler with rate limiting.
   * 
   * If the user is rate limited, replies with an error message
   * and does not execute the handler.
   */
  function wrap<T extends Context>(
    handler: (ctx: T) => Promise<void>
  ): (ctx: T) => Promise<void> {
    return async (ctx: T): Promise<void> => {
      const userId = ctx.from?.id;
      
      if (!userId) {
        // No user ID, skip rate limiting (shouldn't happen in normal cases)
        await handler(ctx);
        return;
      }

      const allowed = await tryConsume(userId);

      if (!allowed) {
        const resetMs = getResetTime(userId);
        const resetSeconds = Math.ceil(resetMs / 1000);
        
        auditLog.record(RATE_LIMIT_ERROR_CODES.LIMIT_EXCEEDED, {
          userId,
          resetMs,
          maxRequests,
          windowMs,
        });

        await ctx.reply(
          `⏳ Rate limit exceeded. Please wait ${resetSeconds} seconds before trying again.`,
          { reply_parameters: ctx.message ? { message_id: ctx.message.message_id } : undefined }
        ).catch(() => {});
        
        return;
      }

      auditLog.trace(`Rate limit: user ${userId} has ${getRemainingRequests(userId)} requests remaining`);
      
      await handler(ctx);
    };
  }

  /**
   * Gets a snapshot of all users currently in locked state.
   * 
   * This is a read-only operation that does not interfere with
   * ongoing acquireLock operations - it simply reads the current
   * locked boolean without modifying it.
   */
  function getLockedUsers(): LockedUserInfo[] {
    const now = Date.now();
    const lockedUsers: LockedUserInfo[] = [];

    for (const [userId, state] of userStates.entries()) {
      if (state.locked) {
        // Calculate age of oldest request (without modifying state)
        const validTimestamps = state.timestamps.filter(ts => ts > now - windowMs);
        const oldestRequestAge = validTimestamps.length > 0 
          ? now - validTimestamps[0] 
          : 0;

        lockedUsers.push({
          userId,
          requestCount: validTimestamps.length,
          oldestRequestAge,
        });
      }
    }

    return lockedUsers;
  }

  // Periodic cleanup of old user entries (users who haven't made requests in a while)
  setInterval(() => {
    const now = Date.now();
    const cutoff = now - windowMs * 2; // Keep entries for 2x the window
    
    for (const [userId, state] of userStates.entries()) {
      if (state.timestamps.length === 0 || 
          (state.timestamps[state.timestamps.length - 1] < cutoff && !state.locked)) {
        userStates.delete(userId);
      }
    }
  }, windowMs).unref(); // unref so it doesn't keep the process alive

  const limiter: RateLimiter = {
    wrap,
    isAllowed,
    getRemainingRequests,
    getResetTime,
    getLockedUsers,
  };

  auditLog.trace(`Rate limiter created: ${maxRequests} requests per ${windowMs}ms`);

  return [null, limiter];
}

/**
 * Creates a rate limiter with default settings (5 requests per 60 seconds)
 */
export function createDefaultRateLimiter(): [AppError | null, RateLimiter | null] {
  return createRateLimiter({
    maxRequests: 5,
    windowMs: 60 * 1000, // 60 seconds
  });
}
