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

interface InstagramMedia {
  video_url?: string;
  display_url?: string;
  __typename: string;
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

        await ctx.replyWithVideo(new InputFile(videoBuffer, `insta_${postId}.mp4`), {
          caption: `🎥 Vídeo do Instagram\nID: ${postId}`
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
      const videoUrl = await getXMedia(username, tweetId);

      if (videoUrl) {
        await ctx.replyWithChatAction('upload_video');

        const videoResponse = await axios.get(videoUrl, { 
          responseType: 'arraybuffer',
          headers: HEADERS 
        });
        
        const videoBuffer = Buffer.from(videoResponse.data);

        await ctx.replyWithVideo(new InputFile(videoBuffer, `x_${tweetId}.mp4`), {
          caption: `🎥 Vídeo do X (Twitter)\nID: ${tweetId}`
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

async function getXMedia(username: string, tweetId: string): Promise<string | null> {
  // Using api.fxtwitter.com to extract video URL without heavy scraping
  const apiUrl = `https://api.fxtwitter.com/${username}/status/${tweetId}`;

  try {
    const response = await axios.get(apiUrl, { headers: HEADERS });
    const data = response.data;

    if (data && data.tweet && data.tweet.media && data.tweet.media.videos) {
      // Find the video with the highest bitrate or simply the first one
      const videos = data.tweet.media.videos;
      if (videos.length > 0) {
        // Sort by bitrate desc to get best quality? The API usually sorts them well.
        // Let's just pick the first one which is usually the main video URL provided by fxtwitter
        return videos[0].url;
      }
    }
    return null;
  } catch (error) {
    console.error('Error fetching X media:', error);
    return null;
  }
}

async function getInstagramMedia(postId: string): Promise<InstagramMedia | null> {
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
      // e.g. https:\/\/ -> https:// and \/o1\/ -> /o1/
      videoUrl = videoUrl.replace(/\\/g, '');

      return {
        video_url: videoUrl,
        __typename: 'GraphVideo'
      } as InstagramMedia;
    }

    // DEBUG: Save HTML if failed
    console.log(`Failed to extract media from Embed for ${postId}. Trying main URL...`);
    
    // 3. Fallback: Try the main page URL
    // Sometimes the embed page is restricted but the main page works (or has meta tags)
    try {
        const mainUrl = `https://www.instagram.com/reel/${postId}/`;
        const mainResponse = await axios.get(mainUrl, { headers: HEADERS });
        const mainHtml = mainResponse.data as string;
        
        // 3.1 Check for video_versions (ServerJS / JSON payload)
        // Matches: "video_versions":[{"width":...,"height":...,"url":"..."
        const mainVideoVersionsMatch = mainHtml.match(/"video_versions"\s*:\s*\[\s*\{.*?"url"\s*:\s*"([^"]+)"/);
        if (mainVideoVersionsMatch && mainVideoVersionsMatch[1]) {
             let videoUrl = mainVideoVersionsMatch[1];
             if (videoUrl.endsWith('\\')) videoUrl = videoUrl.slice(0, -1);
             videoUrl = videoUrl.replace(/\\u([0-9a-fA-F]{4})/g, (m, p1) => String.fromCharCode(parseInt(p1, 16)));
             videoUrl = videoUrl.replace(/\\/g, '');
             
             return { video_url: videoUrl, __typename: 'GraphVideo' } as InstagramMedia;
        }

        // 3.2 Check for og:video meta tag
        // <meta property="og:video" content="https://..." />
        const ogVideoMatch = mainHtml.match(/<meta\s+property="og:video"\s+content="([^"]+)"/);
        if (ogVideoMatch && ogVideoMatch[1]) {
             let videoUrl = ogVideoMatch[1].replace(/&amp;/g, '&');
             return {
                video_url: videoUrl,
                __typename: 'GraphVideo'
             } as InstagramMedia;
        }
        
        // 3.3 Also try the robust regex on the main HTML as a last resort
        const mainVideoUrlMatch = mainHtml.match(/video_url\\?"\s*:\s*\\?"([^"]+)/);
        if (mainVideoUrlMatch && mainVideoUrlMatch[1]) {
             // ... (Same cleaning logic as above) ...
             let videoUrl = mainVideoUrlMatch[1];
             if (videoUrl.endsWith('\\')) videoUrl = videoUrl.slice(0, -1);
             videoUrl = videoUrl.replace(/\\u([0-9a-fA-F]{4})/g, (m, p1) => String.fromCharCode(parseInt(p1, 16)));
             videoUrl = videoUrl.replace(/\\/g, '');
             
             return { video_url: videoUrl, __typename: 'GraphVideo' } as InstagramMedia;
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