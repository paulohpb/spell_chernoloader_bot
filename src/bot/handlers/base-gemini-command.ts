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

export abstract class BaseGeminiCommand<TParsed = void> {
  protected readonly gemini: GeminiService;

  constructor(gemini: GeminiService) {
    this.gemini = gemini;
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
    return '❌ Erro ao processar. Tente novamente.';
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

    const messages = await this.buildPrompt(parsed, ctx);

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
        reply_parameters: { message_id: messageId },
      });
      return;
    }

    const formatted = this.formatResponse(result, parsed, ctx);
    await this.sendMarkdown(ctx, formatted, messageId);

    this.onSuccess(result, parsed, ctx);
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
  ): void {}

  // -----------------------------------------------------------------------
  // Shared helpers
  // -----------------------------------------------------------------------

  /**
   * Strips the `/command@botname` prefix and returns remaining text.
   */
  protected extractArgs(ctx: Context): string {
    const text = ctx.message?.text || '';
    return text
      .replace(new RegExp(`^\/${this.commandName}(@\w+)?`, 'i'), '')
      .trim();
  }

  /**
   * Sends a reply with Markdown parse mode.
   * Falls back to plain text if Telegram rejects the markup.
   */
  protected async sendMarkdown(
    ctx: Context,
    text: string,
    replyTo: number,
  ): Promise<void> {
    await ctx
      .reply(text, {
        parse_mode: 'Markdown',
        reply_parameters: { message_id: replyTo },
      })
      .catch(async () => {
        await ctx.reply(text, {
          reply_parameters: { message_id: replyTo },
        });
      });
  }
}
