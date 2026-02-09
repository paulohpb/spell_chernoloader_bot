/**
 * =============================================================================
 * Gemini Service - Factory function for Google Gemini API interactions
 * 
 * Ported from Python: telegram_ai_bot_A/services/gemini_service.py
 * 
 * Error codes preserved:
 *   GEMINI_001: API key is required
 *   GEMINI_002: Failed to configure Gemini API
 *   GEMINI_003: Failed to create Gemini model
 *   GEMINI_004: Gemini API request failed
 *   GEMINI_005: Gemini streaming failed
 * =============================================================================
 */

import {
  GoogleGenerativeAI,
  GenerativeModel,
  Content,
  GenerationConfig,
  ChatSession,
  HarmCategory,
  HarmBlockThreshold,
} from '@google/generative-ai';

import {
  AppError,
  ChatMessage,
  CompletionOptions,
  ChunkCallback,
  GeminiService,
  GeminiServiceConfig,
  Result,
} from '../types';

import { LLM_ERROR_CODES, createLLMError, createConfigError, errorToObject } from '../errors';
import { auditLog } from '../audit-log';

/**
 * Standard Safety Settings for the Bot
 * Blocks content with Medium or High probability of being harmful.
 */
const SAFETY_SETTINGS = [
  {
    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
  },
];

/**
 * Converts OpenAI-style messages to Gemini format.
 * 
 * Returns:
 *   - history: Previous conversation turns for chat context
 *   - lastUserMessage: The final user prompt to send (text or parts)
 *   - systemInstruction: System prompt (if present)
 */
function convertMessages(
  messages: ChatMessage[]
): {
  history: Content[];
  lastUserMessage: string | Array<string | any>; // 'any' used to avoid Part import issues, but functionally correct
  systemInstruction: string | undefined;
} {
  const history: Content[] = [];
  let systemInstruction: string | undefined = undefined;
  let lastUserMessage: string | Array<string | any> = '';

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const role = msg.role;
    const content = msg.content;
    
    // Construct parts
    const parts: any[] = [{ text: content }];
    
    // Add images if present
    if (msg.images && msg.images.length > 0) {
      for (const img of msg.images) {
        parts.push({
          inlineData: {
            data: img.data.toString('base64'),
            mimeType: img.mimeType,
          },
        });
      }
    }

    if (role === 'system') {
      systemInstruction = content;
    } else if (role === 'user') {
      if (i === messages.length - 1) {
        // Last message is the prompt we'll send
        // If we have only text, send string (simpler), otherwise send parts
        if (parts.length === 1 && parts[0].text) {
          lastUserMessage = parts[0].text;
        } else {
          lastUserMessage = parts;
        }
      } else {
        history.push({ role: 'user', parts });
      }
    } else if (role === 'assistant') {
      history.push({ role: 'model', parts });
    }
  }

  return { history, lastUserMessage, systemInstruction };
}

/**
 * Creates a Gemini service instance.
 * 
 * Factory function pattern - returns a closure of methods.
 * API key must be passed in as an argument (not read from env deep inside).
 * 
 * @param config - Service configuration including API key and optional model name
 * @returns Result tuple with [error, service] - error if initialization fails
 */
