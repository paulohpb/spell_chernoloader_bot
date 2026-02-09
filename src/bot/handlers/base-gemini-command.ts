/**
 * @module handlers/base-gemini-command
 *
 * Abstract base class for bot commands powered by the Gemini LLM.
 * Implements the Template Method pattern: the execution flow is fixed
 * in {@link handle}, while each step is delegated to abstract methods
 * that subclasses fill in.
 *
 * @typeParam TParsed - Data produced by {@link validate} and consumed
 *                      by {@link buildPrompt} and {@link formatResponse}.
 */

import { Context } from 'grammy';
import {
  GeminiService,
  ChatMessage,
  CompletionOptions,
} from '../../assistant/types';
import { auditLog } from '../../assistant/audit-log';
import { MemoryService, RetrievedMemory } from '../../assistant/services/memory.service';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Telegram's hard cap on a single message body (UTF-16 code units).
 * We use a slightly lower value as a safe margin.
 */
const TELEGRAM_MAX_MESSAGE_LENGTH = 4000;

export abstract class BaseGeminiCommand<TParsed = void> {
  protected readonly gemini: GeminiService;
  protected memoryService: MemoryService | null = null;

  constructor(gemini: GeminiService) {
    this.gemini = gemini;
  }

  /**
   * Injects the memory service for long-term knowledge retrieval/storage.
   * Called by bot.ts during initialization if memory is enabled.
   *
   * @param service - The initialized memory service instance.
   */
  public setMemoryService(service: MemoryService): void {
    this.memoryService = service;
  }

  // -----------------------------------------------------------------------
  // Subclass identity
  // -----------------------------------------------------------------------

  /** Command name without the leading slash (e.g. `"summary"`). */
  abstract readonly commandName: string;

  // -----------------------------------------------------------------------
  // Overridable configuration
  // -----------------------------------------------------------------------

  /**
   * Options forwarded to `geminiService.getCompletion`.
   * Override to set temperature, maxTokens, etc.
   */
  protected get completionOptions(): CompletionOptions {
    return {};
  }

  /**
   * Text sent when the Gemini call fails.
   * Override for a command-specific error message.
   */
  protected get failureMessage(): string {
    return '❌ Erro ao processar\\. Tente novamente\\.';
  }

  /**
   * Whether this command uses long-term memory.
   * Override to return `true` to enable memory retrieval and extraction.
   *
   * Default is `false` — commands must explicitly opt-in.
   */
  protected get useMemory(): boolean {
    return false;
  }

  /**
   * Whether to extract and store new memories after successful responses.
   * Only applies when `useMemory` is true.
   * Override to return `false` to disable extraction for read-only memory use.
   *
   * Default is `true` (when memory is enabled).
   */
  protected get extractMemories(): boolean {
    return true;
  }

  // -----------------------------------------------------------------------
  // Template method — fixed execution flow
  // -----------------------------------------------------------------------

