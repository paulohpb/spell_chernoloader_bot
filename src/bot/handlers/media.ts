/**
 * =============================================================================
 * Media Handler - Social media link scraping and video embedding
 * 
 * Handles Instagram and Twitter/X links, downloads videos, and re-uploads
 * them to the chat for better embedding.
 * =============================================================================
 */

import { Context, InputFile, InlineKeyboard } from 'grammy';
import axios, { AxiosError } from 'axios';
import ytdl from '@distube/ytdl-core'; // YouTube Library
const instagramGetUrl = require('instagram-url-direct'); // Local Fallback
import { AppError, Result } from '../../assistant/types';
import { auditLog } from '../../assistant/audit-log';

/**
 * Media handler error codes
 */
export const MEDIA_ERROR_CODES = {
  INSTAGRAM_FETCH_FAILED: 'MEDIA_001',
  TWITTER_FETCH_FAILED: 'MEDIA_002',
  VIDEO_DOWNLOAD_FAILED: 'MEDIA_003',
  VIDEO_NOT_FOUND: 'MEDIA_004',
  SEND_VIDEO_FAILED: 'MEDIA_005',
  YOUTUBE_FETCH_FAILED: 'MEDIA_006',
} as const;

/**
 * Media information extracted from social platforms
 */
interface MediaInfo {
  videoUrl: string;
  caption?: string;
  author?: string;
  typename?: string;
}

/**
 * Configuration for media handler
 */
export interface MediaHandlerConfig {
  targetGroupId: number;
}

/**
 * Media handler interface
 */
export interface MediaHandler {
  handleMessage: (ctx: Context) => Promise<void>;
}

/**
 * HTTP headers for scraping requests
 * Simulates a real browser to avoid being blocked by Instagram/Twitter
 */
const SCRAPE_HEADERS = {
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
  'accept-language': 'en-US,en;q=0.9',
  'connection': 'close',
  'sec-fetch-mode': 'navigate',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'viewport-width': '1280',
};

/**
 * Regex patterns for social media links
 */
const IG_LINK_REGEX = /((?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)[^ \n]*)/;
const X_LINK_REGEX = /((?:https?:\/\/)?(?:twitter\.com|x\.com)\/([A-Za-z0-9_]+)\/status\/([0-9]+)[^ \n]*)/;
const YT_LINK_REGEX = /((?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})[^ \n]*)/;

/**
 * Helper to escape Markdown special characters to prevent broken formatting
 */