export function createGeminiService(
  config: GeminiServiceConfig
): [AppError | null, GeminiService | null] {
  const { apiKey, model = 'gemini-1.5-flash' } = config;

  // GEMINI_001: API key is required
  if (!apiKey) {
    const error = createConfigError(
      LLM_ERROR_CODES.API_KEY_REQUIRED,
      'Gemini API key is required'
    );
    auditLog.record(error.code, errorToObject(error));
    return [error, null];
  }

  // Initialize the Google Generative AI client.
  // The constructor is synchronous and does not throw under normal
  // conditions — it only validates that the key is a non-empty string,
  // which we already checked above.
  const genAI = new GoogleGenerativeAI(apiKey);

  auditLog.trace(`Gemini service initialized with model: ${model}`);

  /**
   * Instantiates a {@link GenerativeModel} with the given system
   * instruction and the module-level safety settings.
   * Shared by {@link getCompletion} and {@link streamCompletion}.
   *
   * @param systemInstruction - Optional system prompt forwarded to the model.
   * @returns A result tuple: `[null, model]` on success, `[error, null]` on failure.
   */
  function resolveModel(systemInstruction?: string): [AppError | null, GenerativeModel | null] {
    try {
      const instance = genAI.getGenerativeModel({
        model,
        systemInstruction,
        safetySettings: SAFETY_SETTINGS,
      });
      return [null, instance];
    } catch (e: unknown) {
      const error = createLLMError(
        LLM_ERROR_CODES.MODEL_CREATION_FAILED,
        'Failed to create Gemini model',
        (e as Error).message,
      );
      auditLog.record(error.code, errorToObject(error));
      return [error, null];
    }
  }

  /**
   * Gets a completion from Gemini.
   *
   * GEMINI_004: Gemini API request failed
   *
   * @param messages - Conversation history in OpenAI-compatible format.
   * @param options  - Token / temperature overrides.
   * @returns Result tuple with the completion text or an error.
   */
  async function getCompletion(
    messages: ChatMessage[],
    options: CompletionOptions = {}
  ): Result<string> {
    const { maxTokens = 1024, temperature = 0.7 } = options;
    const { history, lastUserMessage, systemInstruction } = convertMessages(messages);

    auditLog.trace(`getCompletion called with ${messages.length} messages`);

    const [modelError, generativeModel] = resolveModel(systemInstruction);
    if (modelError || !generativeModel) return [modelError, null];

    const generationConfig: GenerationConfig = { maxOutputTokens: maxTokens, temperature };

    try {
      const chat: ChatSession = generativeModel.startChat({ history, generationConfig });
      const result = await chat.sendMessage(lastUserMessage);
      const text = result.response.text();

      auditLog.trace(`getCompletion successful, response length: ${text.length}`);
      return [null, text];
    } catch (e: unknown) {
      const error = createLLMError(
        LLM_ERROR_CODES.REQUEST_FAILED,
        'Gemini API request failed',
        (e as Error).message,
      );
      auditLog.record(error.code, errorToObject(error));
      return [error, null];
    }
  }

  /**
   * Streams a completion from Gemini as an async generator.
   *
   * GEMINI_005: Gemini streaming failed
   *
   * Errors during streaming are logged to the audit log and the
   * generator terminates silently — the caller should treat an early
   * end as a failure.
   *
   * @param messages       - Conversation history in OpenAI-compatible format.
   * @param options        - Token / temperature overrides.
   * @param chunkCallback  - Optional per-chunk hook (e.g. for live message edits).
   */
  async function* streamCompletion(
    messages: ChatMessage[],
    options: CompletionOptions = {},
    chunkCallback?: ChunkCallback
  ): AsyncGenerator<string, void, unknown> {
    const { maxTokens = 1024, temperature = 0.7 } = options;
    const { history, lastUserMessage, systemInstruction } = convertMessages(messages);

    auditLog.trace(`streamCompletion called with ${messages.length} messages`);

    const [modelError, generativeModel] = resolveModel(systemInstruction);
    if (modelError || !generativeModel) return;

    const generationConfig: GenerationConfig = { maxOutputTokens: maxTokens, temperature };

    const chat: ChatSession = generativeModel.startChat({ history, generationConfig });

    const streamResult = await chat.sendMessageStream(lastUserMessage)
      .catch((e: Error) => {
        const error = createLLMError(
          LLM_ERROR_CODES.STREAMING_FAILED,
          'Gemini streaming failed',
          e.message
        );
        auditLog.record(error.code, errorToObject(error));
        return null;
      });

    if (!streamResult) return;

    // Iterate over the stream with per-chunk error handling.
    for await (const chunk of streamResult.stream) {
      const text = chunk.text();
      if (!text) continue;

      if (chunkCallback) {
        const callbackResult = chunkCallback(text);
        if (callbackResult instanceof Promise) await callbackResult;
      }

      yield text;
    }

    auditLog.trace('streamCompletion finished');
  }

  /**
   * Returns the model name being used.
   */
  function getModelName(): string {
    return model;
  }

  // Return the service interface
  const service: GeminiService = {
    getCompletion,
    streamCompletion,
    getModelName,
  };

  return [null, service];
}
