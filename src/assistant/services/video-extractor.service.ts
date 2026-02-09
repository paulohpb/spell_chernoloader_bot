/**
 * @module services/video-extractor
 *
 * Video extraction service that shells out to yt-dlp to download
 * video content from YouTube (and other supported sites).
 *
 * Downloads are written to a temporary directory and are scoped to a
 * single operation — the caller is responsible for cleanup via the
 * {@link VideoExtractorService.cleanup} method after processing.
 *
 * Factory pattern — returns a Result tuple to avoid throwing exceptions.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { AppError, Result } from '../types';

// ---------------------------------------------------------------------------
// Promisified child_process
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum video duration in seconds that we'll attempt to download (10 min). */
const MAX_VIDEO_DURATION_SECONDS = 600;

/** Maximum file size in bytes we accept after download (200 MB). */
const MAX_FILE_SIZE_BYTES = 200 * 1024 * 1024;

/** Timeout for the yt-dlp process in milliseconds (5 min). */
const YTDLP_TIMEOUT_MS = 300000;

/** Name of the subdirectory inside os.tmpdir() for video downloads. */
const TEMP_DIR_NAME = 'telegram-bot-videos';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VideoExtractorServiceConfig {
  /** Path to the yt-dlp binary. Defaults to `yt-dlp` (assumes PATH). */
  ytdlpPath?: string;
  /** Max video duration in seconds. Defaults to {@link MAX_VIDEO_DURATION_SECONDS}. */
  maxDurationSeconds?: number;
  /** Max downloaded file size in bytes. Defaults to {@link MAX_FILE_SIZE_BYTES}. */
  maxFileSizeBytes?: number;
}

/**
 * Metadata extracted from a video before downloading.
 */
export interface VideoMetadata {
  /** Video title as reported by the source. */
  title: string;
  /** Duration in seconds. */
  duration: number;
  /** Channel or uploader name. */
  uploader: string;
  /** Direct video URL (canonical). */
  url: string;
}

/**
 * Result of a successful extraction — contains the path to the downloaded
 * file and its associated metadata.
 */
export interface ExtractedVideo {
  /** Absolute path to the downloaded video file on disk. */
  filePath: string;
  /** MIME type of the downloaded file (e.g. `video/mp4`). */
  mimeType: string;
  /** Metadata extracted before download. */
  metadata: VideoMetadata;
}

export interface VideoExtractorService {
  /**
   * Extracts metadata from a video URL without downloading the full file.
   */
  getMetadata: (url: string) => Result<VideoMetadata>;

  /**
   * Downloads a video to a temp file and returns its path and metadata.
   */
  extract: (url: string) => Result<ExtractedVideo>;

