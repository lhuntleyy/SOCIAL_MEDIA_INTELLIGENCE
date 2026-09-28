// Connector berbasis actor Apify (satu paket: aturan dependensi melarang connector saling mengimpor).
// Actor penerbit `apidojo` TIDAK dipakai (keputusan pemilik 2026-09-29: batas run bulanan plan FREE).
import { ApifyActorConnector } from "./actor";
import { FACEBOOK_SCRAPERONE } from "./facebook-scraperone";
import { INSTAGRAM_BOOLEAN } from "./instagram-boolean";
import { THREADS_SCRAPERSDELIGHT } from "./threads-scrapersdelight";
import { TIKTOK_CLOCKWORKS } from "./tiktok-clockworks";
import { TIKTOK_XMOLODTSOV } from "./tiktok-xmolodtsov";
import { X_KAITO } from "./x-kaito";
import { X_SCRAPERONE } from "./x-scraperone";
import { X_XQUIK } from "./x-xquik";
import { YOUTUBE_STREAMERS } from "./youtube-streamers";

export * from "./actor";
export * from "./client";
export * from "./facebook-scraperone";
export * from "./instagram-boolean";
export * from "./threads-scrapersdelight";
export * from "./tiktok-clockworks";
export * from "./tiktok-xmolodtsov";
export * from "./util";
export * from "./x-kaito";
export * from "./x-scraperone";
export * from "./x-xquik";
export * from "./youtube-streamers";

export const APIFY_SPECS = [
  X_XQUIK,
  X_KAITO,
  X_SCRAPERONE,
  INSTAGRAM_BOOLEAN,
  FACEBOOK_SCRAPERONE,
  TIKTOK_CLOCKWORKS,
  TIKTOK_XMOLODTSOV,
  YOUTUBE_STREAMERS,
  THREADS_SCRAPERSDELIGHT,
];

/** Semua connector Apify yang siap dipakai worker-fetch-bun. */
export function apifyConnectors(): ApifyActorConnector[] {
  return APIFY_SPECS.map((s) => new ApifyActorConnector(s));
}
