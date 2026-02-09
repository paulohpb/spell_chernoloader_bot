/**
 * =============================================================================
 * AI Assistant Module - Public API
 * =============================================================================
 */

// Types
export type {
  AppError,
  ErrorCategory,
  Result,
  ChatMessage,
  CompletionOptions,
  ChunkCallback,
  GeminiServiceConfig,
  GeminiService,
} from './types';

// Error utilities
export {
  LLM_ERROR_CODES,
  createLLMError,
  createConfigError,
  formatError,
  errorToObject,
} from './errors';

// Audit logging
export { auditLog } from './audit-log';
export type { AuditLog, AuditLogEntry } from './audit-log';

// Services
export { createGeminiService } from './services/gemini.service';

// Context service — currently unused by any handler; kept on disk for future
// use but intentionally not re-exported here to avoid dead-surface confusion.
// Re-add the line below when a handler starts consuming it:
//   export { createContextService, CONTEXT_ERROR_CODES } from './context';
//   export type { ContextService, ContextServiceConfig, ConversationMessage } from './context';
