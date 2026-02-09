/**
 * @module media/queue
 *
 * Concurrency-limited FIFO queue for media download jobs.
 *
 * Only `maxConcurrency` jobs run at the same time.  Every job that arrives
 * while all slots are busy is placed in a pending list.  The queue updates
 * the pending job's Telegram status message so the user sees how many jobs
 * are ahead of theirs.
 *
 * Status-message rules:
 *  - 0 pending ahead  → no queue status shown (the job starts immediately).
 *  - 1 job ahead      → show "⏳ 1 job ahead (@username — Platform)"
 *  - 2+ jobs ahead    → show "⏳ N jobs ahead" listing each one.
 *
 * The queue is instantiated once per handler and shared across all chats
 * that the handler serves, so the concurrency limit is global.
 */

import type { QueuedJob } from './types';
import { escapeMarkdown } from './caption-formatter';
import { ThrottledEditor } from './throttled-editor';

/**
 * The function signature the queue calls when a job becomes active.
 * It must resolve (or reject) once the job's work is fully done so the
 * queue can free the slot.
 */
export type JobExecutor = (job: QueuedJob) => Promise<void>;

export class ProcessingQueue {
  /** Maximum simultaneous active jobs. */
  private readonly maxConcurrency: number;

  /** Function invoked for every job when it is activated. */
  private readonly executor: JobExecutor;

  /** Throttled editor used for queue-status messages. */
  private readonly editor: ThrottledEditor;

  /** Jobs currently being processed.  Size never exceeds `maxConcurrency`. */
  private readonly activeSlots: Set<QueuedJob> = new Set();

  /** FIFO list of jobs waiting for a free slot. */
  private readonly pending: QueuedJob[] = [];

  /** Monotonically increasing job counter. */
  private nextId = 1;

  /**
   * @param executor       - Async function that does the actual download + upload.
   * @param editor         - Throttled editor used for queue-status messages.
   * @param maxConcurrency - How many downloads may run in parallel (default 2).
   */
  constructor(
    executor: JobExecutor,
    editor: ThrottledEditor,
    maxConcurrency: number = 2,
  ) {
    this.executor = executor;
    this.editor = editor;
    this.maxConcurrency = maxConcurrency;
  }

  /** Reference to the throttled editor (used by the executor for cleanup). */
  get throttledEditor(): ThrottledEditor {
    return this.editor;
  }

  /**
   * Adds a job and waits until it has completed execution.
   * If no slot is free the job is parked and its status message is updated
   * with queue position info via the throttled editor.
   */
  async enqueue(
    jobData: Omit<QueuedJob, 'id' | 'status' | 'resolve' | 'done' | 'enqueuedAt'>,
  ): Promise<void> {
    let resolve!: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });

    const job: QueuedJob = {
      ...jobData,
      id: this.nextId++,
      status: 'pending',
      enqueuedAt: Date.now(),
      resolve,
      done,
    };

    if (this.activeSlots.size < this.maxConcurrency) {
      this.activate(job);
    } else {
      this.pending.push(job);
      await this.showQueueStatus(job);
    }

    await done;
  }

  /**
   * Marks a job as finished, frees its slot, and promotes the next
   * pending job.  The promoted job's throttled queue-status edit is
   * cancelled before a direct edit resets it to the provider's status
   * message, avoiding a stale overwrite race.
   */
  async finishJob(job: QueuedJob): Promise<void> {
    job.status = 'done';
    this.activeSlots.delete(job);
    job.resolve();

    const next = this.pending.shift();
    if (next) {
      // Drop the throttled "⏳ N jobs ahead" edit — the job is active now.
      this.editor.cancel(next.ctx.chat!.id, next.statusMsgId);

      // Direct (un-throttled) edit: single transition, not a burst.
      await next.ctx.api
        .editMessageText(
          next.ctx.chat!.id,
          next.statusMsgId,
          next.provider.statusMessage,
        )
        .catch(() => {});

      this.activate(next);
    }
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get activeCount(): number {
    return this.activeSlots.size;
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private activate(job: QueuedJob): void {
    job.status = 'active';
    this.activeSlots.add(job);

    this.executor(job).catch(() => {
      this.finishJob(job);
    });
  }

  /**
   * Builds the queue-position text and sends it through the throttled
   * editor so rapid enqueue bursts never trip Telegram's rate limit.
   */
  private async showQueueStatus(job: QueuedJob): Promise<void> {
    const myIndex = this.pending.indexOf(job);
    const totalAhead = this.activeSlots.size + myIndex;

    let statusText: string;

    if (totalAhead === 1) {
      const activeJob = [...this.activeSlots][0];
      statusText =
        `⏳ *1 job ahead*\n` +
        `  └─ 🔄 ${escapeMarkdown(activeJob.requesterName)} — ` +
        `${escapeMarkdown(activeJob.provider.platform)}`;
    } else {
      const lines: string[] = [];

      for (const active of this.activeSlots) {
        lines.push(
          `  🔄 ${escapeMarkdown(active.requesterName)} — ` +
            `${escapeMarkdown(active.provider.platform)}`,
        );
      }

      for (const p of this.pending.slice(0, myIndex)) {
        lines.push(
          `  ⏳ ${escapeMarkdown(p.requesterName)} — ` +
            `${escapeMarkdown(p.provider.platform)}`,
        );
      }

      statusText = `⏳ *${totalAhead} jobs ahead*\n` + lines.join('\n');
    }

    // Routed through the throttled editor — safe during bursts.
    await this.editor.edit(
      job.ctx.api,
      job.ctx.chat!.id,
      job.statusMsgId,
      statusText,
      'MarkdownV2',
    );
  }
}
