/**
 * @module media/providers/instagram
 *
 * Extracts media from Instagram posts by scraping the embed page.
 *
 * The embed HTML contains a double-escaped GQL JSON payload with video
 * and image URLs.  This provider tries multiple extraction strategies in
 * order of reliability and normalises every discovered URL to an absolute
 * HTTPS address before returning it.
 *
 * URL normalisation handles:
 *  - Protocol-relative URLs (`//cdn.example.com/…` → `https://…`)
 *  - Escaped forward slashes left over from JSON (`\/`)
 *  - Unicode-escaped ampersands (`\u0026`)
 *  - HTML-encoded ampersands (`&amp;`)
 *  - Bare paths starting with `/` (prepends Instagram's origin)
 *
 * JSON extraction strategies (tried in order):
 *  1. **String-boundary walk** — locates the `gql_data` key, then walks
 *     character-by-character respecting escape sequences to find the
 *     exact start and end of the JSON string value.
 *  2. **Lazy regex** — multiple patterns that stop at the first plausible
 *     closing boundary.
 *  3. **Greedy regex** — original approach, last resort.
 *
 * After extraction the raw string is fed through up to three progressive
 * unescape passes (single → double → triple-escaped) until
 * `JSON.parse` succeeds.
 *
 * If all GQL strategies fail, three HTML-based fallbacks run:
 *  - `<meta property="og:video">` tag
 *  - Raw `video_url` key anywhere in the page
 *  - `Content` wrapper `src` attribute (GraphImage / EmbeddedMedia posts)
 */

import axios from 'axios';
import { MEDIA_ERROR_CODES } from '../types';
import type { MediaProvider, MediaInfo, Result, SyncResult } from '../types';
import { SMUDGE_HEADERS, sleep } from '../utils';

export class InstagramProvider implements MediaProvider {
  readonly platform = 'Instagram' as const;
  readonly statusMessage = '🔎 Instagram (Embed)...';
  readonly regex =
    /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/;

  private static readonly MAX_RETRIES = 3;
  private static readonly EMBED_BASE =
    'https://www.instagram.com/p/{id}/embed/captioned/';

  /**
   * Scrapes the Instagram embed page and extracts media metadata.
   * Uses capture group 1 (the post short-code) from the regex match.
   */
  async fetch(match: RegExpMatchArray): Result<MediaInfo> {
    const postId = match[1];
    if (!postId) {
      return [
        { code: MEDIA_ERROR_CODES.NOT_FOUND, category: 'MEDIA', message: 'Invalid post ID' },
        null,
      ];
    }

    const html = await this.fetchEmbedHtml(postId);
    if (!html) {
      return [
        { code: MEDIA_ERROR_CODES.FETCH_FAILED, category: 'MEDIA', message: 'Connection failed after retries' },
        null,
      ];
    }

    return this.parseGql(html) ?? this.parseFallbackMedia(html);
  }

  // -----------------------------------------------------------------------
  // Network
  // -----------------------------------------------------------------------

  /**
   * Fetches the embed page with exponential-backoff retries.
   * @returns Raw HTML string or `null` after all attempts fail.
   */
  private async fetchEmbedHtml(postId: string): Promise<string | null> {
    const url = InstagramProvider.EMBED_BASE.replace('{id}', postId);

    for (let attempt = 0; attempt < InstagramProvider.MAX_RETRIES; attempt++) {
      try {
        const { data } = await axios.get<string>(url, {
          headers: SMUDGE_HEADERS,
          responseType: 'text',
          timeout: 5_000,
        });
        if (data) return data;
      } catch {
        await sleep(1_000 * Math.pow(2, attempt));
      }
    }

    return null;
  }

  // -----------------------------------------------------------------------
  // URL normalisation
  // -----------------------------------------------------------------------

