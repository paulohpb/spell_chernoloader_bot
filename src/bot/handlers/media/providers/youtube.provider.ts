/**
 * @module media/providers/youtube
 *
 * Extracts video from YouTube, capped at 720p.
 *
 * YouTube distributes most videos as DASH (separate video and audio streams).
 * When no single muxed (combined) format at or below 720p exists the provider
 * picks the best video stream ≤ 720p and the best audio stream, then merges
 * them with ffmpeg before returning.
 *
 * Quality selection logic:
 *  1. Filter all formats to `quality ≤ 720` (never 1080p).
 *  2. Prefer a single muxed format (has both video and audio).
 *  3. If only DASH formats exist, select the best video-only ≤ 720p and the
 *     best audio-only, then pipe both through `ffmpeg -i video -i audio -c copy`.
 *
 * The merged output is returned as `MediaInfo.muxedStream` so the downloader
 * skips its HTTP fetch and hands the stream directly to Telegram.
 */

import { Readable, PassThrough } from 'stream';
import ytdl from '@distube/ytdl-core';
import ffmpeg from 'fluent-ffmpeg';
import { MEDIA_ERROR_CODES } from '../types';
import type { MediaProvider, MediaInfo, Result } from '../types';

/** Maximum allowed video quality height in pixels. */
const MAX_QUALITY_P = 720;

export class YouTubeProvider implements MediaProvider {
  readonly platform = 'YouTube' as const;
  readonly statusMessage = '🔎 YouTube (≤720p)...';
  readonly regex =
    /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;

  /**
   * Resolves video info, picks streams ≤ 720p, and returns either a direct
   * URL (muxed format) or a merged stream (DASH).
   *
   * @param match - Capture group 1 is the 11-char video ID.
   */
  async fetch(match: RegExpMatchArray): Result<MediaInfo> {
    const videoId = match[1];
    if (!videoId) {
      return [
        { code: MEDIA_ERROR_CODES.NOT_FOUND, category: 'MEDIA', message: 'Invalid video ID' },
        null,
      ];
    }

    let info: ytdl.videoInfo;
    try {
      info = await ytdl.getInfo(videoId, {
        lang: 'en',
        requestOptions: {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Sec-Fetch-Mode': 'navigate'
          }
        }
      });
    } catch (e: any) {
      return [
        { code: MEDIA_ERROR_CODES.FETCH_FAILED, category: 'MEDIA', message: `YouTube Fetch Error: ${e.message}` },
        null,
      ];
    }

    const title = info.videoDetails.title;
    const author = info.videoDetails.author?.name;

    // -------------------------------------------------------------------
    // 1. Gather all formats whose quality height is ≤ MAX_QUALITY_P.
    // -------------------------------------------------------------------
    const eligible = ytdl
      .filterFormats(info.formats, (f) => {
        const q = parseInt(f.qualityLabel?.replace('p', '') ?? '0', 10);
        // Ensure format has a valid absolute URL (explicit boolean return)
        return !!(q > 0 && q <= MAX_QUALITY_P && f.url && f.url.startsWith('http'));
      });

    if (eligible.length === 0) {
      return [
        { code: MEDIA_ERROR_CODES.NOT_FOUND, category: 'MEDIA', message: 'No valid format ≤ 720p available (decipher failed)' },
        null,
      ];
    }

    // -------------------------------------------------------------------
    // 2. Try to find a single muxed format (video + audio together).
    // -------------------------------------------------------------------
    const muxed = eligible
      .filter((f) => f.hasVideo && f.hasAudio)
      .sort((a, b) => qualityNum(b) - qualityNum(a))[0];

    if (muxed) {
      return [
        null,
        {
          platform: 'YouTube',
          videoUrl: muxed.url,
          caption: title,
          author,
        },
      ];
    }

    // -------------------------------------------------------------------
    // 3. DASH path — merge best video-only + best audio-only with ffmpeg.
    // -------------------------------------------------------------------
    const bestVideo = eligible
      .filter((f) => f.hasVideo && !f.hasAudio)
      .sort((a, b) => qualityNum(b) - qualityNum(a))[0];

    const bestAudio = eligible
      .filter((f) => f.hasAudio && !f.hasVideo)
      .sort((a, b) => {
        // Sort by bitrate descending for audio.
        const ab = parseInt(a.bitrate?.toString() ?? '0', 10);
        const bb = parseInt(b.bitrate?.toString() ?? '0', 10);
        return bb - ab;
      })[0];

    if (!bestVideo || !bestAudio) {
      return [
        { code: MEDIA_ERROR_CODES.NOT_FOUND, category: 'MEDIA', message: 'Could not find both video and audio DASH streams' },
        null,
      ];
    }

    const mergedStream = this.mergeDashStreams(videoId, bestVideo, bestAudio);

    return [
      null,
      {
        platform: 'YouTube',
        caption: title,
        author,
        muxedStream: mergedStream,
      },
    ];
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Creates two ytdl read streams (one video-only, one audio-only) and
   * pipes them through ffmpeg with `-c copy` (no re-encoding).
   * Returns a PassThrough stream that emits the merged MP4 container.
   *
   * @param videoId  - YouTube video ID (used by ytdl to create streams).
   * @param videoFmt - The selected video-only format descriptor.
   * @param audioFmt - The selected audio-only format descriptor.
   */
  private mergeDashStreams(
    videoId: string,
    videoFmt: ytdl.videoFormat,
    audioFmt: ytdl.videoFormat,
  ): Readable {
    const output = new PassThrough();

    const videoStream = ytdl(videoId, {
      format: videoFmt,
      requestOptions: {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      }
    });

    const audioStream = ytdl(videoId, {
      format: audioFmt,
      requestOptions: {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      }
    });

    // ffmpeg reads both streams, copies packets into a single MP4 container.
    ffmpeg()
      .input(videoStream)
      .input(audioStream)
      .outputOptions([
        '-c', 'copy',        // Stream-copy — no CPU-heavy re-encoding.
        '-f', 'mp4',         // Output container format.
        '-movflags', 'frag+empty_moov', // Makes the MP4 streamable (no seek needed).
      ])
      .pipe(output)
      .on('error', (err: Error) => {
        output.destroy(err);
      });

    return output;
  }
}

/**
 * Parses the numeric height from a format's `qualityLabel` (e.g. "720p" → 720).
 * Returns 0 when the label is missing or unparseable.
 */
function qualityNum(f: ytdl.videoFormat): number {
  return parseInt(f.qualityLabel?.replace('p', '') ?? '0', 10);
}