function escapeMarkdown(text: string): string {
  if (!text) return '';
  // Escapes: _ * [ ] ( ) ~ ` > # + - = | { } . !
  return text.replace(/[_*[\\\\]()~`>#+\-=|"{}.!]/g, '\\$&');
}

/**
 * Helper to truncate text
 */
function truncateText(text: string, limit: number = 900): string {
  if (text.length <= limit) return text;
  return text.substring(0, limit - 3) + '...';
}

/**
 * Creates a media error
 */
function createMediaError(code: string, message: string, details?: string): AppError {
  return {
    code,
    category: 'LLM', // Using LLM as a general "service" category
    message,
    details,
  };
}

/**
 * List of public Cobalt instances for failover
 */
const COBALT_INSTANCES = [
  'https://co.wuk.sh/api/json',
  'https://cobalt.kwiatekmiki.pl/api/json',
  'https://tools.adithya.ip/api/json',
  'https://cobalt.q1.pm/api/json',
  'https://api.cobalt.tools/api/json' // Official as last resort
];

/**
 * Fetches Instagram media information using Cobalt API with Failover
 */
async function fetchInstagramMedia(fullUrl: string): Result<MediaInfo> {
  let lastError: Error | null = null;

  // 1. Try Cobalt Instances
  for (const cobaltUrl of COBALT_INSTANCES) {
    try {
      console.log(`Trying Cobalt instance: ${cobaltUrl}`);
      
      const response = await axios.post(
        cobaltUrl, 
        {
            url: fullUrl,
            vCodec: 'h264', // IMPORTANT: Forces h264 which is better compatible with Telegram
            filenamePattern: 'basic',
            disableMetadata: true // Reduces payload size and parsing errors
        },
        {
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            // IMPORTANT: Use a real browser User-Agent
            'User-Agent': SCRAPE_HEADERS['User-Agent']
          },
          timeout: 8000 // Increased timeout slightly
        }
      );

      const data = response.data;

      if (data.status === 'error') {
        // console.warn(`Instance ${cobaltUrl} returned error: ${data.text}`);
        throw new Error(data.text || 'Cobalt API error');
      }

      let videoUrl: string | undefined;
      
      if (data.url) {
          videoUrl = data.url;
      } else if (data.picker && data.picker.length > 0) {
          const item = data.picker.find((i: any) => i.type === 'video') || data.picker[0];
          videoUrl = item.url;
      }

      if (videoUrl) {
        auditLog.trace(`Instagram video found via ${cobaltUrl}`);
        return [null, { 
            videoUrl, 
            typename: 'CobaltVideo',
            caption: data.filename || undefined 
        }];
      }
      
    } catch (e: any) {
      lastError = e;
      // Continue to next instance
    }
  }

  // 2. Try Local Fallback (instagram-url-direct)
  try {
      console.log('Cobalt failed, trying local fallback (instagram-url-direct)...');
      const response = await instagramGetUrl(fullUrl);
      
      if (response.url_list && response.url_list.length > 0) {
          auditLog.trace(`Instagram video found via Local Fallback`);
          return [null, {
              videoUrl: response.url_list[0],
              typename: 'LocalFallback'
          }];
      }
  } catch (localError: any) {
      console.error('Local fallback failed:', localError.message);
  }

  // All methods failed
  const errorMsg = lastError?.message || 'All fetch methods failed';
  console.error('All fetch methods failed for URL:', fullUrl);
  
  const error = createMediaError(
    MEDIA_ERROR_CODES.INSTAGRAM_FETCH_FAILED,
    'Failed to fetch Instagram media (All mirrors & local failed)',
    errorMsg
  );
  return [error, null];
}

/**
 * Fetches Twitter/X media information
 */
async function fetchTwitterMedia(username: string, tweetId: string): Result<MediaInfo> {
  const apiUrl = `https://api.fxtwitter.com/${username}/status/${tweetId}`;

  const result = await axios.get(apiUrl, { headers: SCRAPE_HEADERS })
    .then((response): [null, any] => [null, response.data])
    .catch((e: AxiosError): [AppError, null] => {
      const error = createMediaError(
        MEDIA_ERROR_CODES.TWITTER_FETCH_FAILED,
        'Failed to fetch Twitter/X media',
        e.message
      );
      return [error, null];
    });

  if (result[0]) {
    auditLog.record(result[0].code, { username, tweetId, error: result[0].message });
    return [result[0], null];
  }

  const data = result[1];
  
  if (!data?.tweet?.media?.videos?.length) {
    const error = createMediaError(
      MEDIA_ERROR_CODES.VIDEO_NOT_FOUND,
      'No video found in tweet',
      tweetId
    );
    auditLog.record(error.code, { username, tweetId });
    return [error, null];
  }

  auditLog.trace(`Twitter video found for tweet ${tweetId}`);
  return [null, {
    videoUrl: data.tweet.media.videos[0].url,
    caption: data.tweet.text,
    author: data.tweet.author?.name || data.tweet.author?.screen_name || username,
  }];
}

/**
 * Downloads video from URL
 */
async function downloadVideo(url: string): Result<Buffer> {
  const result = await axios.get(url, { 
    responseType: 'arraybuffer', 
    headers: SCRAPE_HEADERS 
  })
    .then((response): [null, Buffer] => [null, Buffer.from(response.data)])
    .catch((e: AxiosError): [AppError, null] => {
      const error = createMediaError(
        MEDIA_ERROR_CODES.VIDEO_DOWNLOAD_FAILED,
        'Failed to download video',
        e.message
      );
      return [error, null];
    });

  if (result[0]) {
    auditLog.record(result[0].code, { url: url.substring(0, 100), error: result[0].message });
  }

  return result;
}

/**
 * Handles Instagram link in message
 */
async function handleInstagram(ctx: Context, fullUrl: string, postId: string): Promise<void> {
  const statusMsg = await ctx.reply('🔎 Procurando vídeo no Instagram...', { 
    reply_parameters: { message_id: ctx.message!.message_id } 
  });

  const [mediaError, media] = await fetchInstagramMedia(fullUrl);

  if (mediaError || !media) {
    const errorMsg = mediaError?.details || 'Erro desconhecido';
    await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, `❌ Vídeo não encontrado.\n\n_(Log: ${errorMsg})_`, { parse_mode: 'Markdown' })
      .catch(() => {});
    return;
  }

  const [downloadError, videoBuffer] = await downloadVideo(media.videoUrl);

  if (downloadError || !videoBuffer) {
    await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, '⚠️ Erro ao baixar o arquivo.')
      .catch(() => {});
    return;
  }

  await ctx.replyWithChatAction('upload_video');

  // Construct structured caption
  const authorLine = media.author ? `👤 *${escapeMarkdown(media.author)}*\n` : '';
  const captionLine = media.caption ? `${escapeMarkdown(truncateText(media.caption))}` : '';
  
  const finalCaption = (authorLine + captionLine).trim() || '🎥 Vídeo do Instagram';

  const keyboard = new InlineKeyboard().url('Open in Instagram ↗️', fullUrl);

  const sendResult = await ctx.replyWithVideo(
    new InputFile(videoBuffer, `insta_${postId}.mp4`),
    {
        caption: finalCaption,
        parse_mode: 'MarkdownV2',
        reply_markup: keyboard
    }
  )
    .then((): [null, true] => [null, true])
    .catch((e: Error): [AppError, null] => {
      const error = createMediaError(
        MEDIA_ERROR_CODES.SEND_VIDEO_FAILED,
        'Failed to send video',
        e.message
      );
      return [error, null];
    });

  if (sendResult[0]) {
    auditLog.record(sendResult[0].code, { postId, error: sendResult[0].message });
    await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, '⚠️ Erro ao enviar vídeo para o chat.')
      .catch(() => {});
    return;
  }

  await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});
  auditLog.trace(`Instagram video sent successfully for post ${postId}`);
}

