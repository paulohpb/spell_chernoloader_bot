/**
 * @module media/providers
 * Provider registry. Providers are tested in order; first match wins.
 * To add a new platform: create a class implementing `MediaProvider`,
 * then append an instance here.
 */

import type { MediaProvider } from '../types';
import { InstagramProvider } from './instagram.provider';
import { TikTokProvider } from './tiktok.provider';
import { TwitterProvider } from './twitter.provider';
import { RedditProvider } from './reddit.provider';
import { YouTubeProvider } from './youtube.provider';

export const providers: readonly MediaProvider[] = [
  new InstagramProvider(),
  new TikTokProvider(),
  new TwitterProvider(),
  new RedditProvider(),
  new YouTubeProvider(),
];