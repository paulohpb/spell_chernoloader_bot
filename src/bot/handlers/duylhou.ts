/**
 * =============================================================================
 * Duylhou Handler - Detects and calls out repeated links
 * 
 * "Duylhou" is a group inside joke for when someone posts content that
 * was already shared and discussed earlier. The bot will reply to the
 * original message and tag the reposter.
 * =============================================================================
 */

import { Context } from 'grammy';
import { Database, extractTrackableUrls } from '../../database';
import { auditLog } from '../../assistant/audit-log';

/**
 * Duylhou handler configuration
 */
export interface DuylhouHandlerConfig {
  database: Database;
  targetChatIds?: number[];  // Optional: only check in these chats
  ignoredUserIds?: number[]; // Optional: users to ignore (e.g., bots)
}

/**
 * Duylhou handler interface
 */
export interface DuylhouHandler {
  handleMessage: (ctx: Context) => Promise<void>;
}

/**
 * Creates the Duylhou handler.
 * 
 * Factory function pattern - returns a closure of methods.
 * 
 * @param config - Handler configuration
 * @returns DuylhouHandler instance
 */
export function createDuylhouHandler(config: DuylhouHandlerConfig): DuylhouHandler {
  const { database, targetChatIds, ignoredUserIds } = config;

  /**
   * Handles incoming messages, checking for repeated links
   */
  async function handleMessage(ctx: Context): Promise<void> {
    // Only process messages with text
    if (!ctx.message) return;
    
    const text = ctx.message.text || ctx.message.caption || '';
    if (!text) return;

    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    const messageId = ctx.message.message_id;

    if (!chatId || !userId) return;

    // Check if we should process this chat
    // Allow if private chat OR if it's in the target list
    const isPrivate = ctx.chat?.type === 'private';
    const isTarget = targetChatIds && targetChatIds.includes(chatId);

    if (!isPrivate && targetChatIds && targetChatIds.length > 0 && !isTarget) {
      return;
    }

    // Check if user should be ignored
    if (ignoredUserIds && ignoredUserIds.includes(userId)) {
      return;
    }

    // Extract trackable URLs
    const urls = extractTrackableUrls(text);
    if (urls.length === 0) return;

    auditLog.trace(`Duylhou: checking ${urls.length} URLs from user ${userId}`);

    // Check each URL for duplicates
    for (const { original, normalized } of urls) {
      const existingLink = database.findLink(normalized, chatId);

      if (existingLink && existingLink.userId !== userId) {
        // Found a duplicate from a different user!
        auditLog.trace(`Duylhou: duplicate found! Original by user ${existingLink.userId}, message ${existingLink.messageId}`);

        // Record the incident for leaderboard
        database.recordDuylhouIncident(
          userId,                    // offender
          existingLink.userId,       // original poster
          chatId,
          normalized
        );

        // Reply to the original message
        const response = await ctx.api.sendMessage(
          chatId,
          `Duylhou! 🔄`,
          {
            reply_parameters: {
              message_id: existingLink.messageId,
              allow_sending_without_reply: true,
            },
          }
        ).catch((e: Error) => {
          // If we can't reply to the original (deleted?), reply to current
          auditLog.trace(`Duylhou: couldn't reply to original message: ${e.message}`);
          return null;
        });

        // If couldn't reply to original, reply to the new message
        if (!response) {
          await ctx.reply(`Duylhou! 🔄 (original message was deleted)`, {
            reply_parameters: { message_id: messageId },
          }).catch(() => {});
        }

        // Don't add this link since it's a duplicate
        // But we could update the record if we want to track the latest
        return;
      }

      if (!existingLink) {
        // New link, add it to the database
        database.addLink({
          url: original,
          normalizedUrl: normalized,
          chatId,
          userId,
          messageId,
        });
        
        auditLog.trace(`Duylhou: registered new link from user ${userId}`);
      }
      // If existingLink but same user, just ignore (they're reposting their own link)
    }
  }

  return {
    handleMessage,
  };
}
