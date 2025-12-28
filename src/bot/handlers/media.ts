/**
 * =============================================================================
 * Media Handler - Multi-Platform Video Downloader
 * 
 * Handles Instagram (Embed method), TikTok (No-Watermark),
 * Twitter/X (FixupX), Reddit (JSON API), and YouTube.
 * =============================================================================
 */

import { Context, InputFile, InlineKeyboard } from 'grammy';
import axios from 'axios';
import ytdl from '@distube/ytdl-core';
import { AppError, Result } from '../../assistant/types';
import { auditLog } from '../../assistant/audit-log';

// --- Types & Config ---

export const MEDIA_ERROR_CODES = {
  FETCH_FAILED: 'MEDIA_001',
  DOWNLOAD_FAILED: 'MEDIA_002',
  NOT_FOUND: 'MEDIA_003',
  SEND_FAILED: 'MEDIA_004',
  SIZE_LIMIT: 'MEDIA_005',
} as const;

interface MediaInfo {
  videoUrl?: string;
  imageUrl?: string;
  caption?: string;
  author?: string;
  platform: 'Instagram' | 'TikTok' | 'Twitter' | 'Reddit' | 'YouTube';
  thumbnailUrl?: string;
}

export interface MediaHandlerConfig {
  targetGroupId: number;
}

export interface MediaHandler {
  handleMessage: (ctx: Context) => Promise<void>;
}

// --- Headers & Constants ---

// Headers simulating a real browser to avoid blocks
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

const REGEX = {
  INSTAGRAM: /((?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)[^ \n]*)/,
  TIKTOK: /((?:https?:\/\/)?(?:www\.|vm\.|vt\.)?tiktok\.com\/(@[\w.-]+\/video\/[\d]+|[\w-]+)[^ \n]*)/,
  TWITTER: /((?:https?:\/\/)?(?:twitter\.com|x\.com)\/([A-Za-z0-9_]+)\/status\/([0-9]+)[^ \n]*)/,
  REDDIT: /((?:https?:\/\/)?(?:www\.|old\.)?reddit\.com\/r\/[\w-]+\/comments\/([\w]+)[^ \n]*)/,
  YOUTUBE: /((?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})[^ \n]*)/,
};

// --- Helper Functions ---

