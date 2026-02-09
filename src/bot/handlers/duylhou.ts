/**
 * =============================================================================
 * Duylhou Handler — duplicate-link detector & group-joke responder
 *
 * When a user posts a link that was already shared (and is still within the
 * expiry window) the bot replies **to that user's message** with a sticker
 * (if configured) or a plain-text fallback.  The incident is recorded on the
 * leaderboard so the group can keep score.
 *
 * Sticker behaviour
 * -----------------
 * Telegram stickers are referenced by a stable `file_id` string.  To obtain
 * one: forward any sticker to @getidsbot — it will reply with the file_id.
 * Set that value in `.env` as `DUYLHOU_STICKER_FILE_ID`.  When the value is
 * empty the handler falls back to a short text reply.
 * =============================================================================
 */

import { Context } from 'grammy';
import { Database, extractAndNormalizeUrls } from '../../database';
import { auditLog } from '../../assistant/audit-log';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Configuration for the Duylhou handler.
 */
export interface DuylhouHandlerConfig {
  /** The central database instance (for link storage & leaderboard). */
  database: Database;
  /** Only react in these chat IDs.  Empty / undefined = all chats. */
  targetChatIds?: number[];
  /** User IDs to skip entirely (e.g. the bot's own ID). */
  ignoredUserIds?: number[];
  /**
   * Telegram sticker `file_id` to send on a Duylhou hit.
   * Empty string → fall back to a text reply.
   */
  duylhouStickerFileId?: string;
}

/** Public surface of the handler. */
export interface DuylhouHandler {
  /** Call this for every incoming message. */
  handleMessage: (ctx: Context) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates the Duylhou handler.
 *
 * @param config - See {@link DuylhouHandlerConfig}.
 * @returns A handler object with a single `handleMessage` method.
 */
export function createDuylhouHandler(config: DuylhouHandlerConfig): DuylhouHandler {
  const { database, targetChatIds, ignoredUserIds, duylhouStickerFileId } = config;

  /**
   * Sends either the configured sticker or a plain-text "Duylhou!" reply,
   * always quoting the offender's own message so the callout lands visually
   * right below it.
   *
   * @param ctx       - Grammy context (carries the Telegram API client).
   * @param chatId    - The chat to send into.
   * @param messageId - The offender's message ID (used as the reply target).
   */
  async function sendDuylhouResponse(
    ctx: Context,
    chatId: number,
    messageId: number,
  ): Promise<void> {
    const replyParams = {
      reply_parameters: {
        message_id: messageId,
        allow_sending_without_reply: true,
      },
    };

    if (duylhouStickerFileId) {
      // Send the pre-uploaded sticker by its file_id.
      await ctx.api
        .sendSticker(chatId, duylhouStickerFileId, replyParams)
        .catch((e: Error) => {
          // If the sticker send fails (e.g. file_id expired / wrong chat type)
          // fall back to text so the user still sees the callout.
          auditLog.trace(`Duylhou: sticker send failed (${e.message}), falling back to text`);
          return ctx.api.sendMessage(chatId, 'Duylhou! 🔄', replyParams).catch(() => {});
        });
    } else {
      // No sticker configured — plain text.
      await ctx.api
        .sendMessage(chatId, 'Duylhou! 🔄', replyParams)
        .catch(() => {});
    }
  }

  /**
   * Main entry point — called for every incoming message.
   * Extracts trackable URLs, checks each against the link index,
   * and fires the Duylhou response on the first duplicate hit.
   *
   * @param ctx - Grammy context for the incoming message.
   */
  async function handleMessage(ctx: Context): Promise<void> {
    if (!ctx.message) return;

    const text = ctx.message.text || ctx.message.caption || '';
    if (!text) return;

    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    const messageId = ctx.message.message_id;

    if (!chatId || !userId) return;

    // Scope check — honour targetChatIds when set.
    const isPrivate = ctx.chat?.type === 'private';
    const isTarget  = targetChatIds && targetChatIds.includes(chatId);
    if (!isPrivate && targetChatIds && targetChatIds.length > 0 && !isTarget) return;

    // User ignore-list (e.g. the bot itself).
    if (ignoredUserIds && ignoredUserIds.includes(userId)) return;

    // ---------------------------------------------------------------------------
    // URL extraction & duplicate check
    // ---------------------------------------------------------------------------
    const urls = extractAndNormalizeUrls(text);
    if (urls.length === 0) return;

    auditLog.trace(`Duylhou: checking ${urls.length} URL(s) from user ${userId}`);

    for (const { original, normalized } of urls) {
      const existingLink = database.findLink(normalized, chatId);

      if (existingLink && existingLink.userId !== userId) {
        // ── duplicate posted by a *different* user ──────────────────────
        auditLog.trace(
          `Duylhou: duplicate detected — original by user ${existingLink.userId} ` +
          `(msg ${existingLink.messageId}), repeated by ${userId} (msg ${messageId})`,
        );

        // Persist the incident for the monthly leaderboard.
        database.recordDuylhouIncident(userId, existingLink.userId, chatId, normalized);

        // Reply to the *offender's* message with sticker or text.
        await sendDuylhouResponse(ctx, chatId, messageId);

        // First duplicate wins — stop scanning remaining URLs in this message.
        return;
      }

      if (!existingLink) {
        // Brand-new link — register it so future duplicates can be caught.
        database.addLink({
          url: original,
          normalizedUrl: normalized,
          chatId,
          userId,
          messageId,
        });
        auditLog.trace(`Duylhou: registered new link from user ${userId}`);
      }
      // existingLink && same userId → user reposted their own link; ignore.
    }
  }

  return { handleMessage };
}
