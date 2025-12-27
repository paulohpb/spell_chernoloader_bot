/**
 * =============================================================================
 * AI Handler - Manages AI interactions
 * 
 * Handles messages directed to the bot, maintains conversation context,
 * and generates responses using the Gemini service.
 * =============================================================================
 */

import { Context } from 'grammy';
import { AppError } from '../../assistant/types';
import { GeminiService } from '../../assistant/types';
import { ContextService } from '../../assistant/context'; // Import ContextService type
import { auditLog } from '../../assistant/audit-log';

import axios from 'axios'; // Add axios import

/**
 * AI handler configuration
 */
export interface AIHandlerConfig {
  geminiService: GeminiService;
  contextService: ContextService;
  botUsername: string;
  systemPrompt?: string;
  token: string; // Add token for file download
}

/**
 * AI handler interface
 */
export interface AIHandler {
  handleMessage: (ctx: Context) => Promise<void>;
}

/**
 * Creates the AI handler.
 */
export function createAIHandler(config: AIHandlerConfig): AIHandler {
  const { geminiService, contextService, botUsername, systemPrompt, token } = config;

  /**
   * Patterns that indicate a jailbreak attempt or suspicious prompting
   */
  const JAILBREAK_PATTERNS = [
    /ignore (todas )?(as )?instruções/i,
    /ignore all instructions/i,
    /esqueça (toda )?(a )?sua programação/i,
    /forget all your instructions/i,
    /modo (desenvolvedor|developer|dev)/i,
    /agora você é/i,
    /aja como/i,
    /simule um/i,
    /você não tem (regras|limites)/i,
    /dan mode/i,
    /do anything now/i
  ];

  /**
   * Checks if the message is directed to the bot.
   */
  function isDirectedToBot(ctx: Context): boolean {
    if (!ctx.message) return false;

    const text = ctx.message.text || ctx.message.caption || '';
    const isPrivate = ctx.chat?.type === 'private';
    const isReplyToBot = ctx.message.reply_to_message?.from?.username === botUsername.replace('@', '');
    const hasMention = text.includes(botUsername);

    // In private chats, all messages are directed to the bot
    // In groups, only mentions or replies to the bot
    return isPrivate || isReplyToBot || hasMention;
  }

  /**
   * Handles incoming messages for AI processing
   */
  async function handleMessage(ctx: Context): Promise<void> {
    // 1. Validation
    if (!ctx.message) return;
    
    // Check text OR caption
    const text = ctx.message.text || ctx.message.caption || '';
    const hasPhoto = !!ctx.message.photo;

    // Filter out Social Media links (Media handler will handle them)
    const MEDIA_LINK_REGEX = /(instagram\.com|x\.com|twitter\.com|youtube\.com|youtu\.be)/i;
    
    if (MEDIA_LINK_REGEX.test(text)) {
        // If it contains a link, check if there's actual conversation with it
        const textWithoutLinks = text.replace(/https?:\/\/\S+/g, '').trim();
        
        // If the remaining text is very short (just the link or generic words), ignore it.
        // Let the MediaHandler do the work without Zauber commenting "I can't click links".
        if (textWithoutLinks.length < 5) {
            return; 
        }
    }

    // Check if we should process this message
    // If it has a photo, we assume it might be for the bot if it has a caption or if it's in private
    if (!hasPhoto && !text) return; // Nothing to process

    // Logic to check if directed to bot needs to handle caption too
    // Reuse isDirectedToBot logic but adapted since we might not have 'text' but 'caption'
    const isPrivate = ctx.chat?.type === 'private';
    const isReplyToBot = ctx.message.reply_to_message?.from?.username === botUsername.replace('@', '');
    const hasMention = text.includes(botUsername);

    if (!isPrivate && !isReplyToBot && !hasMention && !hasPhoto) return;
    // If it's a photo in a group without mention, maybe ignore? 
    // Let's stick to strict rules: must mention bot even with photo in groups.
    if (!isPrivate && !isReplyToBot && !hasMention) return;

    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    const messageId = ctx.message.message_id;

    if (!chatId || !userId) return;

    // 2. Image Processing
    let imageBuffer: Buffer | undefined;
    let mimeType: string | undefined;

    if (hasPhoto) {
        try {
            await ctx.replyWithChatAction('upload_photo'); // Indicate we are processing
            const photos = ctx.message.photo!;
            const bestPhoto = photos[photos.length - 1]; // Highest resolution
            
            const file = await ctx.api.getFile(bestPhoto.file_id);
            if (file.file_path) {
                const downloadUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
                const response = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
                imageBuffer = Buffer.from(response.data);
                mimeType = 'image/jpeg'; // Telegram photos are usually JPEGs
            }
        } catch (e) {
            console.error('Failed to download photo:', e);
            await ctx.reply('⚠️ Não consegui baixar a imagem.');
            return;
        }
    }

    // 3. Prepare Context (History)
    const cleanText = text.replace(new RegExp(botUsername, 'g'), '').trim();
    const storageText = hasPhoto ? `[Imagem enviada pelo usuário] ${cleanText}` : cleanText;

    // Check for Jailbreak
    for (const pattern of JAILBREAK_PATTERNS) {
        if (pattern.test(cleanText)) {
            auditLog.record('AI_JAILBREAK_ATTEMPT', { userId, text: cleanText });
            await ctx.reply('Nem a pau.', { reply_parameters: { message_id: messageId } });
            return;
        }
    }
    
    // Add to history (Text only for persistence)
    const [addError] = await contextService.addMessage(userId, chatId, 'user', storageText);

    if (addError) {
      auditLog.record('AI_CTX_ADD_FAIL', { error: addError.message });
    }

    // Retrieve history
    const [historyError, history] = await contextService.loadHistory(userId, chatId);
    
    if (historyError || !history) {
      await ctx.reply('⚠️ Erro ao acessar memória.');
      return;
    }

    // Format for API
    const apiMessages = contextService.getMessagesForApi(history, systemPrompt);

    // INJECT IMAGE into the last message for the AI
    // The last message in 'apiMessages' corresponds to the one we just added.
    if (imageBuffer && mimeType && apiMessages.length > 0) {
        const lastMsg = apiMessages[apiMessages.length - 1];
        // Ensure it's the user's message we just added
        if (lastMsg.role === 'user') {
            lastMsg.images = [{
                data: imageBuffer,
                mimeType: mimeType
            }];
            // We can also update the content to be just the caption if we want, 
            // but keeping the "[Imagem...]" marker is fine, or revert to cleanText
            lastMsg.content = cleanText || "O que tem nesta imagem?"; 
        }
    }

    // 4. Generate Response
    await ctx.replyWithChatAction('typing');

    const [llmError, responseText] = await geminiService.getCompletion(apiMessages);

    if (llmError || !responseText) {
      await ctx.reply('🤯 Tive um problema para processar isso.');
      auditLog.record(llmError?.code || 'AI_GEN_FAIL', { error: llmError?.message });
      return;
    }

    // 5. Send Response & Update Context
    const sentMsg = await ctx.reply(responseText, {
        parse_mode: 'Markdown',
        reply_parameters: { message_id: messageId }
    }).catch(async () => {
        return await ctx.reply(responseText, {
            reply_parameters: { message_id: messageId }
        });
    });

    if (sentMsg) {
      await contextService.addMessage(userId, chatId, 'assistant', responseText);
    }
  }

  return {
    handleMessage,
  };
}
