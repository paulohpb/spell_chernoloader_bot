/**
 * @module media/downloader
 * Stream-based media download.
 * Returns a Node.js Readable instead of buffering the full file in memory,
 * which keeps RAM usage constant regardless of file size.
 */

import { Readable } from 'stream';
import axios from 'axios';
import { MEDIA_ERROR_CODES } from './types';
import type { Result } from './types';
import { SMUDGE_HEADERS } from './utils';

/**
 * Opens an HTTP stream to the given media URL.
 * The returned `Readable` can be passed directly to Grammy's `InputFile`.
 *
 * @param url - Direct URL to the media file.
 * @returns `[null, Readable]` on success, `[error, null]` on failure.
 */
export async function downloadStream(
  url: string,
): Promise<Result<Readable>> {
  if (!url || !url.startsWith('http')) {
    return [
      {
        code: MEDIA_ERROR_CODES.DOWNLOAD_FAILED,
        category: 'MEDIA',
        message: `URL inválida ou não absoluta: ${url}`,
      },
      null,
    ];
  }

  try {
    const response = await axios.get(url, {
      responseType: 'stream',
      headers: SMUDGE_HEADERS,
      timeout: 30_000,
    });

    return [null, response.data as Readable];
  } catch (e: any) {
    return [
      {
        code: MEDIA_ERROR_CODES.DOWNLOAD_FAILED,
        category: 'MEDIA',
        message: e.message,
      },
      null,
    ];
  }
}
