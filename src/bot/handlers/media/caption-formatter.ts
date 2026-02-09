/**
 * @module media/caption-formatter
 * Shared constants and text formatting helpers for the media pipeline.
 */

/** Chrome-like HTTP headers used for scraping requests. */
export const SMUDGE_HEADERS: Record<string, string> = {
  'accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,' +
    'image/avif,image/webp,image/apng,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'connection': 'close',
  'sec-fetch-mode': 'navigate',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
  'viewport-width': '1280',
};

/**
 * Escapes characters reserved by Telegram MarkdownV2.
 * @param text - Raw string.
 */
export function escapeMarkdown(text: string): string {
  if (!text) return '';
  return text.replace(/[_*[\\\]()~`>#+\-=|}{. !]/g, '\\$&');
}

/**
 * Truncates text and appends `...` when it exceeds `limit`.
 * @param text  - String to truncate.
 * @param limit - Max character count (default 800).
 */
export function truncate(text: string, limit: number = 800): string {
  if (text.length <= limit) return text;
  return text.substring(0, limit - 3) + '...';
}

/**
 * Async delay helper.
 * @param ms - Milliseconds to wait.
 */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
