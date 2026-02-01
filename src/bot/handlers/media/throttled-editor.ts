/**
 * @module media/throttled-editor
 *
 * Rate-limited wrapper around Telegram's `editMessageText`.
 *
 * Telegram enforces per-chat rate limits (~20 edits/minute in the same chat).
 * When many jobs are enqueued in a burst every new pending job triggers a
 * status-message edit.  This class serialises those edits per chat and
 * inserts a configurable pause between consecutive sends, keeping the bot
 * well under the threshold.
 *
 * Extra features:
 *  - **Deduplication** — if a newer edit arrives for the same message
 *    before the earlier one was sent, only the latest content is delivered.
 *  - **Cancellation** — `cancel()` drops a pending edit so it never fires
 *    (call it before deleting a message).
 */

import type { Api } from 'grammy';

/** Internal bookkeeping for one queued edit call. */
interface QueuedEdit {
  messageId: number;
  text: string;
  parseMode?: string;
  resolve: () => void;
}

export class ThrottledEditor {
  /** Minimum milliseconds between two edits in the same chat. */
  private readonly minGapMs: number;

  /** Per-chat FIFO of edits waiting to be sent. */
  private readonly queues = new Map<number, QueuedEdit[]>();

  /** Chat IDs whose drain loop is currently running. */
  private readonly draining = new Set<number>();

  /** Epoch-ms timestamp of the last edit sent to each chat. */
  private readonly lastEditAt = new Map<number, number>();

  /**
   * @param minGapMs - Pause between consecutive edits in one chat (default 2 s).
   *                   Telegram tolerates ~20 edits/min ≈ one every 3 s, so 2 s
   *                   gives headroom without feeling sluggish.
   */
  constructor(minGapMs: number = 2_000) {
    this.minGapMs = minGapMs;
  }

  /**
   * Schedules an edit.  Resolves once the API call completes.
   *
   * If the same `messageId` already has an unsent edit in the chat's queue
   * the old content is silently replaced (dedup).
   *
   * @param api       - Grammy `Api` instance.
   * @param chatId    - Target chat.
   * @param messageId - Message to edit.
   * @param text      - New text content.
   * @param parseMode - Optional parse mode (`MarkdownV2`, `HTML`, …).
   */
  edit(
    api: Api,
    chatId: number,
    messageId: number,
    text: string,
    parseMode?: string,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let queue = this.queues.get(chatId);
      if (!queue) {
        queue = [];
        this.queues.set(chatId, queue);
      }

      // Dedup: replace any pending edit for the same message.
      const idx = queue.findIndex((e) => e.messageId === messageId);
      if (idx !== -1) {
        queue[idx].resolve();                           // superseded — resolve silently
        queue[idx] = { messageId, text, parseMode, resolve };
      } else {
        queue.push({ messageId, text, parseMode, resolve });
      }

      // Kick the drain loop if it is not already running for this chat.
      if (!this.draining.has(chatId)) {
        this.drain(api, chatId);
      }
    });
  }

  /**
   * Removes any pending (unsent) edit for the given message.
   * Call this before deleting a message to avoid editing a stale target.
   *
   * @param chatId    - Target chat.
   * @param messageId - Message whose pending edit should be dropped.
   */
  cancel(chatId: number, messageId: number): void {
    const queue = this.queues.get(chatId);
    if (!queue) return;
    const idx = queue.findIndex((e) => e.messageId === messageId);
    if (idx !== -1) {
      queue[idx].resolve();
      queue.splice(idx, 1);
    }
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  /**
   * Processes queued edits for `chatId` one by one, sleeping between sends
   * to stay under Telegram's per-chat rate limit.
   */
  private async drain(api: Api, chatId: number): Promise<void> {
    this.draining.add(chatId);
    const queue = this.queues.get(chatId)!;

    while (queue.length > 0) {
      const entry = queue.shift()!;

      // Enforce minimum gap since the last edit in this chat.
      const last = this.lastEditAt.get(chatId) ?? 0;
      const wait = this.minGapMs - (Date.now() - last);
      if (wait > 0) {
        await new Promise<void>((r) => setTimeout(r, wait));
      }

      this.lastEditAt.set(chatId, Date.now());

      await api
        .editMessageText(
          chatId,
          entry.messageId,
          entry.text,
          entry.parseMode
            ? { parse_mode: entry.parseMode as any }
            : undefined,
        )
        .catch(() => {});

      entry.resolve();
    }

    this.draining.delete(chatId);
    this.queues.delete(chatId);
  }
}
