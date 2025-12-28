/**
 * =============================================================================
 * Media Handler - SmudgeLord Ported Logic (Robust Version)
 * * Includes Retries, Exact Header Emulation, and JSON Sanitization
 * =============================================================================
 */

import { Context, InputFile, InlineKeyboard } from 'grammy';
import axios from 'axios';
import { AppError, Result } from '../../assistant/types';
import { auditLog } from '../../assistant/audit-log';

// --- Configuration ---

export const MEDIA_ERROR_CODES = {
  FETCH_FAILED: 'MEDIA_001',
  DOWNLOAD_FAILED: 'MEDIA_002',
  NOT_FOUND: 'MEDIA_003',
  SIZE_LIMIT: 'MEDIA_005',
} as const;

interface MediaInfo {
  videoUrl?: string;
  imageUrl?: string;
  caption?: string;
  author?: string;
  platform: 'Instagram' | 'TikTok' | 'Twitter' | 'Reddit' | 'YouTube';
}

export interface MediaHandlerConfig {
  targetGroupId: number;
}

export interface MediaHandler {
  handleMessage: (ctx: Context) => Promise<void>;
}

// Headers exatos do SmudgeLord (Simulando Chrome Windows)
const SMUDGE_HEADERS = {
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
  'accept-language': 'en-US,en;q=0.9',
  'connection': 'close',
  'sec-fetch-mode': 'navigate',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
  'viewport-width': '1280',
};

// Regex corrigidas com escapes
const REGEX = {
  INSTAGRAM: /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/,
  TIKTOK: /(?:https?:\/\/)?(?:www\.|vm\.|vt\.)?tiktok\.com\/(@[\w.-]+\/video\/[\d]+|[\w-]+)/,
  TWITTER: /(?:https?:\/\/)?(?:twitter\.com|x\.com)\/([A-Za-z0-9_]+)\/status\/([0-9]+)/,
  REDDIT: /(?:https?:\/\/)?(?:www\.|old\.)?reddit\.com\/r\/[\w-]+\/comments\/([\w]+)/,
  YOUTUBE: /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/,
};

