import { Bot, InputFile } from 'grammy';
import axios from 'axios';
import * as fs from 'fs';
import 'dotenv/config';

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is missing in .env');
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// Regex to detect Instagram links (Posts and Reels)
const IG_LINK_REGEX = /(?:instagram\.com)\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/;

// Regex to detect X/Twitter links
const X_LINK_REGEX = /(?:twitter\.com|x\.com)\/([A-Za-z0-9_]+)\/status\/([0-9]+)/;

// Headers from SmudgeLord (Go) implementation
const HEADERS = {
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
  'accept-language': 'en-US,en;q=0.9',
  'connection': 'close',
  'sec-fetch-mode': 'navigate',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'viewport-width': '1280',
};

interface MediaInfo {
  video_url: string;
  caption?: string;
  author?: string;
  __typename?: string;
}

const TARGET_GROUP_ID = -1000000000000;

bot.on('message', async (ctx) => {
  const text = ctx.message.text || ctx.message.caption || '';
  
  // Debug log
  console.log(`[ANY MSG] Chat: ${ctx.chat.id} (${ctx.chat.type}) | User: ${ctx.from.first_name}`);

  // Se for grupo, só responde no grupo específico
  if (ctx.chat.type !== 'private' && ctx.chat.id !== TARGET_GROUP_ID) {
    return;
  }

  // Detecta link direto ou via comando /dl
  const isCommand = text.startsWith('/dl');
  const igMatch = text.match(IG_LINK_REGEX);
  const xMatch = text.match(X_LINK_REGEX);

  // --- INSTAGRAM HANDLER ---
  if (igMatch && igMatch[1]) {
    const postId = igMatch[1];
    
    const statusMsg = await ctx.reply('🔎 Procurando vídeo no Instagram...', {
        reply_parameters: { message_id: ctx.message.message_id }
    });

    try {
      const media = await getInstagramMedia(postId);

      if (media && media.video_url) {
        await ctx.replyWithChatAction('upload_video');
        
        const videoResponse = await axios.get(media.video_url, { 
          responseType: 'arraybuffer',
          headers: HEADERS 
        });
        
        const videoBuffer = Buffer.from(videoResponse.data);
        
        let captionText = `🎥 Vídeo do Instagram`;
        if (media.author) captionText += ` de @${media.author}`;
        if (media.caption) captionText += `\n\n${media.caption}`;

        await ctx.replyWithVideo(new InputFile(videoBuffer, `insta_${postId}.mp4`), {
          caption: captionText
        });

        await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);

      } else {
        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, '❌ Nenhum vídeo encontrado neste link (pode ser uma imagem ou privado).');
      }

    } catch (error) {
      console.error('Error processing Instagram link:', error);
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, '⚠️ Falha ao baixar o vídeo. Pode ser privado ou restrito.');
    }
  } 
  
  // --- X / TWITTER HANDLER ---
  else if (xMatch && xMatch[2]) {
    const tweetId = xMatch[2];
    const username = xMatch[1];

    const statusMsg = await ctx.reply('🔎 Procurando vídeo no X (Twitter)...', {
        reply_parameters: { message_id: ctx.message.message_id }
    });

    try {
      const media = await getXMedia(username, tweetId);

      if (media && media.video_url) {
        await ctx.replyWithChatAction('upload_video');

        const videoResponse = await axios.get(media.video_url, { 
          responseType: 'arraybuffer',
          headers: HEADERS 
        });
        
        const videoBuffer = Buffer.from(videoResponse.data);

        let captionText = `🎥 Vídeo do X (Twitter)`;
        if (media.author) captionText += ` de @${media.author}`;
        if (media.caption) captionText += `\n\n${media.caption}`;

        await ctx.replyWithVideo(new InputFile(videoBuffer, `x_${tweetId}.mp4`), {
          caption: captionText
        });

        await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);
      } else {
        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, '❌ Nenhum vídeo encontrado neste Tweet.');
      }

    } catch (error) {
      console.error('Error processing X link:', error);
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, '⚠️ Falha ao baixar o vídeo do X.');
    }
  }
});

async function getXMedia(username: string, tweetId: string): Promise<MediaInfo | null> {
  // Using api.fxtwitter.com to extract video URL without heavy scraping
  const apiUrl = `https://api.fxtwitter.com/${username}/status/${tweetId}`;

  try {
    const response = await axios.get(apiUrl, { headers: HEADERS });
    const data = response.data;

    if (data && data.tweet && data.tweet.media && data.tweet.media.videos) {
      const videos = data.tweet.media.videos;
      if (videos.length > 0) {
        return {
            video_url: videos[0].url,
            caption: data.tweet.text,
            author: data.tweet.author ? data.tweet.author.screen_name : username
        };
      }
    }
    return null;
  } catch (error) {
    console.error('Error fetching X media:', error);
    return null;
  }
}

