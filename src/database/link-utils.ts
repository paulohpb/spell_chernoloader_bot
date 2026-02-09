/**
 * =============================================================================
 * Link Utilities - URL normalization and extraction for duplicate detection
 * =============================================================================
 */

/**
 * Common tracking parameters to remove from URLs
 */
const TRACKING_PARAMS = new Set([
  // UTM parameters
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  // Social media
  'fbclid', 'igshid', 'igsh', 's', 't', 'si',
  // Analytics
  'ref', 'source', 'mc_cid', 'mc_eid',
  // Twitter/X
  'ref_src', 'ref_url',
  // YouTube
  'feature', 'ab_channel',
  // General
  'share', 'shared', 'from',
]);

/**
 * Patterns for extracting content IDs from social media URLs
 */
const CONTENT_PATTERNS: Array<{
  pattern: RegExp;
  normalize: (match: RegExpMatchArray) => string;
}> = [
  // Instagram posts/reels
  {
    pattern: /instagram\.com\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/i,
    normalize: (m) => `instagram.com/p/${m[1]}`,
  },
  // Twitter/X posts
  {
    pattern: /(?:twitter\.com|x\.com)\/([A-Za-z0-9_]+)\/status\/(\d+)/i,
    normalize: (m) => `x.com/${m[1].toLowerCase()}/status/${m[2]}`,
  },
  // YouTube videos
  {
    pattern: /(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/i,
    normalize: (m) => `youtube.com/watch?v=${m[1]}`,
  },
  // YouTube shorts
  {
    pattern: /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/i,
    normalize: (m) => `youtube.com/shorts/${m[1]}`,
  },
  // TikTok videos
  {
    pattern: /tiktok\.com\/@([^\/]+)\/video\/(\d+)/i,
    normalize: (m) => `tiktok.com/@${m[1].toLowerCase()}/video/${m[2]}`,
  },
  // TikTok short links
  {
    pattern: /vm\.tiktok\.com\/([A-Za-z0-9]+)/i,
    normalize: (m) => `vm.tiktok.com/${m[1]}`,
  },
  // Reddit posts
  {
    pattern: /reddit\.com\/r\/([^\/]+)\/comments\/([A-Za-z0-9]+)/i,
    normalize: (m) => `reddit.com/r/${m[1].toLowerCase()}/comments/${m[2]}`,
  },
  // Threads
  {
    pattern: /threads\.net\/@([^\/]+)\/post\/([A-Za-z0-9_-]+)/i,
    normalize: (m) => `threads.net/@${m[1].toLowerCase()}/post/${m[2]}`,
  },
];

/**
 * Extracts all URLs from a text message
 */
export function extractUrls(text: string): string[] {
  const urlPattern = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
  const matches = text.match(urlPattern);
  
  if (!matches) return [];
  
  return matches.map(url => url.replace(/[.,;:!?)]+$/, ''));
}

/**
 * Normalizes a URL for comparison.
 */
export function normalizeUrl(url: string): string {
  // Check specific content patterns first (e.g. Reels, YouTube IDs)
  for (const { pattern, normalize } of CONTENT_PATTERNS) {
    const match = url.match(pattern);
    if (match) return normalize(match);
  }

  const parsed = safeParseUrl(url);
  if (!parsed) return url.toLowerCase();

  // Remove tracking parameters generically
  const cleanParams = new URLSearchParams();
  parsed.searchParams.forEach((value, key) => {
    if (!TRACKING_PARAMS.has(key.toLowerCase())) {
      cleanParams.set(key.toLowerCase(), value);
    }
  });

  let normalized = parsed.hostname.toLowerCase();
  if (normalized.startsWith('www.')) normalized = normalized.slice(4);

  let pathname = parsed.pathname;
  if (pathname.endsWith('/') && pathname.length > 1) pathname = pathname.slice(0, -1);
  
  normalized += pathname.toLowerCase();
  const paramsString = cleanParams.toString();
  if (paramsString) normalized += '?' + paramsString;

  return normalized;
}

function safeParseUrl(url: string): URL | null {
  try { return new URL(url); } catch { return null; }
}

/**
 * Extracts and normalizes ALL links found in a message.
 * No domain restriction.
 */
export function extractAndNormalizeUrls(text: string): Array<{ original: string; normalized: string }> {
  const urls = extractUrls(text);
  return urls.map(url => ({
    original: url,
    normalized: normalizeUrl(url),
  }));
}