// --- Utilities ---

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function escapeMarkdown(text: string): string {
  if (!text) return '';
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

function truncate(text: string, limit: number = 800): string {
  if (text.length <= limit) return text;
  return text.substring(0, limit - 3) + '...';
}

// --- Instagram Logic (The Fix) ---

async function fetchInstagramEmbed(postId: string): Promise<Result<MediaInfo>> {
  const embedUrl = `https://www.instagram.com/p/${postId}/embed/captioned/`;
  
  let html = '';
  let attempt = 0;
  const maxAttempts = 3;

  while (attempt < maxAttempts) {
    try {
      const response = await axios.get(embedUrl, { 
        headers: SMUDGE_HEADERS,
        responseType: 'text',
        timeout: 5000 
      });
      html = response.data;
      if (html) break;
    } catch (e) {
      attempt++;
      if (attempt >= maxAttempts) {
        return [{ code: MEDIA_ERROR_CODES.FETCH_FAILED, category: 'MEDIA', message: 'Instagram connection failed after retries' }, null];
      }
      await sleep(1000 * Math.pow(2, attempt - 1));
    }
  }

  const match = html.match(/\\"gql_data\\":([\s\S]*)\}"\}/);

  if (match && match[1]) {
    let jsonStr = match[1];
    jsonStr = jsonStr.replace(/\\"/g, '"');
    jsonStr = jsonStr.replace(/\\\//g, '/');
    jsonStr = jsonStr.replace(/\\\\/g, '\\');

    try {
      const data = JSON.parse(jsonStr);
      const media = data.shortcode_media || data.graphql?.shortcode_media;

      if (media) {
        return [null, {
          platform: 'Instagram',
          videoUrl: media.video_url,
          imageUrl: media.display_url,
          author: media.owner?.username,
          caption: media.edge_media_to_caption?.edges?.[0]?.node?.text || ''
        }];
      }
    } catch (e) {
      console.error('IG JSON Parse Error:', e);
    }
  }

  if (html.includes('GraphImage')) {
      const srcMatch = html.match(/class="Content(.*?)src="(.*?)"/);
      if (srcMatch && srcMatch[2]) {
          const cleanUrl = srcMatch[2].replace(/amp;/g, '');
          return [null, {
              platform: 'Instagram',
              imageUrl: cleanUrl,
              videoUrl: undefined
          }];
      }
  }

  return [{ code: MEDIA_ERROR_CODES.NOT_FOUND, category: 'MEDIA', message: 'Video not found in embed' }, null];
}

// --- Other Fetchers ---

async function fetchTikTok(url: string): Promise<Result<MediaInfo>> {
  try {
    const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`;
    const { data } = await axios.get(apiUrl);

    if (data.code !== 0) {
      return [{ code: MEDIA_ERROR_CODES.FETCH_FAILED, category: 'MEDIA', message: data.msg || 'TikTok API Error' }, null];
    }

    const videoData = data.data;
    return [null, {
      platform: 'TikTok',
      videoUrl: videoData.play,
      author: videoData.author?.nickname || videoData.author?.unique_id,
      caption: videoData.title,
    }];
  } catch (e: any) {
    return [{ code: MEDIA_ERROR_CODES.FETCH_FAILED, category: 'MEDIA', message: e.message }, null];
  }
}

async function fetchTwitter(tweetId: string): Promise<Result<MediaInfo>> {
  try {
    const apiUrl = `https://api.fxtwitter.com/status/${tweetId}`;
    const { data } = await axios.get(apiUrl, { headers: { 'User-Agent': 'TelegramBot' } });

    const video = data.tweet?.media?.videos?.[0];
    if (!video) return [{ code: MEDIA_ERROR_CODES.NOT_FOUND, category: 'MEDIA', message: 'No video in tweet' }, null];

    return [null, {
      platform: 'Twitter',
      videoUrl: video.url,
      author: data.tweet.author?.name,
      caption: data.tweet.text
    }];
  } catch (e: any) {
    return [{ code: MEDIA_ERROR_CODES.FETCH_FAILED, category: 'MEDIA', message: e.message }, null];
  }
}

async function fetchReddit(url: string): Promise<Result<MediaInfo>> {
  try {
    const jsonUrl = url.split('?')[0].replace(/\/$/, '') + '.json';
    const { data } = await axios.get(jsonUrl, { headers: SMUDGE_HEADERS });

    const post = data[0]?.data?.children?.[0]?.data;
    if (!post) return [{ code: MEDIA_ERROR_CODES.NOT_FOUND, category: 'MEDIA', message: 'Reddit post not found' }, null];

    let videoUrl = post.secure_media?.reddit_video?.fallback_url;
    if (!videoUrl && post.url && post.url.match(/\.(mp4|mov)$/)) {
        videoUrl = post.url;
    }

    return [null, {
      platform: 'Reddit',
      videoUrl: videoUrl,
      imageUrl: !videoUrl && post.url.match(/\.(jpg|png|jpeg|gif)$/) ? post.url : undefined,
      author: post.author,
      caption: post.title,
    }];
  } catch (e: any) {
    return [{ code: MEDIA_ERROR_CODES.FETCH_FAILED, category: 'MEDIA', message: e.message }, null];
  }
}

// --- Common Logic ---

async function downloadBuffer(url: string): Result<Buffer> {
  try {
    const res = await axios.get(url, { 
      responseType: 'arraybuffer',
      headers: SMUDGE_HEADERS 
    });
    return [null, Buffer.from(res.data)];
  } catch (e: any) {
    return [{ code: MEDIA_ERROR_CODES.DOWNLOAD_FAILED, category: 'MEDIA', message: e.message }, null];
  }
}

async function processMedia(ctx: Context, fetcher: Promise<Result<MediaInfo>>, originalUrl: string, statusMsgId: number) {
  const [err, media] = await fetcher;

  if (err || !media) {
    await ctx.api.editMessageText(ctx.chat!.id, statusMsgId, `❌ Erro: ${err?.message || 'Falha ao processar'}`).catch(() => {});
    return;
  }

  if (media.videoUrl) {
    await ctx.api.editMessageText(ctx.chat!.id, statusMsgId, '⬇️ Baixando vídeo...').catch(() => {});
    const [dlErr, buffer] = await downloadBuffer(media.videoUrl);

    if (dlErr || !buffer) {
      await ctx.api.editMessageText(ctx.chat!.id, statusMsgId, '⚠️ Falha no download do arquivo.').catch(() => {});
      return;
    }

    await ctx.replyWithChatAction('upload_video');
    const authorLine = media.author ? `👤 *${escapeMarkdown(media.author)}*\n` : '';
    const captionLine = media.caption ? escapeMarkdown(truncate(media.caption)) : '';
    
    await ctx.replyWithVideo(new InputFile(buffer, `vid_${Date.now()}.mp4`), {
      caption: authorLine + captionLine,
      parse_mode: 'MarkdownV2',
      reply_markup: new InlineKeyboard().url(`Open in ${media.platform} ↗️`, originalUrl)
    });

  } else if (media.imageUrl) {
    const [dlErr, buffer] = await downloadBuffer(media.imageUrl);
    if (buffer) {
        await ctx.replyWithPhoto(new InputFile(buffer), {
            caption: `📷 *${escapeMarkdown(media.author || 'Image')}*`,
            parse_mode: 'MarkdownV2',
            reply_markup: new InlineKeyboard().url(`Open in ${media.platform} ↗️`, originalUrl)
        });
    }
  } else {
    await ctx.api.editMessageText(ctx.chat!.id, statusMsgId, '⚠️ Mídia não encontrada/suportada.').catch(() => {});
    return;
  }

  await ctx.api.deleteMessage(ctx.chat!.id, statusMsgId).catch(() => {});
}

// --- Handler Factory ---

export function createMediaHandler(config: MediaHandlerConfig): MediaHandler {
  const { targetGroupId } = config;

  return {
    async handleMessage(ctx: Context) {
      if (!ctx.message) return;
      const text = ctx.message.text || ctx.message.caption || '';
      if (!text) return;
      if (ctx.chat?.type !== 'private' && ctx.chat?.id !== targetGroupId) return;

      const igMatch = text.match(REGEX.INSTAGRAM);
      const ttMatch = text.match(REGEX.TIKTOK);
      const twMatch = text.match(REGEX.TWITTER);
      const rdMatch = text.match(REGEX.REDDIT);

      if (igMatch && igMatch[1]) {
        const statusMsg = await ctx.reply('🔎 Instagram (Embed)...', { reply_parameters: { message_id: ctx.message.message_id } });
        await processMedia(ctx, fetchInstagramEmbed(igMatch[1]), igMatch[0], statusMsg.message_id);
      }
      else if (ttMatch) {
        const statusMsg = await ctx.reply('🔎 TikTok (No-Watermark)...', { reply_parameters: { message_id: ctx.message.message_id } });
        await processMedia(ctx, fetchTikTok(ttMatch[0]), ttMatch[0], statusMsg.message_id);
      }
      else if (twMatch && twMatch[2]) {
        const statusMsg = await ctx.reply('🔎 X/Twitter...', { reply_parameters: { message_id: ctx.message.message_id } });
        await processMedia(ctx, fetchTwitter(twMatch[2]), twMatch[0], statusMsg.message_id);
      }
      else if (rdMatch) {
        const statusMsg = await ctx.reply('🔎 Reddit...', { reply_parameters: { message_id: ctx.message.message_id } });
        await processMedia(ctx, fetchReddit(rdMatch[0]), rdMatch[0], statusMsg.message_id);
      }
    }
  };
}