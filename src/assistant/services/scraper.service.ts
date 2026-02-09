/**
 * @module services/scraper
 *
 * Web scraping service for extracting readable content from URLs.
 * Handles HTTP fetching, content-type validation, HTML stripping,
 * and text normalization in a reusable way.
 *
 * Implements multiple bypass strategies for sites that block bots:
 * - Rotates User-Agent strings across common browsers
 * - Sends realistic browser header sets (Accept, Accept-Language, etc.)
 * - Retries with different User-Agent on 403/429 responses
 * - Follows redirects transparently
 *
 * Factory pattern — returns a Result tuple to avoid throwing exceptions.
 */

import axios, { AxiosRequestConfig } from 'axios';
import { AppError, Result } from '../types';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Maximum response body size accepted (bytes). */
const MAX_CONTENT_LENGTH = 5 * 1024 * 1024; // 5 MB

/** Network timeout in milliseconds. */
const REQUEST_TIMEOUT_MS = 20000;

/** Minimum text length after stripping HTML to consider valid content. */
const MIN_VALID_TEXT_LENGTH = 50;

/** Number of retry attempts with different User-Agent on block responses. */
const MAX_RETRIES = 3;

/** HTTP status codes that indicate bot blocking — triggers a retry. */
const BLOCKABLE_STATUS_CODES = [403, 429, 503];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScraperServiceConfig {
  /** Optional custom User-Agent string. */
  userAgent?: string;
  /** Optional custom timeout (ms). */
  timeoutMs?: number;
  /** Optional custom max content length (bytes). */
  maxContentLength?: number;
}

export interface ScrapedContent {
  /** The original URL that was fetched. */
  url: string;
  /** Extracted plain text content. */
  text: string;
  /** Response content-type header value. */
  contentType: string;
  /** Final URL after redirects (if any). */
  finalUrl: string;
}

export interface ScraperService {
  /** Fetches and extracts text from a URL. */
  scrape: (url: string) => Result<ScrapedContent>;
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const SCRAPER_ERROR_CODES = {
  INVALID_URL: 'SCRAPER_INVALID_URL',
  NETWORK_ERROR: 'SCRAPER_NETWORK_ERROR',
  INVALID_CONTENT_TYPE: 'SCRAPER_INVALID_CONTENT_TYPE',
  CONTENT_TOO_SHORT: 'SCRAPER_CONTENT_TOO_SHORT',
  TIMEOUT: 'SCRAPER_TIMEOUT',
  BLOCKED: 'SCRAPER_BLOCKED',
} as const;

// ---------------------------------------------------------------------------
// User-Agent rotation pool
// ---------------------------------------------------------------------------

/**
 * Pool of realistic browser User-Agent strings.
 * Rotated on each request and on retries to avoid fingerprinting.
 */
const USER_AGENTS = [
  // Chrome on Windows
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  // Chrome on macOS
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  // Firefox on Windows
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
  // Firefox on macOS
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:126.0) Gecko/20100101 Firefox/126.0',
  // Safari on macOS
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  // Edge on Windows
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0',
  // Chrome on Linux
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  // Firefox on Linux
  'Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0',
];

/** Current index into the User-Agent pool. Incremented on every request. */
let uaIndex = 0;

/**
 * Returns the next User-Agent from the rotation pool.
 * Optionally skips a specific index to guarantee a different agent on retry.
 *
 * @param skipIndex - Index to avoid (used during retries to ensure rotation).
 */
function getNextUserAgent(skipIndex?: number): { agent: string; index: number } {
  let next = (uaIndex + 1) % USER_AGENTS.length;

  // If we need to skip the previous index, advance one more
  if (skipIndex !== undefined && next === skipIndex) {
    next = (next + 1) % USER_AGENTS.length;
  }

  uaIndex = next;
  return { agent: USER_AGENTS[next], index: next };
}

// ---------------------------------------------------------------------------
// Header builders
// ---------------------------------------------------------------------------

/**
 * Builds a realistic browser header set based on the User-Agent string.
 * Chrome and Edge get a different Accept header than Firefox and Safari
 * to match what each browser actually sends.
 *
 * @param userAgent - The User-Agent string to base headers on.
 */