  /**
   * Converts any URL variant found in Instagram's embed into an absolute
   * HTTPS URL safe for downloading.
   *
   * @param raw - URL string as extracted from HTML/JSON (may be relative,
   *              protocol-relative, or contain escape artefacts).
   */
  private normalizeUrl(raw: string): string {
    let url = raw.trim();

    // Strip escape artefacts that survive JSON unescaping
    url = url.replace(/\\\//g, '/');
    url = url.replace(/\\u0026/g, '&');

    // Protocol-relative → absolute HTTPS
    if (url.startsWith('//')) {
      url = 'https:' + url;
    }

    // Bare path → absolute Instagram URL (rare, but seen in some embeds)
    if (/^\/[^/]/.test(url)) {
      url = 'https://www.instagram.com' + url;
    }

    // HTML-encoded ampersands
    url = url.replace(/&amp;/g, '&');
    url = url.replace(/amp;/g, '&');

    return url;
  }

  // -----------------------------------------------------------------------
  // GQL extraction — primary path
  // -----------------------------------------------------------------------

  /**
   * Tries to locate and parse the `gql_data` JSON block in the embed HTML.
   * @returns A successful `SyncResult<MediaInfo>`, or `null` when the block is
   *          absent or unparseable so the caller can try fallbacks.
   */
  private parseGql(html: string): SyncResult<MediaInfo> | null {
    const raw = this.extractGqlRaw(html);
    if (!raw) return null;

    const data = this.tryParseGql(raw);
    if (!data) return null;

    const media = data.shortcode_media ?? data.graphql?.shortcode_media;
    if (!media) return null;

    return [
      null,
      {
        platform: 'Instagram',
        videoUrl: media.video_url
          ? this.normalizeUrl(media.video_url)
          : undefined,
        imageUrl: media.display_url
          ? this.normalizeUrl(media.display_url)
          : undefined,
        author: media.owner?.username,
        caption:
          media.edge_media_to_caption?.edges?.[0]?.node?.text ?? '',
      },
    ];
  }

  /**
   * Extracts the raw (still-escaped) gql_data string from the HTML.
   *
   * Three strategies are tried in order:
   *  1. Character walk — most precise, immune to greedy/lazy issues.
   *  2. Lazy regex set — quick patterns that stop at the first boundary.
   *  3. Greedy regex — original approach, last resort.
   *
   * Every strategy validates that the captured content contains
   * `shortcode_media` before accepting it.
   */
  private extractGqlRaw(html: string): string | null {
    // Strategy 1 — string-boundary walk
    const walked = this.walkStringValue(html);
    if (walked) return walked;

    // Strategy 2 — lazy regex patterns
    const lazyPatterns: RegExp[] = [
      /\\"gql_data\\"\s*:\s*\\"([\s\S]*?)\\"\s*\}/,
      /\\"gql_data\\"\s*:\s*([\s\S]*?)\}\\"\}/,
      /"gql_data"\s*:\s*"([\s\S]*?)"\s*\}/,
    ];

    for (const pattern of lazyPatterns) {
      const m = html.match(pattern);
      if (m?.[1]?.includes('shortcode_media')) return m[1];
    }

    // Strategy 3 — greedy (original)
    const greedy = html.match(/\\"gql_data\\":([\s\S]*)\}"\}/);
    if (greedy?.[1]?.includes('shortcode_media')) return greedy[1];

    return null;
  }

  /**
   * Walks the HTML character-by-character from the `gql_data` key to
   * locate the opening and closing quotes of its string value.
   *
   * Escape handling:
   *  - On `\` the next character is always skipped (consumed as escaped).
   *  - The first unescaped `"` after the opening quote ends the value.
   *  - This correctly handles `\"` (escaped quote inside the string)
   *    and `\\"` (escaped backslash followed by a real closing quote).
   *
   * Both `"gql_data":` and `\"gql_data\":` markers are attempted to
   * cover single and double-escaped embed formats.
   *
   * @returns The raw content between the quotes, or `null`.
   */
  private walkStringValue(html: string): string | null {
    const markers = ['\\"gql_data\\":', '"gql_data":'];

    for (const marker of markers) {
      const idx = html.indexOf(marker);
      if (idx === -1) continue;

      let pos = idx + marker.length;

      // Skip optional whitespace between `:` and the value
      while (pos < html.length && html[pos] === ' ') pos++;

      // Detect the opening quote — plain `"` or escaped `\"`
      let start = -1;
      if (html[pos] === '"') {
        start = pos + 1;
      } else if (html[pos] === '\\' && html[pos + 1] === '"') {
        start = pos + 2;
      }
      if (start === -1) continue;

      // Walk forward; `\` always consumes the next char
      for (let i = start; i < html.length; i++) {
        if (html[i] === '\\') {
          i++; // skip the escaped character
          continue;
        }
        if (html[i] === '"') {
          const extracted = html.substring(start, i);
          if (extracted.includes('shortcode_media')) return extracted;
          break; // wrong string — try next marker
        }
      }
    }

    return null;
  }

  // -----------------------------------------------------------------------
  // JSON unescaping
  // -----------------------------------------------------------------------

  /**
   * Runs one unescape pass over a double-escaped JSON string.
   * Order: backslashes first so subsequent replacements see reduced sequences.
   */
  private unescapeOnce(raw: string): string {
    return raw
      .replace(/\\\\/g, '\\')
      .replace(/\\"/g, '"')
      .replace(/\\\//g, '/');
  }

  /**
   * Attempts to parse the raw gql content with progressive unescaping.
   * Tries the raw string first, then applies up to three unescape passes
   * to handle single, double, or triple-escaped payloads.
   *
   * @returns Parsed object or `null` if all attempts fail.
   */
  private tryParseGql(raw: string): any | null {
    let current = raw;

    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return JSON.parse(current);
      } catch {
        current = this.unescapeOnce(current);
      }
    }

    return null;
  }

  // -----------------------------------------------------------------------
  // HTML fallbacks — secondary path
  // -----------------------------------------------------------------------

  /**
   * Extracts media from raw HTML when GQL parsing fails entirely.
   * Tries three selectors in order:
   *  1. `og:video` meta tag (video posts)
   *  2. `video_url` key anywhere in the page source
   *  3. `src` attribute inside a `Content` wrapper (image posts)
   *
   * All discovered URLs are normalised before being returned.
   */
  private parseFallbackMedia(html: string): SyncResult<MediaInfo> {
    // 1. og:video meta tag
    const ogVideo = html.match(
      /<meta[^>]+property="og:video"[^>]+content="([^"]+)"/,
    );
    if (ogVideo?.[1]) {
      return [
        null,
        { platform: 'Instagram', videoUrl: this.normalizeUrl(ogVideo[1]) },
      ];
    }

    // 2. Raw video_url key (may appear outside the GQL block)
    const directVideo = html.match(
      /["']video_url["']\s*:\s*["']([^"']+)["']/,
    );
    if (directVideo?.[1]) {
      return [
        null,
        { platform: 'Instagram', videoUrl: this.normalizeUrl(directVideo[1]) },
      ];
    }

    // 3. Image src inside Content wrapper
    if (html.includes('GraphImage') || html.includes('EmbeddedMedia')) {
      const srcMatch = html.match(/class="Content[\s\S]*?src="([^"]+)"/);
      if (srcMatch?.[1]) {
        return [
          null,
          { platform: 'Instagram', imageUrl: this.normalizeUrl(srcMatch[1]) },
        ];
      }
    }

    return [
      {
        code: MEDIA_ERROR_CODES.NOT_FOUND,
        category: 'MEDIA',
        message: 'No media found in embed',
      },
      null,
    ];
  }
}