async function getInstagramMedia(postId: string): Promise<MediaInfo | null> {
  const embedUrl = `https://www.instagram.com/p/${postId}/embed/captioned/`;

  try {
    const response = await axios.get(embedUrl, { headers: HEADERS });
    const html = response.data as string;

    // DIRECT APPROACH: Search for video_url specifically
    // Handle both standard JSON ("key":"value") and escaped JSON string (\"key\":\"value\")
    const videoUrlMatch = html.match(/video_url\\?"\s*:\s*\\?"([^"]+)/);
    
    if (videoUrlMatch && videoUrlMatch[1]) {
      let videoUrl = videoUrlMatch[1];
      
      // If the closing quote was escaped (\"), the capture group includes the trailing backslash
      if (videoUrl.endsWith('\\')) {
        videoUrl = videoUrl.slice(0, -1);
      }
      
      // Decode unicode escapes like \u0026 -> &
      videoUrl = videoUrl.replace(/\\u([0-9a-fA-F]{4})/g, (match, p1) => 
        String.fromCharCode(parseInt(p1, 16))
      );
      
      // Remove ALL remaining backslashes to fix double-escaped paths
      videoUrl = videoUrl.replace(/\\/g, '');

      return {
        video_url: videoUrl,
        __typename: 'GraphVideo'
      } as MediaInfo;
    }

    // DEBUG: Save HTML if failed
    console.log(`Failed to extract media from Embed for ${postId}. Trying main URL...`);
    
    // 3. Fallback: Try the main page URL
    // Sometimes the embed page is restricted but the main page works (or has meta tags)
    try {
        const mainUrl = `https://www.instagram.com/reel/${postId}/`;
        const mainResponse = await axios.get(mainUrl, { headers: HEADERS });
        const mainHtml = mainResponse.data as string;
        
        let videoUrl = null;
        let caption = undefined;
        let author = undefined;

        // 3.1 Check for video_versions (ServerJS / JSON payload)
        const mainVideoVersionsMatch = mainHtml.match(/"video_versions"\s*:\s*\[\s*\{.*?"url"\s*:\s*"([^"]+)"/);
        if (mainVideoVersionsMatch && mainVideoVersionsMatch[1]) {
             videoUrl = mainVideoVersionsMatch[1];
        }

        // 3.2 Check for og:video meta tag
        if (!videoUrl) {
            const ogVideoMatch = mainHtml.match(/<meta\s+property="og:video"\s+content="([^"]+)"/);
            if (ogVideoMatch && ogVideoMatch[1]) {
                videoUrl = ogVideoMatch[1].replace(/&amp;/g, '&');
            }
        }
        
        // 3.3 Also try the robust regex on the main HTML as a last resort
        if (!videoUrl) {
            const mainVideoUrlMatch = mainHtml.match(/video_url\\?"\s*:\s*\\?"([^"]+)/);
            if (mainVideoUrlMatch && mainVideoUrlMatch[1]) {
                videoUrl = mainVideoUrlMatch[1];
            }
        }

        if (videoUrl) {
             // Clean URL
             if (videoUrl.endsWith('\\')) videoUrl = videoUrl.slice(0, -1);
             videoUrl = videoUrl.replace(/\\u([0-9a-fA-F]{4})/g, (m, p1) => String.fromCharCode(parseInt(p1, 16)));
             videoUrl = videoUrl.replace(/\\/g, '');

             // Try to extract metadata from Main Page JSON
             // Owner: "owner":{"id":"...","username":"leonardinlopes"
             const ownerMatch = mainHtml.match(/"owner":\{[^}]*?"username":"([^"]+)"/);
             if (ownerMatch && ownerMatch[1]) {
                 author = ownerMatch[1];
             }

             // Caption: "caption":{"pk":"...","text":"The text..."}
             // Be careful with JSON structure matching
             const captionMatch = mainHtml.match(/"caption":\{[^}]*?"text":"([^"]+)"/);
             if (captionMatch && captionMatch[1]) {
                 // Clean unicode in caption
                 caption = captionMatch[1].replace(/\\u([0-9a-fA-F]{4})/g, (m, p1) => String.fromCharCode(parseInt(p1, 16)));
                 caption = caption.replace(/\\n/g, '\n');
             }

             return { video_url: videoUrl, caption, author, __typename: 'GraphVideo' } as MediaInfo;
        }
        
        // Save main HTML for debug if that also fails
        console.log(`Failed to extract media from Main URL for ${postId}. Saving HTML to debug_error_main.html`);
        fs.writeFileSync('debug_error_main.html', mainHtml);
        
    } catch (e) {
        console.error('Error fetching Main URL:', e);
    }

    fs.writeFileSync('debug_error.html', html); // Save the original embed HTML too

    return null;
  } catch (error) {
    console.error('Error fetching Instagram media:', error);
    return null;
  }
}

// Start the bot
bot.start();
console.log('Bot is running...');