/**
 * Handles Twitter/X link in message
 */
async function handleTwitter(ctx: Context, fullUrl: string, username: string, tweetId: string): Promise<void> {
  const statusMsg = await ctx.reply('🔎 Procurando vídeo no X...', { 
    reply_parameters: { message_id: ctx.message!.message_id } 
  });

  const [mediaError, media] = await fetchTwitterMedia(username, tweetId);

  if (mediaError || !media) {
    await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, '❌ Vídeo não encontrado.')
      .catch(() => {});
    return;
  }

  const [downloadError, videoBuffer] = await downloadVideo(media.videoUrl);

  if (downloadError || !videoBuffer) {
    await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, '⚠️ Erro ao baixar.')
      .catch(() => {});
    return;
  }

  await ctx.replyWithChatAction('upload_video');

  // Construct structured caption
  const authorName = media.author || username;
  const authorLine = `👤 *${escapeMarkdown(authorName)}*\n`;
  const captionLine = media.caption ? `${escapeMarkdown(truncateText(media.caption))}` : '';
  
  const finalCaption = (authorLine + captionLine).trim();

  const keyboard = new InlineKeyboard().url('Open in X ↗️', fullUrl);

  const sendResult = await ctx.replyWithVideo(
    new InputFile(videoBuffer, `x_${tweetId}.mp4`),
    {
      caption: finalCaption,
      parse_mode: 'MarkdownV2',
      reply_markup: keyboard
    }
  )
    .then((): [null, true] => [null, true])
    .catch((e: Error): [AppError, null] => {
      const error = createMediaError(
        MEDIA_ERROR_CODES.SEND_VIDEO_FAILED,
        'Failed to send video',
        e.message
      );
      return [error, null];
    });

  if (sendResult[0]) {
    auditLog.record(sendResult[0].code, { tweetId, error: sendResult[0].message });
    await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, '⚠️ Erro ao enviar vídeo.')
      .catch(() => {});
    return;
  }

  await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});
  auditLog.trace(`Twitter video sent successfully for tweet ${tweetId}`);
}

