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
  // Match URLs with common protocols
  const urlPattern = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
  const matches = text.match(urlPattern);
  
  if (!matches) return [];
  
  // Clean up trailing punctuation
  return matches.map(url => {
    // Remove trailing punctuation that's likely not part of the URL
    return url.replace(/[.,;:!?)]+$/, '');
  });
}

/**
 * Normalizes a URL for comparison.
 * 
 * - Removes tracking parameters
 * - Extracts content IDs for known platforms
 * - Lowercases hostname
 * - Removes www prefix
 * - Removes trailing slashes
 */
export function normalizeUrl(url: string): string {
  // First, check if it matches a known content pattern
  for (const { pattern, normalize } of CONTENT_PATTERNS) {
    const match = url.match(pattern);
    if (match) {
      return normalize(match);
    }
  }

  // Generic URL normalization
  const parsed = safeParseUrl(url);
  if (!parsed) return url.toLowerCase();

  // Remove tracking parameters
  const cleanParams = new URLSearchParams();
  parsed.searchParams.forEach((value, key) => {
    if (!TRACKING_PARAMS.has(key.toLowerCase())) {
      cleanParams.set(key.toLowerCase(), value);
    }
  });

  // Build normalized URL
  let normalized = parsed.hostname.toLowerCase();
  
  // Remove www prefix
  if (normalized.startsWith('www.')) {
    normalized = normalized.slice(4);
  }

  // Add path (remove trailing slash)
  let pathname = parsed.pathname;
  if (pathname.endsWith('/') && pathname.length > 1) {
    pathname = pathname.slice(0, -1);
  }
  normalized += pathname.toLowerCase();

  // Add cleaned params if any
  const paramsString = cleanParams.toString();
  if (paramsString) {
    normalized += '?' + paramsString;
  }

  return normalized;
}

/**
 * Safely parses a URL, returning null on failure
 */
function safeParseUrl(url: string): URL | null {
  return Promise.resolve()
    .then(() => new URL(url))
    .catch(() => null) as unknown as URL | null;
  
  // Sync version for simplicity
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Checks if a URL is a social media or content link worth tracking
 */
export function isTrackableUrl(url: string): boolean {
  const trackableDomains = [
    'instagram.com',
    'twitter.com',
    'x.com',
    'youtube.com',
    'youtu.be',
    'tiktok.com',
    'vm.tiktok.com',
    'reddit.com',
    'threads.net',
    'facebook.com',
    'fb.watch',
    'twitch.tv',
    'clips.twitch.tv',
  ];

  const normalizedLower = url.toLowerCase();
  return trackableDomains.some(domain => normalizedLower.includes(domain));
}

/**
 * Extracts and normalizes all trackable URLs from a message
 */
export function extractTrackableUrls(text: string): Array<{ original: string; normalized: string }> {
  const urls = extractUrls(text);
  const results: Array<{ original: string; normalized: string }> = [];

  for (const url of urls) {
    if (isTrackableUrl(url)) {
      results.push({
        original: url,
        normalized: normalizeUrl(url),
      });
    }
  }

  return results;
}
