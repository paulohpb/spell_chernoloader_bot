/**
 * =============================================================================
 * Types for the AI Assistant module
 * =============================================================================
 */

/**
 * Error categories for classification
 */
export type ErrorCategory =
  | 'CONFIGURATION'
  | 'LLM'
  | 'UNKNOWN';

/**
 * Application error type for functional error handling.
 * Wraps legacy LLMServiceError codes.
 */
export interface AppError {
  code: string;
  category: ErrorCategory;
  message: string;
  details?: string;
}

/**
 * Result type for async operations.
 * First element is error (or null), second is result (or null).
 */
export type Result<T> = Promise<[AppError | null, T | null]>;

/**
 * Message format for LLM conversations (OpenAI-compatible format)
 * Extended to support images for Vision models.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  images?: {
    data: Buffer;
    mimeType: string;
  }[];
}

/**
 * Configuration options for completions
 */
export interface CompletionOptions {
  maxTokens?: number;
  temperature?: number;
}

/**
 * Callback for streaming chunks
 */
export type ChunkCallback = (chunk: string) => void | Promise<void>;

/**
 * Gemini service configuration
 */
export interface GeminiServiceConfig {
  apiKey: string;
  model?: string;
}

/**
 * Gemini service interface (returned by factory)
 */
export interface GeminiService {
  getCompletion: (
    messages: ChatMessage[],
    options?: CompletionOptions
  ) => Result<string>;

  streamCompletion: (
    messages: ChatMessage[],
    options?: CompletionOptions,
    chunkCallback?: ChunkCallback
  ) => AsyncGenerator<string, void, unknown>;

  getModelName: () => string;
}
