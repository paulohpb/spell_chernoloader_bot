/**
 * @module media/providers/reddit
 * Extracts media from Reddit posts using the public `.json` endpoint.
 * Supports reddit-hosted video, direct video/image links.
 */

import axios from 'axios';
import { MEDIA_ERROR_CODES } from '../types';
import type { MediaProvider, MediaInfo, Result } from '../types';
import { SMUDGE_HEADERS } from '../utils';

export class RedditProvider implements MediaProvider {
  readonly platform = 'Reddit' as const;
  readonly statusMessage = '🔎 Reddit...';
  readonly regex =
    /(?:https?:\/\/)?(?:www\.|old\.)?reddit\.com\/r\/[\w-]+\/comments\/([\w]+)/;

  /**
   * Appends `.json` to the post URL and reads the listing response.
   * Checks `secure_media.reddit_video` first, then falls back to
   * direct `.mp4`/`.mov` or image URLs in `post.url`.
   */
  async fetch(match: RegExpMatchArray): Result<MediaInfo> {
    try {
      const jsonUrl = match[0].split('?')[0].replace(/\/$/, '') + '.json';
      const { data } = await axios.get(jsonUrl, { headers: SMUDGE_HEADERS });

      const post = data[0]?.data?.children?.[0]?.data;
      if (!post) {
        return [
          { code: MEDIA_ERROR_CODES.NOT_FOUND, category: 'MEDIA', message: 'Post not found' },
          null,
        ];
      }

      let videoUrl = post.secure_media?.reddit_video?.fallback_url;
      if (!videoUrl && post.url?.match(/\.(mp4|mov)$/)) {
        videoUrl = post.url;
      }

      const isImage = !videoUrl && /\.(jpe?g|png|gif)$/.test(post.url ?? '');

      return [
        null,
        {
          platform: 'Reddit',
          videoUrl,
          imageUrl: isImage ? post.url : undefined,
          author: post.author,
          caption: post.title,
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