/**
 * =============================================================================
 * Bot Handlers - Public API
 * =============================================================================
 */

export { createMediaHandler, MEDIA_ERROR_CODES } from './media';
export type { MediaHandler, MediaHandlerConfig } from './media';

export { createDebugHandler } from './debug';
export type { DebugHandler, DebugHandlerConfig } from './debug';

export { createDuylhouHandler } from './duylhou';
export type { DuylhouHandler, DuylhouHandlerConfig } from './duylhou';

export { createSummaryHandler } from './summary';
export type { SummaryHandler, SummaryHandlerConfig } from './summary';

export { createNewsHandler } from './news';
export type { NewsHandler, NewsHandlerConfig } from './news';

export { createVideoSumHandler } from './videosum';
export type { VideoSumHandler, VideoSumHandlerConfig } from './videosum';

export { createTraduzirHandler } from './traduzir';
export type { TraduzirHandler, TraduzirHandlerConfig } from './traduzir';

// Re-export services for use in other commands
export { createScraperService, SCRAPER_ERROR_CODES } from '../../assistant/services/scraper.service';
export type {
  ScraperService,
  ScraperServiceConfig,
  ScrapedContent,
} from '../../assistant/services/scraper.service';

export { createVideoExtractorService, VIDEO_EXTRACTOR_ERROR_CODES } from '../../assistant/services/video-extractor.service';
export type {
  VideoExtractorService,
  VideoExtractorServiceConfig,
  ExtractedVideo,
  VideoMetadata,
} from '../../assistant/services/video-extractor.service';