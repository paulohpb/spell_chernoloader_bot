/**
 * =============================================================================
 * Media Handler - Social media link scraping and video embedding
 * 
 * Handles Instagram and Twitter/X links, downloads videos, and re-uploads
 * them to the chat for better embedding.
 * =============================================================================
 */

import { Context, InputFile } from 'grammy';
import axios, { AxiosError } from 'axios';
import { AppError, Result } from '../../assistant/types';
import { auditLog } from '../../assistant/audit-log';
import { BotConfig } from '../../config';

/**
 * Media handler error codes
 */
export const MEDIA_ERROR_CODES = {
  INSTAGRAM_FETCH_FAILED: 'MEDIA_001',
  TWITTER_FETCH_FAILED: 'MEDIA_002',
  VIDEO_DOWNLOAD_FAILED: 'MEDIA_003',
  VIDEO_NOT_FOUND: 'MEDIA_004',
  SEND_VIDEO_FAILED: 'MEDIA_005',
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
 */
const SCRAPE_HEADERS = {
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
  'accept-language': 'en-US,en;q=0.9',
  'connection': 'close',
  'sec-fetch-mode': 'navigate',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'viewport-width': '1280',
};

/**
 * Regex patterns for social media links
 */
const IG_LINK_REGEX = /(?:instagram\.com)\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/;
const X_LINK_REGEX = /(?:twitter\.com|x\.com)\/([A-Za-z0-9_]+)\/status\/([0-9]+)/;

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
 * Fetches Instagram media information
 */
async function fetchInstagramMedia(postId: string): Result<MediaInfo> {
  const embedUrl = `https://www.instagram.com/p/${postId}/embed/captioned/`;

  // Try embed URL first
  const embedResult = await axios.get(embedUrl, { headers: SCRAPE_HEADERS })
    .then((response): [null, string] => [null, response.data as string])
    .catch((e: AxiosError): [AppError, null] => {
      const error = createMediaError(
        MEDIA_ERROR_CODES.INSTAGRAM_FETCH_FAILED,
        'Failed to fetch Instagram embed',
        e.message
      );
      return [error, null];
    });

  if (embedResult[0]) {
    auditLog.record(embedResult[0].code, { postId, error: embedResult[0].message });
    // Don't return yet, try fallback
  }

  if (embedResult[1]) {
    const html = embedResult[1];
    const videoUrlMatch = html.match(/video_url\\?"\s*:\s*\\?"([^"]+)/);
    
    if (videoUrlMatch && videoUrlMatch[1]) {
      let videoUrl = videoUrlMatch[1];
      if (videoUrl.endsWith('\\')) videoUrl = videoUrl.slice(0, -1);
      videoUrl = videoUrl.replace(/\\u([0-9a-fA-F]{4})/g, (_match, p1) => 
        String.fromCharCode(parseInt(p1, 16))
      );
      videoUrl = videoUrl.replace(/\\/g, '');
      
      auditLog.trace(`Instagram video found via embed for post ${postId}`);
      return [null, { videoUrl, typename: 'GraphVideo' }];
    }
  }

  // Fallback: try main reel URL
  const mainUrl = `https://www.instagram.com/reel/${postId}/`;
  
  const mainResult = await axios.get(mainUrl, { headers: SCRAPE_HEADERS })
    .then((response): [null, string] => [null, response.data as string])
    .catch((e: AxiosError): [AppError, null] => {
      const error = createMediaError(
        MEDIA_ERROR_CODES.INSTAGRAM_FETCH_FAILED,
        'Failed to fetch Instagram reel',
        e.message
      );
      return [error, null];
    });

  if (mainResult[0]) {
    auditLog.record(mainResult[0].code, { postId, error: mainResult[0].message });
    return [mainResult[0], null];
  }

  const mainHtml = mainResult[1]!;
  
  // Extract video URL
  const videoVersionsMatch = mainHtml.match(/"video_versions"\s*:\s*\[\s*\{"url":"([^"]+)"/);
  
  if (!videoVersionsMatch) {
    const error = createMediaError(
      MEDIA_ERROR_CODES.VIDEO_NOT_FOUND,
      'No video found in Instagram post',
      postId
    );
    auditLog.record(error.code, { postId });
    return [error, null];
  }

  let videoUrl = videoVersionsMatch[1];
  if (videoUrl.endsWith('\\')) videoUrl = videoUrl.slice(0, -1);
  videoUrl = videoUrl.replace(/\\u([0-9a-fA-F]{4})/g, (_m, p1) => 
    String.fromCharCode(parseInt(p1, 16))
  );
  videoUrl = videoUrl.replace(/\\/g, '');

  // Extract author
  let author: string | undefined;
  const ownerMatch = mainHtml.match(/"owner":\{[^}]*?"username":"([^"]+)"/);
  if (ownerMatch) author = ownerMatch[1];

  // Extract caption
  let caption: string | undefined;
  const captionMatch = mainHtml.match(/"caption":\{[^}]*?"text":"([^"]+)"/);
  if (captionMatch) {
    caption = captionMatch[1]
      .replace(/\\u([0-9a-fA-F]{4})/g, (_m, p1) => String.fromCharCode(parseInt(p1, 16)))
      .replace(/\\n/g, '\n');
  }

  auditLog.trace(`Instagram video found via main page for post ${postId}`);
  return [null, { videoUrl, caption, author, typename: 'GraphVideo' }];
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
    author: data.tweet.author?.screen_name || username,
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
async function handleInstagram(ctx: Context, postId: string): Promise<void> {
  const statusMsg = await ctx.reply('🔎 Procurando vídeo no Instagram...', { 
    reply_parameters: { message_id: ctx.message!.message_id } 
  });

  const [mediaError, media] = await fetchInstagramMedia(postId);

  if (mediaError || !media) {
    await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, '❌ Vídeo não encontrado.')
      .catch(() => {}); // Ignore edit errors
    return;
  }

  const [downloadError, videoBuffer] = await downloadVideo(media.videoUrl);

  if (downloadError || !videoBuffer) {
    await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, '⚠️ Erro ao baixar.')
      .catch(() => {});
    return;
  }

  await ctx.replyWithChatAction('upload_video');

  let caption = '🎥 Vídeo do Instagram';
  if (media.author) caption += ` de @${media.author}`;
  if (media.caption) caption += `\n\n${media.caption}`;

  // Truncate caption if too long (Telegram limit is 1024)
  if (caption.length > 1000) {
    caption = caption.substring(0, 997) + '...';
  }

  const sendResult = await ctx.replyWithVideo(
    new InputFile(videoBuffer, `insta_${postId}.mp4`),
    { caption }
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
    await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, '⚠️ Erro ao enviar vídeo.')
      .catch(() => {});
    return;
  }

  await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});
  auditLog.trace(`Instagram video sent successfully for post ${postId}`);
}

