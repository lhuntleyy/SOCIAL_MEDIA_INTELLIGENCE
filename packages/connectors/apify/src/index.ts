// Connector berbasis actor Apify (satu paket: aturan dependensi melarang connector saling mengimpor).
import { ApifyActorConnector } from "./actor";
import { FACEBOOK_SCRAPERONE } from "./facebook-scraperone";
import { INSTAGRAM_BOOLEAN } from "./instagram-boolean";
import { THREADS_SCRAPERSDELIGHT } from "./threads-scrapersdelight";
import { TIKTOK_APIDOJO } from "./tiktok-apidojo";
import { X_APIDOJO } from "./x-apidojo";
import { X_XQUIK } from "./x-xquik";
import { YOUTUBE_STREAMERS } from "./youtube-streamers";

export * from "./actor";
export * from "./client";
export * from "./facebook-scraperone";
export * from "./instagram-boolean";
export * from "./threads-scrapersdelight";
export * from "./tiktok-apidojo";
export * from "./util";
export * from "./x-apidojo";
export * from "./x-xquik";
export * from "./youtube-streamers";

export const APIFY_SPECS = [
  X_XQUIK,
  X_APIDOJO,
  INSTAGRAM_BOOLEAN,
  FACEBOOK_SCRAPERONE,
  TIKTOK_APIDOJO,
  YOUTUBE_STREAMERS,
  THREADS_SCRAPERSDELIGHT,
];

/** Semua connector Apify yang siap dipakai worker-fetch-bun. */
export function apifyConnectors(): ApifyActorConnector[] {
  return APIFY_SPECS.map((s) => new ApifyActorConnector(s));
}
