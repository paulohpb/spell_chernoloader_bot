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

  // Initialize the Google Generative AI client
  let genAI: GoogleGenerativeAI;

  // GEMINI_002: Failed to configure Gemini API
  const configureResult = Promise.resolve()
    .then(() => {
      genAI = new GoogleGenerativeAI(apiKey);
    })
    .catch((e: Error) => {
      const error = createLLMError(
        LLM_ERROR_CODES.CONFIGURATION_FAILED,
        'Failed to configure Gemini API',
        e.message
      );
      auditLog.record(error.code, errorToObject(error));
      return error;
    });

  // Since GoogleGenerativeAI constructor doesn't throw normally,
  // we initialize it directly
  genAI = new GoogleGenerativeAI(apiKey);

  auditLog.trace(`Gemini service initialized with model: ${model}`);

  /**
   * Gets a GenerativeModel instance with optional system instruction.
   */
  function getModel(systemInstruction?: string): [AppError | null, GenerativeModel | null] {
    return Promise.resolve()
      .then(() => {
        const modelInstance = genAI.getGenerativeModel({
          model,
          systemInstruction,
          safetySettings: SAFETY_SETTINGS,
        });
        return [null, modelInstance] as [null, GenerativeModel];
      })
      .catch((e: Error) => {
        const error = createLLMError(
          LLM_ERROR_CODES.MODEL_CREATION_FAILED,
          'Failed to create Gemini model',
          e.message
        );
        auditLog.record(error.code, errorToObject(error));
        return [error, null] as [AppError, null];
      }) as unknown as [AppError | null, GenerativeModel | null];
  }

  /**
   * Gets a completion from Gemini.
   * 
   * GEMINI_004: Gemini API request failed
   */
  async function getCompletion(
    messages: ChatMessage[],
    options: CompletionOptions = {}
  ): Result<string> {
    const { maxTokens = 1024, temperature = 0.7 } = options;
    const { history, lastUserMessage, systemInstruction } = convertMessages(messages);

    auditLog.trace(`getCompletion called with ${messages.length} messages`);

    // Get model instance
    const modelResult = await Promise.resolve()
      .then(() => {
        return genAI.getGenerativeModel({
          model,
          systemInstruction,
          safetySettings: SAFETY_SETTINGS,
        });
      })
      .catch((e: Error) => {
        const error = createLLMError(
          LLM_ERROR_CODES.MODEL_CREATION_FAILED,
          'Failed to create Gemini model',
          e.message
        );
        auditLog.record(error.code, errorToObject(error));
        return error;
      });

    if (modelResult instanceof Object && 'code' in modelResult) {
      return [modelResult as AppError, null];
    }

    const generativeModel = modelResult as GenerativeModel;

    // Configure generation settings
    const generationConfig: GenerationConfig = {
      maxOutputTokens: maxTokens,
      temperature,
    };

    // Start chat and send message
    return Promise.resolve()
      .then(async () => {
        const chat: ChatSession = generativeModel.startChat({
          history,
          generationConfig,
        });

        const result = await chat.sendMessage(lastUserMessage);
        const response = result.response;
        const text = response.text();

        auditLog.trace(`getCompletion successful, response length: ${text.length}`);
        return [null, text] as [null, string];
      })
      .catch((e: Error) => {
        const error = createLLMError(
          LLM_ERROR_CODES.REQUEST_FAILED,
          'Gemini API request failed',
          e.message
        );
        auditLog.record(error.code, errorToObject(error));
        return [error, null] as [AppError, null];
      });
  }

  /**
   * Streams a completion from Gemini.
   * 
   * GEMINI_005: Gemini streaming failed
   * 
   * Note: This is an async generator. Errors during streaming are yielded
   * and the generator terminates. Check auditLog for error details.
   */
  async function* streamCompletion(
    messages: ChatMessage[],
    options: CompletionOptions = {},
    chunkCallback?: ChunkCallback
  ): AsyncGenerator<string, void, unknown> {
    const { maxTokens = 1024, temperature = 0.7 } = options;
    const { history, lastUserMessage, systemInstruction } = convertMessages(messages);

    auditLog.trace(`streamCompletion called with ${messages.length} messages`);

    // Get model instance
    let generativeModel: GenerativeModel;
    
    const modelResult = await Promise.resolve()
      .then(() => {
        return genAI.getGenerativeModel({
          model,
          systemInstruction,
          safetySettings: SAFETY_SETTINGS,
        });
      })
      .catch((e: Error) => {
        const error = createLLMError(
          LLM_ERROR_CODES.MODEL_CREATION_FAILED,
          'Failed to create Gemini model',
          e.message
        );
        auditLog.record(error.code, errorToObject(error));
        return error;
      });

    if (modelResult instanceof Object && 'code' in modelResult) {
      // Cannot yield error from generator, log and return
      return;
    }

    generativeModel = modelResult as GenerativeModel;

    // Configure generation settings
    const generationConfig: GenerationConfig = {
      maxOutputTokens: maxTokens,
      temperature,
    };

    // Start chat and stream response
    const chat: ChatSession = generativeModel.startChat({
      history,
      generationConfig,
    });

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

    if (!streamResult) {
      return;
    }

    // Iterate over the stream
    const iterateStream = async function* () {
      for await (const chunk of streamResult.stream) {
        const text = chunk.text();
        if (text) {
          // Call the chunk callback if provided
          if (chunkCallback) {
            const callbackResult = chunkCallback(text);
            // Handle async callbacks
            if (callbackResult instanceof Promise) {
              await callbackResult;
            }
          }
          yield text;
        }
      }
    };

    // Wrap iteration in error handler
    const iterator = iterateStream();
    
    while (true) {
      const next = await iterator.next().catch((e: Error) => {
        const error = createLLMError(
          LLM_ERROR_CODES.STREAMING_FAILED,
          'Gemini streaming failed',
          e.message
        );
        auditLog.record(error.code, errorToObject(error));
        return { done: true, value: undefined };
      });

      if (next.done) {
        break;
      }

      yield next.value as string;
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
