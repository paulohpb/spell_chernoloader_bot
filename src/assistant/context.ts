/**
 * =============================================================================
 * Context Service - Manages conversation history for the AI assistant
 * 
 * Ported from Python: telegram_ai_bot_A/services/history_service.py
 * 
 * Now uses the centralized database for storage instead of its own JSON file.
 * 
 * Error codes preserved:
 *   HISTORY_006: Invalid message role
 *   HISTORY_007: Invalid message content
 * =============================================================================
 */

import { Database, ConversationRecord } from '../database';
import { AppError, ChatMessage, Result } from './types';
import { auditLog } from './audit-log';

/**
 * Context service error codes
 */
export const CONTEXT_ERROR_CODES = {
  INVALID_ROLE: 'HISTORY_006',
  INVALID_CONTENT: 'HISTORY_007',
} as const;

/**
 * Re-export ConversationRecord as ConversationMessage for backwards compatibility
 */
export type ConversationMessage = ConversationRecord;

/**
 * Context service configuration
 */
export interface ContextServiceConfig {
  database: Database;
  maxMessages: number;
}

/**
 * Context service interface
 */
export interface ContextService {
  loadHistory:    (userId: number, chatId?: number) => [AppError | null, ConversationMessage[] | null];
  addMessage:     (userId: number, chatId: number, role: string, content: string) => [AppError | null, ConversationMessage | null];
  clearHistory:   (userId: number, chatId?: number) => [AppError | null, number | null];
  getMessageCount:(userId: number, chatId?: number) => [AppError | null, number | null];
  getMessagesForApi: (messages: ConversationMessage[], systemPrompt?: string) => ChatMessage[];
}

/**
 * Creates a context error
 */
function createContextError(code: string, message: string, details?: string): AppError {
  return {
    code,
    category: 'LLM',
    message,
    details,
  };
}

/**
 * Creates the context service.
 * 
 * Factory function pattern - returns a closure of methods.
 * 
 * @param config - Service configuration
 * @returns Result tuple with [error, service]
 */
export function createContextService(
  config: ContextServiceConfig
): [AppError | null, ContextService | null] {
  const { database, maxMessages } = config;

  /**
   * Loads conversation history for a user.
   *
   * @param userId - Telegram user ID.
   * @param chatId  - Optional chat scope.
   * @returns Result tuple with the record array or an error.
   */
  function loadHistory(
    userId: number,
    chatId?: number
  ): [AppError | null, ConversationMessage[] | null] {
    try {
      const records = database.getConversations(userId, chatId, maxMessages);
      auditLog.trace(`Loaded ${records.length} messages for user ${userId}`);
      return [null, records];
    } catch (e: unknown) {
      const error = createContextError(
        'DB_QUERY_001',
        'Failed to load conversation history',
        `User ID: ${userId}, Error: ${(e as Error).message}`
      );
      auditLog.record(error.code, { userId, chatId, error: (e as Error).message });
      return [error, null];
    }
  }

  /**
   * Appends a message to the user's conversation history.
   *
   * @param userId  - Telegram user ID.
   * @param chatId   - Telegram chat ID.
   * @param role     - One of `"user"`, `"assistant"`, or `"system"`.
   * @param content  - Non-empty message body.
   * @returns Result tuple with the new record or a validation / DB error.
   */
  function addMessage(
    userId: number,
    chatId: number,
    role: string,
    content: string
  ): [AppError | null, ConversationMessage | null] {
    if (role !== 'user' && role !== 'assistant' && role !== 'system') {
      const error = createContextError(
        CONTEXT_ERROR_CODES.INVALID_ROLE,
        'Invalid message role',
        `User ID: ${userId}, Role: ${role}, Expected: user/assistant/system`
      );
      auditLog.record(error.code, { userId, role });
      return [error, null];
    }

    if (!content || typeof content !== 'string') {
      const error = createContextError(
        CONTEXT_ERROR_CODES.INVALID_CONTENT,
        'Invalid message content',
        `User ID: ${userId}, Content must be a non-empty string`
      );
      auditLog.record(error.code, { userId });
      return [error, null];
    }

    try {
      const record = database.addConversation({
        userId,
        chatId,
        role: role as 'user' | 'assistant' | 'system',
        content,
      });
      auditLog.trace(`Added ${role} message for user ${userId}`);
      return [null, record];
    } catch (e: unknown) {
      const error = createContextError(
        'DB_QUERY_002',
        'Failed to add message to history',
        `User ID: ${userId}, Error: ${(e as Error).message}`
      );
      auditLog.record(error.code, { userId, chatId, error: (e as Error).message });
      return [error, null];
    }
  }

  /**
   * Clears conversation history for a user, optionally scoped to one chat.
   *
   * @param userId - Telegram user ID.
   * @param chatId  - If provided, only this chat is cleared.
   * @returns Result tuple with the number of removed records or an error.
   */
  function clearHistory(
    userId: number,
    chatId?: number
  ): [AppError | null, number | null] {
    try {
      const count = database.clearConversations(userId, chatId);
      auditLog.trace(`Cleared ${count} messages for user ${userId}`);
      return [null, count];
    } catch (e: unknown) {
      const error = createContextError(
        'DB_QUERY_003',
        'Failed to clear conversation history',
        `User ID: ${userId}, Error: ${(e as Error).message}`
      );
      auditLog.record(error.code, { userId, chatId, error: (e as Error).message });
      return [error, null];
    }
  }

  /**
   * Returns the number of messages currently stored for a user.
   *
   * @param userId - Telegram user ID.
   * @param chatId  - If provided, count only this chat's messages.
   * @returns Result tuple with the count or an error.
   */
  function getMessageCount(
    userId: number,
    chatId?: number
  ): [AppError | null, number | null] {
    try {
      const records = database.getConversations(userId, chatId);
      return [null, records.length];
    } catch (e: unknown) {
      const error = createContextError(
        'DB_QUERY_004',
        'Failed to get message count',
        `User ID: ${userId}, Error: ${(e as Error).message}`
      );
      auditLog.record(error.code, { userId, chatId, error: (e as Error).message });
      return [error, null];
    }
  }

  /**
   * Formats messages for LLM API consumption
   */
  function getMessagesForApi(
    messages: ConversationMessage[],
    systemPrompt?: string
  ): ChatMessage[] {
    const apiMessages: ChatMessage[] = [];

    if (systemPrompt) {
      apiMessages.push({
        role: 'system',
        content: systemPrompt,
      });
    }

    for (const msg of messages) {
      apiMessages.push({
        role: msg.role,
        content: msg.content,
      });
    }

    return apiMessages;
  }

  // Build and return the service
  const service: ContextService = {
    loadHistory,
    addMessage,
    clearHistory,
    getMessageCount,
    getMessagesForApi,
  };

  return [null, service];
}
