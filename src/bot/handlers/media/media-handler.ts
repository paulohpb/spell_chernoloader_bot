/**
 * @module media/media-handler
 *
 * Orchestrates the full pipeline:
 *  1. Match incoming message against registered providers.
 *  2. Enqueue the matched job via `ProcessingQueue`.
 *  3. When the queue activates the job it calls the executor, which runs
 *     `processMedia`: fetch metadata → download stream → upload to Telegram.
 *
 * The queue ensures at most `maxConcurrency` downloads run simultaneously.
 * Users whose jobs are waiting see a live status of what is ahead of them.
 */

import { Context, InputFile, InlineKeyboard } from 'grammy';
import type { MediaInfo, MediaHandlerConfig, MediaHandler, QueuedJob } from './types';
import { providers } from './providers';
import { downloadStream } from './downloader';
import { escapeMarkdown, truncate } from './utils';
import { ProcessingQueue } from './queue';
import { ThrottledEditor } from './throttled-editor';

// ---------------------------------------------------------------------------
// Stream resolution
// ---------------------------------------------------------------------------

/**
 * Returns the correct Readable for a MediaInfo.
 * If the provider already produced a merged stream (YouTube DASH) we use it
 * directly; otherwise we open an HTTP download to the URL.
 *
 * @param media - The resolved media metadata.
 */
async function resolveMediaStream(
  media: MediaInfo,
): Promise<import('./types').Result<import('stream').Readable>> {
  if (media.muxedStream) {
    return [null, media.muxedStream];
  }

  const url = media.videoUrl ?? media.imageUrl;
  if (!url) {
    return [
      { code: 'MEDIA_002', category: 'MEDIA', message: 'No stream or URL available' },
      null,
    ];
  }

  return downloadStream(url);
}

// ---------------------------------------------------------------------------
// Sending helpers
// ---------------------------------------------------------------------------

/**
 * Streams a video into the chat.
 *
 * @param ctx         - Grammy context.
 * @param media       - Resolved media metadata.
 * @param originalUrl - Raw URL for the inline button.
 * @param statusMsgId - Placeholder message ID to edit/delete.
 */
async function sendVideo(
  ctx: Context,
  media: MediaInfo,
  originalUrl: string,
  statusMsgId: number,
): Promise<void> {
  const chatId = ctx.chat!.id;
  await ctx.api
    .editMessageText(chatId, statusMsgId, '⬇️ Downloading video...')
    .catch(() => {});

  const [dlErr, stream] = await resolveMediaStream(media);
  if (dlErr || !stream) {
    await ctx.api
      .editMessageText(chatId, statusMsgId, '⚠️ Download failed.')
      .catch(() => {});
    return;
  }

  await ctx.replyWithChatAction('upload_video');

  const authorLine = media.author ? `👤 *${escapeMarkdown(media.author)}*\n` : '';
  const captionLine = media.caption ? escapeMarkdown(truncate(media.caption)) : '';

  await ctx.replyWithVideo(new InputFile(stream, `vid_${Date.now()}.mp4`), {
    caption: authorLine + captionLine,
    parse_mode: 'MarkdownV2',
    reply_markup: new InlineKeyboard().url(
      `Open in ${media.platform} ↗️`,
      originalUrl,
    ),
  });
}

/**
 * Streams an image into the chat.
 *
 * @param ctx         - Grammy context.
 * @param media       - Resolved media metadata.
 * @param originalUrl - Raw URL for the inline button.
 * @param statusMsgId - Placeholder message ID to edit/delete.
 */
async function sendImage(
  ctx: Context,
  media: MediaInfo,
  originalUrl: string,
  statusMsgId: number,
): Promise<void> {
  const chatId = ctx.chat!.id;

  const [dlErr, stream] = await resolveMediaStream(media);
  if (dlErr || !stream) {
    await ctx.api
      .editMessageText(chatId, statusMsgId, '⚠️ Download failed.')
      .catch(() => {});
    return;
  }

  await ctx.replyWithPhoto(new InputFile(stream, `img_${Date.now()}.jpg`), {
    caption: `📷 *${escapeMarkdown(media.author || 'Image')}*`,
    parse_mode: 'MarkdownV2',
    reply_markup: new InlineKeyboard().url(
      `Open in ${media.platform} ↗️`,
      originalUrl,
    ),
  });
}

