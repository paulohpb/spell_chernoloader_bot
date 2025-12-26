/**
 * =============================================================================
 * Error utilities for the AI Assistant module
 * Provides functional error handling helpers
 * =============================================================================
 */

import { AppError, ErrorCategory } from './types';

/**
 * LLM Service Error Codes (preserved from Python implementation)
 * 
 * GEMINI_001: API key is required
 * GEMINI_002: Failed to configure Gemini API
 * GEMINI_003: Failed to create Gemini model
 * GEMINI_004: Gemini API request failed
 * GEMINI_005: Gemini streaming failed
 */
export const LLM_ERROR_CODES = {
  API_KEY_REQUIRED: 'GEMINI_001',
  CONFIGURATION_FAILED: 'GEMINI_002',
  MODEL_CREATION_FAILED: 'GEMINI_003',
  REQUEST_FAILED: 'GEMINI_004',
  STREAMING_FAILED: 'GEMINI_005',
} as const;

/**
 * Creates an AppError with LLM category
 */
export function createLLMError(
  code: string,
  message: string,
  details?: string
): AppError {
  return {
    code,
    category: 'LLM',
    message,
    details,
  };
}

/**
 * Creates an AppError with CONFIGURATION category
 */
export function createConfigError(
  code: string,
  message: string,
  details?: string
): AppError {
  return {
    code,
    category: 'CONFIGURATION',
    message,
    details,
  };
}

/**
 * Formats an AppError for logging/display
 */
export function formatError(error: AppError): string {
  let formatted = `[${error.code}] [${error.category}] ${error.message}`;
  if (error.details) {
    formatted += ` | Details: ${error.details}`;
  }
  return formatted;
}

/**
 * Converts an AppError to a plain object for serialization
 */
export function errorToObject(error: AppError): Record<string, unknown> {
  return {
    code: error.code,
    category: error.category,
    message: error.message,
    details: error.details,
  };
}