/**
 * Handles YouTube link in message
 */
async function handleYoutube(ctx: Context, fullUrl: string, videoId: string): Promise<void> {
    const statusMsg = await ctx.reply('🔎 Acessando YouTube...', { 
      reply_parameters: { message_id: ctx.message!.message_id } 
    });
  
    try {
      const url = fullUrl.startsWith('http') ? fullUrl : `https://www.youtube.com/watch?v=${videoId}`;
      const info = await ytdl.getInfo(url);
      const formats = ytdl.filterFormats(info.formats, 'audioandvideo');
      
      let format = formats.find(f => f.qualityLabel === '720p');
      if (!format) format = formats.find(f => f.qualityLabel === '360p');
      if (!format) {
          formats.sort((a, b) => (b.height || 0) - (a.height || 0));
          format = formats.find(f => (f.height || 0) <= 1080);
      }
      if (!format && formats.length > 0) format = formats[formats.length - 1]; 

      if (!format) {
          await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, '❌ Formato compatível não encontrado.');
          return;
      }

      if (format.contentLength && parseInt(format.contentLength) > 52428800) {
          await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, '⚠️ Vídeo muito grande (>50MB).');
          return;
      }

      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, `⬇️ Baixando: ${info.videoDetails.title}...`);
      await ctx.replyWithChatAction('upload_video');

      const stream = ytdl(url, { format: format });
      
      // Construct Caption
      const authorLine = `👤 *${escapeMarkdown(info.videoDetails.author.name)}*\n`;
      const titleLine = escapeMarkdown(truncateText(info.videoDetails.title));
      const finalCaption = authorLine + titleLine;

      // Create Button
      const keyboard = new InlineKeyboard().url('Open in YouTube ↗️', url);

      await ctx.replyWithVideo(new InputFile(stream), { 
          caption: finalCaption,
          parse_mode: 'MarkdownV2',
          reply_markup: keyboard
      });

      await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});
    } catch (e: any) {
        auditLog.record(MEDIA_ERROR_CODES.YOUTUBE_FETCH_FAILED, { videoId, error: e.message });
        await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, '⚠️ Erro no YouTube.').catch(() => {});
    }
}

/**
 * Creates the media handler.
 */
export function createMediaHandler(config: MediaHandlerConfig): MediaHandler {
  const { targetGroupId } = config;

  async function handleMessage(ctx: Context): Promise<void> {
    if (!ctx.message) return;
    const text = ctx.message.text || ctx.message.caption || '';
    if (!text) return;

    if (ctx.chat?.type !== 'private' && ctx.chat?.id !== targetGroupId) return;

    const igMatch = text.match(IG_LINK_REGEX);
    if (igMatch && igMatch[1]) {
      await handleInstagram(ctx, igMatch[1], igMatch[2]);
      return;
    }

    const xMatch = text.match(X_LINK_REGEX);
    if (xMatch && xMatch[1]) {
      await handleTwitter(ctx, xMatch[1], xMatch[2], xMatch[3]);
      return;
    }

    const ytMatch = text.match(YT_LINK_REGEX);
    if (ytMatch && ytMatch[1]) {
        await handleYoutube(ctx, ytMatch[1], ytMatch[2]);
        return;
    }
  }

  return { handleMessage };
}