// ---------------------------------------------------------------------------
// Job executor (called by the queue when a slot is free)
// ---------------------------------------------------------------------------

/**
 * Runs the full fetch → download → upload cycle for a single job.
 * This is the executor passed to the queue constructor.
 * It MUST call `queue.finishJob(job)` exactly once when done (success or error)
 * so the slot is released and the next pending job can start.
 *
 * @param job   - The activated queue job.
 * @param queue - The queue instance (captured via closure in the factory).
 */
async function executeJob(job: QueuedJob, queue: ProcessingQueue): Promise<void> {
  const { ctx, provider, match, originalUrl, statusMsgId } = job;
  const chatId = ctx.chat!.id;

  try {
    const [err, media] = await provider.fetch(match);

    if (err || !media) {
      await ctx.api
        .editMessageText(chatId, statusMsgId, `❌ Error: ${err?.message ?? 'Processing failed'}`)
        .catch(() => {});
      return;
    }

    if (media.videoUrl || media.muxedStream) {
      await sendVideo(ctx, media, originalUrl, statusMsgId);
    } else if (media.imageUrl) {
      await sendImage(ctx, media, originalUrl, statusMsgId);
    } else {
      await ctx.api
        .editMessageText(chatId, statusMsgId, '⚠️ No supported media found.')
        .catch(() => {});
      return;
    }

    // Clean up the status placeholder after a successful send.
    // Drop any lingering throttled edit before deleting the message.
    queue.throttledEditor.cancel(chatId, statusMsgId);
    await ctx.api.deleteMessage(chatId, statusMsgId).catch(() => {});
  } catch (e: any) {
    await ctx.api
      .editMessageText(chatId, statusMsgId, `❌ Unexpected error: ${e.message}`)
      .catch(() => {});
  } finally {
    // Always release the slot — critical for queue progress.
    await queue.finishJob(job);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a media handler with an internal processing queue.
 *
 * The handler:
 *  - Matches incoming URLs against the provider registry.
 *  - Sends a status placeholder message.
 *  - Enqueues a job.  If all concurrency slots are busy the user sees a
 *    waiting status with the jobs ahead of them.
 *  - When the queue activates the job, `executeJob` runs the full pipeline.
 *
 * @param config - Must include `targetGroupId`. Optionally set `maxConcurrency`.
 * @returns Object with a `handleMessage` method for Grammy middleware.
 */
export function createMediaHandler(config: MediaHandlerConfig): MediaHandler {
  const { targetGroupId, maxConcurrency = 2 } = config;

  const editor = new ThrottledEditor();  // 2 s default gap

  let queue: ProcessingQueue; // Declare first with type

  queue = new ProcessingQueue(
    (job: QueuedJob) => executeJob(job, queue),
    editor,
    maxConcurrency,
  );

  return {
    async handleMessage(ctx: Context): Promise<void> {
      if (!ctx.message) return;

      const text = ctx.message.text || ctx.message.caption || '';
      if (!text) return;

      // Only act in the target group or in private chats.
      if (ctx.chat?.type !== 'private' && ctx.chat?.id !== targetGroupId) return;

      // Walk providers until one matches.
      for (const provider of providers) {
        const match = text.match(provider.regex);
        if (!match) continue;

        // Send a placeholder message that will be edited with status updates.
        const statusMsg = await ctx.reply(provider.statusMessage, {
          reply_parameters: { message_id: ctx.message.message_id },
        });

        // Determine a display name for queue status messages.
        const user = ctx.message.from;
        const requesterName =
          user?.username ? `@${user.username}` : user?.first_name ?? 'Unknown';

        // Enqueue blocks until the job finishes.  The queue will either
        // start it immediately or park it and show waiting status.
        await queue.enqueue({
          ctx,
          provider,
          match,
          originalUrl: match[0],
          statusMsgId: statusMsg.message_id,
          requesterName,
        });

        // First match wins — stop checking other providers.
        return;
      }
    },
  };
}