  /**
   * Deletes a previously downloaded temp file.
   * Safe to call with paths that don't exist — it simply no-ops.
   */
  cleanup: (filePath: string) => void;
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const VIDEO_EXTRACTOR_ERROR_CODES = {
  INVALID_URL: 'VIDEO_INVALID_URL',
  YTDLP_NOT_FOUND: 'VIDEO_YTDLP_NOT_FOUND',
  METADATA_FAILED: 'VIDEO_METADATA_FAILED',
  DURATION_EXCEEDED: 'VIDEO_DURATION_EXCEEDED',
  DOWNLOAD_FAILED: 'VIDEO_DOWNLOAD_FAILED',
  FILE_TOO_LARGE: 'VIDEO_FILE_TOO_LARGE',
  TIMEOUT: 'VIDEO_TIMEOUT',
  UNSUPPORTED_SITE: 'VIDEO_UNSUPPORTED_SITE',
} as const;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Validates that a string looks like a supported video URL.
 * Currently checks for http/https scheme only — yt-dlp itself
 * will reject truly unsupported URLs during metadata extraction.
 */
function isValidVideoUrl(text: string): boolean {
  try {
    const parsed = new URL(text);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Ensures the temp directory exists, creating it if necessary.
 * Returns the absolute path to the directory.
 */
function getTempDir(): string {
  const dir = path.join(os.tmpdir(), TEMP_DIR_NAME);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Generates a unique filename inside the temp directory.
 * Uses a random hex string to avoid collisions between concurrent requests.
 *
 * @returns Absolute path like `/tmp/telegram-bot-videos/a1b2c3d4.%(ext)s`
 *          The `%(ext)s` placeholder is replaced by yt-dlp at download time.
 */
function generateTempPath(): string {
  const id = crypto.randomBytes(8).toString('hex');
  return path.join(getTempDir(), `${id}.%(ext)s`);
}

/**
 * Resolves the actual filename on disk after yt-dlp has replaced
 * the `%(ext)s` placeholder. Looks for any file in the temp directory
 * that starts with the given base name prefix.
 *
 * @param templatePath - The path with `%(ext)s` that was passed to yt-dlp.
 * @returns The resolved absolute path, or `null` if no matching file exists.
 */
function resolveDownloadedFile(templatePath: string): string | null {
  const dir = path.dirname(templatePath);
  // Strip the %(ext)s suffix to get the unique prefix
  const prefix = path.basename(templatePath).replace('.%(ext)s', '');

  const files = fs.readdirSync(dir);
  const match = files.find((f) => f.startsWith(prefix));

  return match ? path.join(dir, match) : null;
}

/**
 * Derives a MIME type string from a file extension.
 * Covers the formats yt-dlp commonly outputs.
 */
function mimeFromExtension(ext: string): string {
  const map: Record<string, string> = {
    mp4: 'video/mp4',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    mov: 'video/quicktime',
    flv: 'video/x-flv',
    ts: 'video/mp2t',
    '3gpp': 'video/3gpp',
  };
  return map[ext.toLowerCase()] || 'video/mp4';
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a video extractor service instance.
 *
 * @param config - Optional configuration. All fields have sensible defaults.
 */
export function createVideoExtractorService(
  config: VideoExtractorServiceConfig = {},
): [AppError | null, VideoExtractorService | null] {
  const ytdlpPath = config.ytdlpPath || 'yt-dlp';
  const maxDuration = config.maxDurationSeconds || MAX_VIDEO_DURATION_SECONDS;
  const maxFileSize = config.maxFileSizeBytes || MAX_FILE_SIZE_BYTES;

  // ---------------------------------------------------------------------------
  // getMetadata
  // ---------------------------------------------------------------------------

  /**
   * Runs yt-dlp in metadata-only mode (`--print`) to extract video info
   * without downloading. Parses the JSON output to populate VideoMetadata.
   *
   * @param url - Video URL to query.
   */
  async function getMetadata(url: string): Result<VideoMetadata> {
    if (!isValidVideoUrl(url)) {
      return [
        {
          code: VIDEO_EXTRACTOR_ERROR_CODES.INVALID_URL,
          category: 'CONFIGURATION',
          message: 'URL de vídeo inválida',
          details: url,
        },
        null,
      ];
    }

    return execFileAsync(ytdlpPath, [
      '--print', '%(title)s\n%(duration)s\n%(uploader)s\n%(url)s',
      '--no-warnings',
      '--default-search', 'ytsearch',
      url,
    ], { timeout: YTDLP_TIMEOUT_MS })
      .then(({ stdout }): [AppError | null, VideoMetadata | null] => {
        const lines = stdout.trim().split('\n');

        if (lines.length < 4) {
          return [
            {
              code: VIDEO_EXTRACTOR_ERROR_CODES.METADATA_FAILED,
              category: 'MEDIA',
              message: 'Falha ao extrair metadados do vídeo',
              details: `Unexpected output format: ${stdout.slice(0, 200)}`,
            },
            null,
          ];
        }

        const duration = parseInt(lines[1], 10);

        if (isNaN(duration)) {
          return [
            {
              code: VIDEO_EXTRACTOR_ERROR_CODES.METADATA_FAILED,
              category: 'MEDIA',
              message: 'Duração do vídeo não pôde ser determinada',
              details: `Raw duration value: "${lines[1]}"`,
            },
            null,
          ];
        }

        if (duration > maxDuration) {
          const maxMinutes = Math.floor(maxDuration / 60);
          const videoDuration = Math.floor(duration / 60);
          return [
            {
              code: VIDEO_EXTRACTOR_ERROR_CODES.DURATION_EXCEEDED,
              category: 'MEDIA',
              message: `Vídeo muito longo: ${videoDuration} min (máximo: ${maxMinutes} min)`,
              details: `Duration: ${duration}s, limit: ${maxDuration}s`,
            },
            null,
          ];
        }

        return [
          null,
          {
            title: lines[0] || 'Sem título',
            duration,
            uploader: lines[2] || 'Desconhecido',
            url: lines[3] || url,
          },
        ];
      })
      .catch((err: any): [AppError | null, VideoMetadata | null] => {
        // yt-dlp not found on system PATH
        if (err.code === 'ENOENT') {
          return [
            {
              code: VIDEO_EXTRACTOR_ERROR_CODES.YTDLP_NOT_FOUND,
              category: 'CONFIGURATION',
              message: 'yt-dlp não encontrado no sistema',
              details: `Tried path: ${ytdlpPath}`,
            },
            null,
          ];
        }

        // Process timed out
        if (err.killed || err.signal === 'SIGTERM') {
          return [
            {
              code: VIDEO_EXTRACTOR_ERROR_CODES.TIMEOUT,
              category: 'MEDIA',
              message: 'Tempo limite excedido ao buscar metadados',
              details: err.message,
            },
            null,
          ];
        }

        // yt-dlp stderr often contains "unsupported URL" for unknown sites
        const stderr = (err.stderr || '').toString().toLowerCase();
        if (stderr.includes('unsupported url') || stderr.includes('is not a valid url')) {
          return [
            {
              code: VIDEO_EXTRACTOR_ERROR_CODES.UNSUPPORTED_SITE,
              category: 'MEDIA',
              message: 'Site não suportado pelo extrator',
              details: err.stderr?.toString().slice(0, 300),
            },
            null,
          ];
        }

        return [
          {
            code: VIDEO_EXTRACTOR_ERROR_CODES.METADATA_FAILED,
            category: 'MEDIA',
            message: 'Erro ao extrair metadados',
            details: err.stderr?.toString().slice(0, 300) || err.message,
          },
          null,
        ];
      });
  }

  // ---------------------------------------------------------------------------
  // extract
  // ---------------------------------------------------------------------------

  /**
   * Downloads a video to a temp file. Runs metadata extraction first to
   * enforce duration limits before committing to a download.
   * Uses the `best` format selector with a file-size cap.
   *
   * @param url - Video URL to download.
   */
  async function extract(url: string): Result<ExtractedVideo> {
    // Step 1: validate metadata and duration before downloading
    const [metaError, metadata] = await getMetadata(url);
    if (metaError || !metadata) {
      return [metaError, null];
    }

    // Step 2: download to temp file
    const templatePath = generateTempPath();

    return execFileAsync(ytdlpPath, [
      '--format', 'best[filesize<200M]/best',
      '--output', templatePath,
      '--no-warnings',
      '--no-progress',
      '--restrict-filenames',
      url,
    ], { timeout: YTDLP_TIMEOUT_MS, maxBuffer: 50 * 1024 * 1024 })
      .then((): [AppError | null, ExtractedVideo | null] => {
        // Step 3: resolve the actual filename (yt-dlp replaced %(ext)s)
        const filePath = resolveDownloadedFile(templatePath);

        if (!filePath) {
          return [
            {
              code: VIDEO_EXTRACTOR_ERROR_CODES.DOWNLOAD_FAILED,
              category: 'MEDIA',
              message: 'Arquivo não encontrado após download',
              details: `Template: ${templatePath}`,
            },
            null,
          ];
        }

        // Step 4: enforce file size limit
        const stats = fs.statSync(filePath);
        if (stats.size > maxFileSize) {
          // Clean up the oversized file immediately
          fs.unlinkSync(filePath);
          return [
            {
              code: VIDEO_EXTRACTOR_ERROR_CODES.FILE_TOO_LARGE,
              category: 'MEDIA',
              message: 'Arquivo baixado excede o tamanho máximo permitido',
              details: `Size: ${stats.size} bytes, limit: ${maxFileSize} bytes`,
            },
            null,
          ];
        }

        // Step 5: derive MIME type from the actual extension
        const ext = path.extname(filePath).replace('.', '');
        const mimeType = mimeFromExtension(ext);

        return [
          null,
          {
            filePath,
            mimeType,
            metadata,
          },
        ];
      })
      .catch((err: any): [AppError | null, ExtractedVideo | null] => {
        // Clean up any partial download
        const resolved = resolveDownloadedFile(templatePath);
        if (resolved && fs.existsSync(resolved)) {
          fs.unlinkSync(resolved);
        }

        if (err.killed || err.signal === 'SIGTERM') {
          return [
            {
              code: VIDEO_EXTRACTOR_ERROR_CODES.TIMEOUT,
              category: 'MEDIA',
              message: 'Tempo limite excedido durante o download',
              details: err.message,
            },
            null,
          ];
        }

        return [
          {
            code: VIDEO_EXTRACTOR_ERROR_CODES.DOWNLOAD_FAILED,
            category: 'MEDIA',
            message: 'Erro durante o download do vídeo',
            details: err.stderr?.toString().slice(0, 300) || err.message,
          },
          null,
        ];
      });
  }

  // ---------------------------------------------------------------------------
  // cleanup
  // ---------------------------------------------------------------------------

  /**
   * Safely removes a downloaded temp file.
   * No-ops silently if the file doesn't exist.
   *
   * @param filePath - Absolute path to the file to delete.
   */
  function cleanup(filePath: string): void {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  return [null, { getMetadata, extract, cleanup }];
}