/**
 * @module media
 * Public API — drop-in replacement for the old single-file handler.
 *
 * @example
 * ```ts
 * import { createMediaHandler } from './handlers/media';
 *
 * const media = createMediaHandler({ targetGroupId: -100123456 });
 * bot.on('message', media.handleMessage);
 * ```
 */

export { createMediaHandler } from './media-handler';
export { MEDIA_ERROR_CODES } from './types';
export { ThrottledEditor } from './throttled-editor';
export type {
  MediaHandler,
  MediaHandlerConfig,
  MediaProvider,
  MediaInfo,
  QueuedJob,
} from './types';
