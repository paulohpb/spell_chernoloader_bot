/**
 * @module media/providers/twitter
 * Extracts video from Twitter/X posts using the fxtwitter public API.
 */

import axios from 'axios';
import { MEDIA_ERROR_CODES } from '../types';
import type { MediaProvider, MediaInfo, Result } from '../types';

export class TwitterProvider implements MediaProvider {
  readonly platform = 'Twitter' as const;
  readonly statusMessage = '🔎 X/Twitter...';
  readonly regex =
    /(?:https?:\/\/)?(?:twitter\.com|x\.com)\/([A-Za-z0-9_]+)\/status\/([0-9]+)/;

  private static readonly API = 'https://api.fxtwitter.com/status/';

  /**
   * Queries fxtwitter for tweet data. Uses capture group 2 (tweet ID).
   * Only returns a result when the tweet contains at least one video.
   */
  async fetch(match: RegExpMatchArray): Result<MediaInfo> {
    const tweetId = match[2];
    if (!tweetId) {
      return [
        { code: MEDIA_ERROR_CODES.NOT_FOUND, category: 'MEDIA', message: 'Invalid tweet ID' },
        null,
      ];
    }

    try {
      const { data } = await axios.get(`${TwitterProvider.API}${tweetId}`, {
        headers: { 'User-Agent': 'TelegramBot' },
      });

      const video = data.tweet?.media?.videos?.[0];
      if (!video) {
        return [
          { code: MEDIA_ERROR_CODES.NOT_FOUND, category: 'MEDIA', message: 'No video in tweet' },
          null,
        ];
      }

      return [
        null,
        {
          platform: 'Twitter',
          videoUrl: video.url,
          author: data.tweet.author?.name,
          caption: data.tweet.text,
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