/**
 * Handles Twitter/X link in message
 */
async function handleTwitter(ctx: Context, username: string, tweetId: string): Promise<void> {
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

  let caption = '🎥 Vídeo do X';
  if (media.author) caption += ` de @${media.author}`;
  if (media.caption) caption += `\n\n${media.caption}`;

  // Truncate caption if too long
  if (caption.length > 1000) {
    caption = caption.substring(0, 997) + '...';
  }

  const sendResult = await ctx.replyWithVideo(
    new InputFile(videoBuffer, `x_${tweetId}.mp4`),
    { caption }
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
 * Creates the media handler.
 * 
 * Factory function pattern - returns a closure of methods.
 * 
 * @param config - Handler configuration
 * @returns MediaHandler instance
 */
export function createMediaHandler(config: MediaHandlerConfig): MediaHandler {
  const { targetGroupId } = config;

  /**
   * Handles incoming messages, checking for social media links
   */
  async function handleMessage(ctx: Context): Promise<void> {
    // Only process text messages
    if (!ctx.message) return;
    
    const text = ctx.message.text || ctx.message.caption || '';
    if (!text) return;

    // Only process messages from private chats or the target group
    if (ctx.chat?.type !== 'private' && ctx.chat?.id !== targetGroupId) {
      return;
    }

    // Check for Instagram links
    const igMatch = text.match(IG_LINK_REGEX);
    if (igMatch && igMatch[1]) {
      await handleInstagram(ctx, igMatch[1]);
      return;
    }

    // Check for Twitter/X links
    const xMatch = text.match(X_LINK_REGEX);
    if (xMatch && xMatch[2]) {
      await handleTwitter(ctx, xMatch[1], xMatch[2]);
      return;
    }
  }

  return {
    handleMessage,
  };
}