  /**
   * Runs the full command pipeline.
   * Subclasses should not override this — implement the abstract steps instead.
   *
   * Steps: guard → extractArgs → validate → typing → buildPrompt →
   * getCompletion → formatResponse → sendMarkdown → onSuccess.
   */
  async handle(ctx: Context): Promise<void> {
    if (!ctx.message || !ctx.chat) return;

    const messageId = ctx.message.message_id;
    const rawArgs = this.extractArgs(ctx);

    const parsed = await this.validate(rawArgs, ctx);
    if (parsed === null) return;

    await ctx.replyWithChatAction('typing');

    // Retrieve relevant memories for this user (if enabled and available)
    let memories: RetrievedMemory[] = [];
    const userId = ctx.from?.id;
    if (this.useMemory && this.memoryService && userId) {
      const memoryContext = this.getMemoryContext(rawArgs, parsed, ctx);
      memories = await this.memoryService.retrieveRelevant(userId, memoryContext);
      auditLog.trace(
        `Memory: retrieved ${memories.length} memories for user ${userId} in /${this.commandName}`,
      );
    }

    // Build the prompt
    let messages = await this.buildPrompt(parsed, ctx);

    // Inject memories into the system prompt (if any were retrieved)
    if (memories.length > 0 && this.memoryService) {
      messages = this.injectMemoriesIntoPrompt(messages, memories);
    }

    const [error, result] = await this.gemini.getCompletion(
      messages,
      this.completionOptions,
    );

    if (error || !result) {
      auditLog.record(
        error?.code || `${this.commandName.toUpperCase()}_FAIL`,
        { error: error?.message },
      );
      await ctx.reply(this.failureMessage, {
        parse_mode: 'MarkdownV2',
        reply_parameters: { message_id: messageId },
      });
      return;
    }

    const formatted = this.formatResponse(result, parsed, ctx);
    await this.sendMarkdown(ctx, formatted, messageId);

    // Synchronous success hook
    this.onSuccess(result, parsed, ctx);

    // Extract and store new memories (async, non-blocking)
    if (
      this.useMemory &&
      this.extractMemories &&
      this.memoryService &&
      userId
    ) {
      const memoryContext = this.getMemoryContext(rawArgs, parsed, ctx);
      // Fire and forget — don't block the response
      this.memoryService
        .extractAndStore(userId, memoryContext, result, this.commandName)
        .catch((e) => {
          auditLog.trace(`Memory extraction background error: ${e.message}`);
        });
    }
  }

  // -----------------------------------------------------------------------
  // Abstract steps — subclasses MUST implement
  // -----------------------------------------------------------------------

  /**
   * Parses and validates the raw argument string.
   * Return `null` to abort — the method must send its own error reply
   * before returning null.
   *
   * @param rawArgs - Text after the `/command` prefix.
   * @param ctx     - Grammy context for sending error replies.
   */
  protected abstract validate(
    rawArgs: string,
    ctx: Context,
  ): Promise<TParsed | null>;

  /**
   * Builds the `ChatMessage[]` array sent to Gemini.
   *
   * @param parsed - Output of {@link validate}.
   * @param ctx    - Grammy context (for chat metadata if needed).
   */
  protected abstract buildPrompt(
    parsed: TParsed,
    ctx: Context,
  ): Promise<ChatMessage[]>;

  /**
   * Converts Gemini's raw text into the final reply string.
   *
   * @param result - Raw completion text.
   * @param parsed - Validated arguments (for dynamic headers).
   * @param ctx    - Grammy context.
   */
  protected abstract formatResponse(
    result: string,
    parsed: TParsed,
    ctx: Context,
  ): string;

  // -----------------------------------------------------------------------
  // Optional hooks — subclasses MAY override
  // -----------------------------------------------------------------------

  /**
   * Called after a successful reply.
   * Override for command-specific audit logging or side effects.
   * Default is a no-op.
   */
  protected onSuccess(
    _result: string,
    _parsed: TParsed,
    _ctx: Context,
  ): void { }

  /**
   * Extracts the context string used for memory retrieval and extraction.
   * By default, uses the raw args. Subclasses can override to include
   * additional context (e.g., scraped content, image descriptions).
   *
   * @param rawArgs - Text after the `/command` prefix.
   * @param parsed  - Output of {@link validate}.
   * @param ctx     - Grammy context.
   * @returns Context string for memory operations.
   */
  protected getMemoryContext(
    rawArgs: string,
    _parsed: TParsed,
    ctx: Context,
  ): string {
    // Include quoted message content if present
    const quotedText =
      ctx.message?.reply_to_message?.text ||
      ctx.message?.reply_to_message?.caption ||
      '';
    return `${rawArgs} ${quotedText}`.trim();
  }

  // -----------------------------------------------------------------------
  // Memory helpers
  // -----------------------------------------------------------------------