function buildHeaders(userAgent: string): Record<string, string> {
  const isFirefox = userAgent.includes('Firefox');
  const isSafari = userAgent.includes('Safari') && !userAgent.includes('Chrome');

  // Accept header varies by browser engine
  const accept = isFirefox
    ? 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
    : isSafari
      ? 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
      : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';

  return {
    'User-Agent': userAgent,
    'Accept': accept,
    'Accept-Language': 'en-US,en;q=0.9,pt-BR;q=0.8,pt;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Connection': 'keep-alive',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'DNT': '1',
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Validates if a string is a well-formed HTTP/HTTPS URL.
 */
function isValidUrl(text: string): boolean {
  try {
    const parsed = new URL(text);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Checks if a content-type header indicates HTML content.
 */
function isHtmlContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return lower.includes('text/html') || lower.includes('application/xhtml');
}

/**
 * Strips HTML tags and normalizes whitespace into readable plain text.
 * Removes script, style, SVG, noscript blocks entirely
 * before stripping tags to maximize signal-to-noise ratio.
 *
 * @param html - Raw HTML string from the fetched page.
 * @returns Cleaned plain-text content.
 */
function stripHtml(html: string): string {
  return html
    // Remove script, style, svg, noscript blocks entirely
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '')
    // Remove nav, footer, aside — common non-article containers
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, '')
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, '')
    .replace(/<aside\b[^<]*(?:(?!<\/aside>)<[^<]*)*<\/aside>/gi, '')
    // Remove all remaining tags
    .replace(/<[^>]+>/g, ' ')
    // Decode common HTML entities
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…')
    .replace(/&#\d+;/g, ' ')     // Strip remaining numeric entities
    .replace(/&\w+;/g, ' ')      // Strip remaining named entities
    // Collapse runs of whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a web scraper service instance.
 *
 * @param config - Optional configuration for timeout, max content length, etc.
 */
export function createScraperService(
  config: ScraperServiceConfig = {},
): [AppError | null, ScraperService | null] {
  const timeoutMs = config.timeoutMs || REQUEST_TIMEOUT_MS;
  const maxContentLength = config.maxContentLength || MAX_CONTENT_LENGTH;

  /**
   * Attempts a single HTTP GET request with the given User-Agent index.
   * Returns the axios response or null on failure, along with the status
   * code so the caller can decide whether to retry.
   *
   * @param url       - Target URL.
   * @param uaIdx     - Index into the User-Agent pool to use.
   * @returns Tuple of [response | null, statusCode | null].
   */
  async function attemptFetch(
    url: string,
    uaIdx: number,
  ): Promise<[any, number | null]> {
    const userAgent = USER_AGENTS[uaIdx];
    const headers = buildHeaders(userAgent);

    const requestConfig: AxiosRequestConfig = {
      timeout: timeoutMs,
      maxContentLength,
      headers,
      responseType: 'text',
      maxRedirects: 10,
      // Accept any 2xx or blockable codes — we handle those manually
      validateStatus: (status) =>
        (status >= 200 && status < 300) || BLOCKABLE_STATUS_CODES.includes(status),
    };

    return axios
      .get<string>(url, requestConfig)
      .then((res): [any, number | null] => [res, res.status])
      .catch((err) => {
        // If axios throws but we have a response (e.g. non-2xx outside our
        // validateStatus), capture the status for retry logic
        if (err.response?.status) {
          return [null, err.response.status as number];
        }
        return [null, null];
      });
  }

  /**
   * Scrapes a URL and extracts readable text content.
   * Retries with different User-Agents on blockable status codes.
   *
   * @param url - Target URL to fetch.
   * @returns Result tuple with ScrapedContent or AppError.
   */
  async function scrape(url: string): Result<ScrapedContent> {
    // Validate URL format
    if (!isValidUrl(url)) {
      return [
        {
          code: SCRAPER_ERROR_CODES.INVALID_URL,
          category: 'CONFIGURATION',
          message: 'URL inválida',
          details: url,
        },
        null,
      ];
    }

    let lastStatus: number | null = null;
    let currentUaIdx: number | undefined = undefined;

    // Retry loop — each iteration rotates to a different User-Agent
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const { agent: _agent, index: nextIdx } = getNextUserAgent(currentUaIdx);
      currentUaIdx = nextIdx;

      const [response, status] = await attemptFetch(url, currentUaIdx);
      lastStatus = status;

      // If we got no response at all, it was a network-level error
      if (!response) {
        // If the status was blockable, continue to next retry with rotated UA
        if (status && BLOCKABLE_STATUS_CODES.includes(status)) {
          continue;
        }
        // Otherwise it's a hard network failure — no point retrying
        break;
      }

      // Got a response — check if it's a block we should retry
      if (BLOCKABLE_STATUS_CODES.includes(response.status)) {
        continue;
      }

      // Success — process the response
      const contentType = response.headers['content-type'] || '';
      const finalUrl = response.request?.res?.responseUrl || url;

      if (!isHtmlContentType(contentType)) {
        return [
          {
            code: SCRAPER_ERROR_CODES.INVALID_CONTENT_TYPE,
            category: 'MEDIA',
            message: 'Tipo de conteúdo não suportado',
            details: `Expected HTML, got: ${contentType}`,
          },
          null,
        ];
      }

      const text = stripHtml(response.data);

      if (text.length < MIN_VALID_TEXT_LENGTH) {
        return [
          {
            code: SCRAPER_ERROR_CODES.CONTENT_TOO_SHORT,
            category: 'MEDIA',
            message: 'Conteúdo extraído insuficiente',
            details: `Got ${text.length} chars, minimum is ${MIN_VALID_TEXT_LENGTH}`,
          },
          null,
        ];
      }

      return [
        null,
        {
          url,
          text,
          contentType,
          finalUrl,
        },
      ];
    }

    // Exhausted all retries — determine the error type
    if (lastStatus && BLOCKABLE_STATUS_CODES.includes(lastStatus)) {
      return [
        {
          code: SCRAPER_ERROR_CODES.BLOCKED,
          category: 'MEDIA',
          message: 'Site bloqueou o acesso',
          details: `Status ${lastStatus} after ${MAX_RETRIES} attempts`,
        },
        null,
      ];
    }

    if (lastStatus === null) {
      // lastStatus being null after the loop means we never got any
      // response at all — pure network failure on every attempt
      return [
        {
          code: SCRAPER_ERROR_CODES.TIMEOUT,
          category: 'LLM',
          message: 'Tempo limite excedido ao acessar a URL',
          details: `No response after ${MAX_RETRIES} attempts`,
        },
        null,
      ];
    }

    return [
      {
        code: SCRAPER_ERROR_CODES.NETWORK_ERROR,
        category: 'LLM',
        message: 'Erro ao acessar a URL',
        details: `Last status: ${lastStatus}`,
      },
      null,
    ];
  }

  return [null, { scrape }];
}