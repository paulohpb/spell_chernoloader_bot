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
  loadHistory: (userId: number, chatId?: number) => Result<ConversationMessage[]>;
  addMessage: (userId: number, chatId: number, role: string, content: string) => Result<ConversationMessage>;
  clearHistory: (userId: number, chatId?: number) => Result<number>;
  getMessageCount: (userId: number, chatId?: number) => Result<number>;
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
   * Loads conversation history for a user
   */
  async function loadHistory(
    userId: number,
    chatId?: number
  ): Result<ConversationMessage[]> {
    return Promise.resolve()
      .then(() => {
        const records = database.getConversations(userId, chatId, maxMessages);
        auditLog.trace(`Loaded ${records.length} messages for user ${userId}`);
        return [null, records] as [null, ConversationMessage[]];
      })
      .catch((e: Error) => {
        const error = createContextError(
          'DB_QUERY_001',
          'Failed to load conversation history',
          `User ID: ${userId}, Error: ${e.message}`
        );
        auditLog.record(error.code, { userId, chatId, error: e.message });
        return [error, null] as [AppError, null];
      });
  }

  /**
   * Adds a message to user's history
   */
  async function addMessage(
    userId: number,
    chatId: number,
    role: string,
    content: string
  ): Result<ConversationMessage> {
    // Validate role
    if (role !== 'user' && role !== 'assistant' && role !== 'system') {
      const error = createContextError(
        CONTEXT_ERROR_CODES.INVALID_ROLE,
        'Invalid message role',
        `User ID: ${userId}, Role: ${role}, Expected: user/assistant/system`
      );
      auditLog.record(error.code, { userId, role });
      return [error, null];
    }

    // Validate content
    if (!content || typeof content !== 'string') {
      const error = createContextError(
        CONTEXT_ERROR_CODES.INVALID_CONTENT,
        'Invalid message content',
        `User ID: ${userId}, Content must be a non-empty string`
      );
      auditLog.record(error.code, { userId });
      return [error, null];
    }

    return Promise.resolve()
      .then(() => {
        const record = database.addConversation({
          userId,
          chatId,
          role: role as 'user' | 'assistant' | 'system',
          content,
        });

        // Check if we need to trim old messages
        const allRecords = database.getConversations(userId, chatId);
        if (allRecords.length > maxMessages) {
          // The database handles this internally via the limit parameter
          // when reading, but we could also clean up here if needed
        }

        auditLog.trace(`Added ${role} message for user ${userId}`);
        return [null, record] as [null, ConversationMessage];
      })
      .catch((e: Error) => {
        const error = createContextError(
          'DB_QUERY_002',
          'Failed to add message to history',
          `User ID: ${userId}, Error: ${e.message}`
        );
        auditLog.record(error.code, { userId, chatId, error: e.message });
        return [error, null] as [AppError, null];
      });
  }

  /**
   * Clears conversation history for a user
   */
  async function clearHistory(
    userId: number,
    chatId?: number
  ): Result<number> {
    return Promise.resolve()
      .then(() => {
        const count = database.clearConversations(userId, chatId);
        auditLog.trace(`Cleared ${count} messages for user ${userId}`);
        return [null, count] as [null, number];
      })
      .catch((e: Error) => {
        const error = createContextError(
          'DB_QUERY_003',
          'Failed to clear conversation history',
          `User ID: ${userId}, Error: ${e.message}`
        );
        auditLog.record(error.code, { userId, chatId, error: e.message });
        return [error, null] as [AppError, null];
      });
  }

  /**
   * Gets the number of messages in history for a user
   */
  async function getMessageCount(
    userId: number,
    chatId?: number
  ): Result<number> {
    return Promise.resolve()
      .then(() => {
        const records = database.getConversations(userId, chatId);
        return [null, records.length] as [null, number];
      })
      .catch((e: Error) => {
        const error = createContextError(
          'DB_QUERY_004',
          'Failed to get message count',
          `User ID: ${userId}, Error: ${e.message}`
        );
        auditLog.record(error.code, { userId, chatId, error: e.message });
        return [error, null] as [AppError, null];
      });
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