function escapeMarkdown(text: string): string {
  if (!text) return '';
  return text.replace(/[_*[\\\]()~`>#+\-=|"{}.!]/g, '\\$&');
}

function truncate(text: string, limit: number = 800): string {
  if (text.length <= limit) return text;
  return text.substring(0, limit - 3) + '...';
}

function createError(code: string, msg: string, details?: string): AppError {
  return { code, category: 'LLM', message: msg, details };
}

async function downloadBuffer(url: string): Result<Buffer> {
  try {
    const res = await axios.get(url, { 
      responseType: 'arraybuffer',
      headers: BROWSER_HEADERS 
    });
    return [null, Buffer.from(res.data)];
  } catch (e: any) {
    return [createError(MEDIA_ERROR_CODES.DOWNLOAD_FAILED, e.message), null];
  }
}

// --- Platform Fetchers ---

/**
 * INSTAGRAM (Multi-Strategy Scraping)
 * 1. Try Embed JSON (Best metadata)
 * 2. Try Main Page Meta Tags (Fallback for video URL)
 */
async function fetchInstagram(postId: string): Promise<Result<MediaInfo>> {
  // Strategy 1: Embed Page JSON
  const embedUrl = `https://www.instagram.com/p/${postId}/embed/captioned/`;
  try {
    const { data: html } = await axios.get(embedUrl, { headers: BROWSER_HEADERS });
    
    const match = html.match(/\\"gql_data\\":([\s\S]*?)\}"\}/);
    if (match && match[1]) {
      let jsonStr = match[1]
        .replace(/\\"/g, '"')
        .replace(/\\\//g, '/')
        .replace(/\\\\/g, '\\');

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
    }
  } catch (e) {
    // Ignore embed error and try fallback
    console.warn(`IG Embed failed for ${postId}, trying fallback...`);
  }

  // Strategy 2: Main Page Meta Tags (OG Tags)
  // This is very reliable for public posts to get the video URL directly
  const mainUrl = `https://www.instagram.com/p/${postId}/`;
  try {
    const { data: html } = await axios.get(mainUrl, { headers: BROWSER_HEADERS });

    const videoMatch = html.match(/<meta property="og:video" content="([^"]+)"/);
    const imageMatch = html.match(/<meta property="og:image" content="([^"]+)"/);
    const descMatch = html.match(/<meta property="og:description" content="([^"]+)"/); // Usually "Username: Caption"
    
    if (videoMatch || imageMatch) {
      let videoUrl = videoMatch ? videoMatch[1].replace(/&amp;/g, '&') : undefined;
      let imageUrl = imageMatch ? imageMatch[1].replace(/&amp;/g, '&') : undefined;
      
      // Try to extract author/caption from description
      let author = 'Instagram User';
      let caption = '';
      if (descMatch) {
          const desc = descMatch[1].replace(/&amp;/g, '&');
          const parts = desc.split(':');
          if (parts.length > 1) {
              author = parts[0].trim();
              caption = parts.slice(1).join(':').trim();
          }
      }

      return [null, {
        platform: 'Instagram',
        videoUrl,
        imageUrl,
        author,
        caption
      }];
    }
  } catch (e: any) {
    return [createError(MEDIA_ERROR_CODES.FETCH_FAILED, `All strategies failed: ${e.message}`), null];
  }

  return [createError(MEDIA_ERROR_CODES.NOT_FOUND, 'Instagram content not found in Embed or Meta tags'), null];
}

/**
 * TIKTOK (TikWM API Method)
 * Uses public API to get No-Watermark videos.
 */
async function fetchTikTok(url: string): Promise<Result<MediaInfo>> {
  try {
    const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`;
    const { data } = await axios.get(apiUrl);

    if (data.code !== 0) {
      return [createError(MEDIA_ERROR_CODES.FETCH_FAILED, 'TikWM API Error', data.msg), null];
    }

    const videoData = data.data;
    return [null, {
      platform: 'TikTok',
      videoUrl: videoData.play, // No-Watermark link
      author: videoData.author?.nickname || videoData.author?.unique_id,
      caption: videoData.title,
      thumbnailUrl: videoData.cover
    }];
  } catch (e: any) {
    return [createError(MEDIA_ERROR_CODES.FETCH_FAILED, e.message), null];
  }
}

/**
 * REDDIT (JSON API Method)
 * Appends .json to URL to get raw data.
 */
async function fetchReddit(url: string): Promise<Result<MediaInfo>> {
  try {
    const jsonUrl = url.split('?')[0].replace(/\/$/, '') + '.json';
    const { data } = await axios.get(jsonUrl, { headers: BROWSER_HEADERS });

    const post = data[0]?.data?.children?.[0]?.data;
    if (!post) return [createError(MEDIA_ERROR_CODES.NOT_FOUND, 'Reddit post structure invalid'), null];

    let videoUrl = post.secure_media?.reddit_video?.fallback_url;
    // Handle external video links (e.g., YouTube on Reddit)
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
    return [createError(MEDIA_ERROR_CODES.FETCH_FAILED, e.message), null];
  }
}

/**
 * TWITTER/X (FixupX API Method)
 */
async function fetchTwitter(tweetId: string): Promise<Result<MediaInfo>> {
  try {
    const apiUrl = `https://api.fxtwitter.com/status/${tweetId}`;
    const { data } = await axios.get(apiUrl, { headers: { 'User-Agent': 'TelegramBot' } });

    const video = data.tweet?.media?.videos?.[0];
    if (!video) return [createError(MEDIA_ERROR_CODES.NOT_FOUND, 'No video in tweet'), null];

    return [null, {
      platform: 'Twitter',
      videoUrl: video.url,
      author: data.tweet.author?.name,
      caption: data.tweet.text
    }];
  } catch (e: any) {
    return [createError(MEDIA_ERROR_CODES.FETCH_FAILED, e.message), null];
  }
}

// --- Main Processor ---

async function processMedia(ctx: Context, fetcher: Promise<Result<MediaInfo>>, originalUrl: string, statusMsgId: number) {
  const [err, media] = await fetcher;

  if (err || !media) {
    await ctx.api.editMessageText(ctx.chat!.id, statusMsgId, `❌ Erro: ${err?.message || 'Conteúdo não encontrado'}`).catch(() => {});
    return;
  }

  if (media.videoUrl) {
    await ctx.api.editMessageText(ctx.chat!.id, statusMsgId, '⬇️ Baixando vídeo...').catch(() => {});
    const [dlErr, buffer] = await downloadBuffer(media.videoUrl);

    if (dlErr || !buffer) {
      await ctx.api.editMessageText(ctx.chat!.id, statusMsgId, '⚠️ Falha no download do arquivo.').catch(() => {});
      return;
    }

    if (buffer.length > 50 * 1024 * 1024) { // 50MB Limit
       await ctx.api.editMessageText(ctx.chat!.id, statusMsgId, '⚠️ Vídeo muito grande (>50MB) para o Telegram.').catch(() => {});
       return;
    }

    await ctx.replyWithChatAction('upload_video');

    const authorLine = media.author ? `👤 *${escapeMarkdown(media.author)}*\n` : '';
    const captionLine = media.caption ? escapeMarkdown(truncate(media.caption)) : '';
    
    const keyboard = new InlineKeyboard().url(`Open in ${media.platform} ↗️`, originalUrl);

    await ctx.replyWithVideo(new InputFile(buffer, `${media.platform}_${Date.now()}.mp4`), {
      caption: authorLine + captionLine,
      parse_mode: 'MarkdownV2',
      reply_markup: keyboard
    });

  } else if (media.imageUrl) {
      const [dlErr, buffer] = await downloadBuffer(media.imageUrl);
      if (buffer) {
          await ctx.replyWithPhoto(new InputFile(buffer), {
              caption: `📷 *${escapeMarkdown(media.author || 'Image')}*\n${escapeMarkdown(truncate(media.caption || ''))}`,
              parse_mode: 'MarkdownV2',
              reply_markup: new InlineKeyboard().url(`Open in ${media.platform} ↗️`, originalUrl)
          });
      }
  } else {
    await ctx.api.editMessageText(ctx.chat!.id, statusMsgId, '⚠️ Nenhum vídeo encontrado neste link.').catch(() => {});
    return;
  }

  // Cleanup status message
  await ctx.api.deleteMessage(ctx.chat!.id, statusMsgId).catch(() => {});
  auditLog.trace(`Processed ${media.platform} link: ${originalUrl}`);
}

// --- Handler Factory ---

export function createMediaHandler(config: MediaHandlerConfig): MediaHandler {
  const { targetGroupId } = config;

  async function handleMessage(ctx: Context): Promise<void> {
    if (!ctx.message) return;
    const text = ctx.message.text || ctx.message.caption || '';
    if (!text) return;
    if (ctx.chat?.type !== 'private' && ctx.chat?.id !== targetGroupId) return;

    // Detect Links
    const igMatch = text.match(REGEX.INSTAGRAM);
    const ttMatch = text.match(REGEX.TIKTOK);
    const twMatch = text.match(REGEX.TWITTER);
    const rdMatch = text.match(REGEX.REDDIT);
    const ytMatch = text.match(REGEX.YOUTUBE);

    let statusMsg;

    if (igMatch && igMatch[2]) {
      statusMsg = await ctx.reply('🔎 Instagram (Embed)...', { reply_parameters: { message_id: ctx.message.message_id } });
      await processMedia(ctx, fetchInstagram(igMatch[2]), igMatch[0], statusMsg.message_id);
    } 
    else if (ttMatch) {
      statusMsg = await ctx.reply('🔎 TikTok (No-Watermark)...', { reply_parameters: { message_id: ctx.message.message_id } });
      await processMedia(ctx, fetchTikTok(ttMatch[0]), ttMatch[0], statusMsg.message_id);
    }
    else if (twMatch && twMatch[3]) {
      statusMsg = await ctx.reply('🔎 X/Twitter...', { reply_parameters: { message_id: ctx.message.message_id } });
      await processMedia(ctx, fetchTwitter(twMatch[3]), twMatch[0], statusMsg.message_id);
    }
    else if (rdMatch) {
      statusMsg = await ctx.reply('🔎 Reddit...', { reply_parameters: { message_id: ctx.message.message_id } });
      await processMedia(ctx, fetchReddit(rdMatch[0]), rdMatch[0], statusMsg.message_id);
    }
    else if (ytMatch && ytMatch[2]) {
       // YouTube handling (Simple & Robust)
       try {
           statusMsg = await ctx.reply('🔎 YouTube...', { reply_parameters: { message_id: ctx.message.message_id } });
           const url = ytMatch[0];
           const info = await ytdl.getInfo(url);
           // Try 720p first, then fallback
           let format = ytdl.chooseFormat(info.formats, { quality: 'highest', filter: 'audioandvideo' });
           if (!format || (format.height && format.height > 720)) {
               // If >720p, try finding a smaller one explicitly
               const formats = ytdl.filterFormats(info.formats, 'audioandvideo');
               const f720 = formats.find(f => f.qualityLabel === '720p');
               format = f720 || formats[0]; // fallback
           }
           
           if (!format) throw new Error('No format');

           const stream = ytdl(url, { format });
           const caption = `👤 *${escapeMarkdown(info.videoDetails.author.name)}*\n${escapeMarkdown(truncate(info.videoDetails.title))}`;
           
           await ctx.replyWithVideo(new InputFile(stream), {
               caption: caption,
               parse_mode: 'MarkdownV2',
               reply_markup: new InlineKeyboard().url('Open in YouTube ↗️', url)
           });
           await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});
       } catch (e) {
           if(statusMsg) await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, '❌ Erro no YouTube.').catch(() => {});
       }
    }
  }

  return { handleMessage };
}
