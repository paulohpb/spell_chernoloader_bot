/**
 * @module media/types
 * Shared type definitions for the media extraction system.
 */

import type { Context } from 'grammy';
import { AppError, Result } from '../../../assistant/types';

export type { AppError, Result };

/** Error codes for media operations. */
export const MEDIA_ERROR_CODES = {
  FETCH_FAILED: 'MEDIA_001',
  DOWNLOAD_FAILED: 'MEDIA_002',
  NOT_FOUND: 'MEDIA_003',
  SIZE_LIMIT: 'MEDIA_005',
  QUEUE_OVERFLOW: 'MEDIA_006',
} as const;

/** Supported platform identifiers. */
export type PlatformName = 'Instagram' | 'TikTok' | 'Twitter' | 'Reddit' | 'YouTube';

/**
 * Extracted media metadata from a social platform.
 * At least one of `videoUrl`, `imageUrl`, or `muxedStream` will be present on success.
 */
export interface MediaInfo {
  videoUrl?: string;
  imageUrl?: string;
  caption?: string;
  author?: string;
  platform: PlatformName;
  /**
   * Pre-built readable stream used by YouTube when DASH merging was required.
   * When set the downloader skips the HTTP fetch and uses this directly.
   */
  muxedStream?: import('stream').Readable;
}

/** 
 * Synchronous result tuple (not wrapped in Promise). 
 * Useful for internal helper methods.
 */
export type SyncResult<T> = [AppError | null, T | null];

/**
 * Strategy interface for platform-specific media extraction.
 * Each supported platform implements this contract.
 * The handler iterates all registered providers, tests `regex` against the
 * message text, and calls `fetch()` on the first match.
 */
export interface MediaProvider {
  /** Platform name used in captions and inline buttons. */
  readonly platform: PlatformName;

  /** Pattern used to detect and capture URL parts from chat messages. */
  readonly regex: RegExp;

  /** Temporary status text shown while the provider works. */
  readonly statusMessage: string;

  /**
   * Extracts media info from a matched URL.
   * @param match - RegExp match array produced by `regex`.
   * @returns `Result<MediaInfo>` (which is `Promise<[AppError | null, MediaInfo | null]>`).
   */
  fetch(match: RegExpMatchArray): Result<MediaInfo>;
}

/** Configuration passed to the handler factory. */
export interface MediaHandlerConfig {
  /** Chat ID where the handler is active. Ignored in private chats. */
  targetGroupId: number;
  /**
   * Maximum number of downloads processed simultaneously.
   * Defaults to 2.
   */
  maxConcurrency?: number;
}

/** Public surface of the media handler. */
export interface MediaHandler {
  handleMessage(ctx: Context): Promise<void>;
}

// ---------------------------------------------------------------------------
// Queue types
// ---------------------------------------------------------------------------

/** Lifecycle states a job passes through inside the queue. */
export type JobStatus = 'pending' | 'active' | 'done' | 'failed';

/**
 * A single work unit tracked by the queue.
 * Holds everything needed to resume or display status.
 */
export interface QueuedJob {
  /** Unique sequential ID. */
  id: number;
  /** Current lifecycle state. */
  status: JobStatus;
  /** Grammy context for sending/editing messages. */
  ctx: Context;
  /** The matched provider — drives `fetch()`. */
  provider: MediaProvider;
  /** Full regex match array from the original message. */
  match: RegExpMatchArray;
  /** Raw URL string used in inline buttons. */
  originalUrl: string;
  /** Message ID of the status placeholder the bot sent. */
  statusMsgId: number;
  /** Username or display name of the requesting user (for queue status). */
  requesterName: string;
  /** Timestamp when the job was enqueued (epoch ms). */
  enqueuedAt: number;
  /** Resolves when the job finishes (success or failure). */
  resolve: () => void;
  /** The promise that callers can await to know when the job is done. */
  done: Promise<void>;
}