  /**
   * Injects retrieved memories into the first system message of the prompt.
   * If no system message exists, creates one.
   *
   * @param messages - Original message array from buildPrompt.
   * @param memories - Retrieved memories to inject.
   * @returns Modified message array with memory context.
   */
  private injectMemoriesIntoPrompt(
    messages: ChatMessage[],
    memories: RetrievedMemory[],
  ): ChatMessage[] {
    if (!this.memoryService || memories.length === 0) {
      return messages;
    }

    const memoryContext = this.memoryService.formatForPrompt(memories);
    if (!memoryContext) {
      return messages;
    }

    // Find the system message
    const systemIndex = messages.findIndex((m) => m.role === 'system');

    if (systemIndex !== -1) {
      // Prepend memory context to existing system message
      const updatedMessages = [...messages];
      updatedMessages[systemIndex] = {
        ...updatedMessages[systemIndex],
        content: `${memoryContext}\n\n${updatedMessages[systemIndex].content}`,
      };
      return updatedMessages;
    }

    // No system message — create one at the start
    return [
      { role: 'system', content: memoryContext },
      ...messages,
    ];
  }

  // -----------------------------------------------------------------------
  // Shared helpers
  // -----------------------------------------------------------------------

  /**
   * Strips the `/command@botname` prefix and returns remaining text.
   */
  protected extractArgs(ctx: Context): string {
    const text = ctx.message?.text || '';
    return text
      .replace(new RegExp(`^\/${this.commandName}(@\\w+)?`, 'i'), '')
      .trim();
  }

  /**
   * Splits text into chunks that fit within Telegram's message length limit.
   * Splits on double newlines (paragraph breaks) first, then single newlines,
   * then falls back to hard-cutting at the limit.
   * This preserves readability by never cutting mid-paragraph when avoidable.
   *
   * @param text - Full formatted text to split.
   * @returns Array of strings each within {@link TELEGRAM_MAX_MESSAGE_LENGTH}.
   */
  protected splitIntoChunks(text: string): string[] {
    if (text.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
      return [text];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > TELEGRAM_MAX_MESSAGE_LENGTH) {
      const segment = remaining.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH);
      let splitAt = -1;

      // Priority 1: split on the last double newline (paragraph boundary)
      const lastParagraph = segment.lastIndexOf('\n\n');
      if (lastParagraph > TELEGRAM_MAX_MESSAGE_LENGTH * 0.4) {
        splitAt = lastParagraph + 2; // include the \n\n in the current chunk's end
      }

      // Priority 2: split on the last single newline
      if (splitAt === -1) {
        const lastNewline = segment.lastIndexOf('\n');
        if (lastNewline > TELEGRAM_MAX_MESSAGE_LENGTH * 0.4) {
          splitAt = lastNewline + 1;
        }
      }

      // Priority 3: hard cut — no good break point found
      if (splitAt === -1) {
        splitAt = TELEGRAM_MAX_MESSAGE_LENGTH;
      }

      chunks.push(remaining.slice(0, splitAt).trim());
      remaining = remaining.slice(splitAt).trim();
    }

    // Push whatever is left
    if (remaining.length > 0) {
      chunks.push(remaining);
    }

    return chunks;
  }

  /**
   * Sends a reply with MarkdownV2 parse mode.
   * Automatically splits long text into multiple messages when it exceeds
   * Telegram's per-message limit. The first chunk is sent as a reply
   * to the original message; subsequent chunks are sent as plain follow-ups
   * to preserve the thread context without cluttering the quote chain.
   *
   * Falls back to plain text if Telegram rejects the markup.
   */
  protected async sendMarkdown(
    ctx: Context,
    text: string,
    replyTo: number,
  ): Promise<void> {
    const chunks = this.splitIntoChunks(text);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      // Only the first chunk is a reply to the original message
      const replyParams = i === 0
        ? { reply_parameters: { message_id: replyTo } }
        : {};

      await ctx
        .reply(chunk, {
          parse_mode: 'MarkdownV2',
          ...replyParams,
        })
        .catch(async () => {
          // Fallback: strip markdown special chars and send as plain text
          const plainText = chunk.replace(/\\([_*\[\]()~`>#+=|{}.!-])/g, '$1');
          await ctx.reply(plainText, {
            ...replyParams,
          });
        });
    }
  }
}