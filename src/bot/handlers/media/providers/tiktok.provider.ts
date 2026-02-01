/**
 * @module media/providers/tiktok
 * Extracts no-watermark videos from TikTok via the tikwm.com API.
 */

import axios from 'axios';
import { MEDIA_ERROR_CODES } from '../types';
import type { MediaProvider, MediaInfo, Result } from '../types';

export class TikTokProvider implements MediaProvider {
  readonly platform = 'TikTok' as const;
  readonly statusMessage = '🔎 TikTok (No-Watermark)...';
  readonly regex =
    /(?:https?:\/\/)?(?:www\.|vm\.|vt\.)?tiktok\.com\/(@[\w.-]+\/video\/[\d]+|[\w-]+)/;

  private static readonly API = 'https://www.tikwm.com/api/';

  /**
   * Sends the full matched URL to the tikwm API and returns video metadata.
   */
  async fetch(match: RegExpMatchArray): Result<MediaInfo> {
    try {
      const url = `${TikTokProvider.API}?url=${encodeURIComponent(match[0])}`;
      const { data } = await axios.get(url);

      if (data.code !== 0) {
        return [
          { code: MEDIA_ERROR_CODES.FETCH_FAILED, category: 'MEDIA', message: data.msg || 'TikTok API error' },
          null,
        ];
      }

      const video = data.data;
      return [
        null,
        {
          platform: 'TikTok',
          videoUrl: video.play,
          author: video.author?.nickname || video.author?.unique_id,
          caption: video.title,
        },
      ];
    } catch (e: any) {
      return [
        { code: MEDIA_ERROR_CODES.FETCH_FAILED, category: 'MEDIA', message: e.message },
        null,
      ];
    }
  }
}