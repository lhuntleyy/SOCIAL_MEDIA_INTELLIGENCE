// YouTube via Apify `streamers/youtube-scraper` — PROVIDER_MATRIX §2.0 prioritas 2 (TESTED; official Data API = prioritas 1).
// Bentuk: docs/evidence/shapes/shape-streamers~youtube-scraper.json. `date` ISO Z. Teks = judul + deskripsi.
// Inkremental: `oldestPostDate` TIDAK dihormati untuk mode search (verify live 2026-09-29: video Mei–Sep tetap
// kembali) → pakai filter bawaan YouTube `dateFilter` (hour/today/week/month/year) + saring lokal.
import type { CanonicalItem } from "@smip/contracts";
import { count, toUtcIso } from "@smip/connector-sdk";
import type { ActorSpec } from "./actor";
import { arr, type NormMeta, type Obj, noGeo, plainQuery, provenance, str, url, windowAgeDays } from "./util";

/** Filter unggah YouTube terkecil yang pasti mencakup window. */
export function youtubeDateFilter(ageDays: number | null): string | undefined {
  if (ageDays === null) return undefined;
  if (ageDays <= 1 / 24) return "hour";
  if (ageDays <= 1) return "today";
  if (ageDays <= 7) return "week";
  if (ageDays <= 31) return "month";
  if (ageDays <= 365) return "year";
  return undefined;
}

export function normalizeYoutubeStreamers(r: Obj, meta: NormMeta): CanonicalItem | null {
  const id = str(r.id);
  const published = toUtcIso(r.date);
  const channelId = str(r.channelId);
  const handle = str(r.channelUsername)?.replace(/^@/, "") ?? channelId;
  if (!id || !published || !channelId || !handle) return null;
  const title = str(r.title) ?? "";
  const desc = str(r.text) ?? "";
  const thumb = url(r.thumbnailUrl);
  return {
    schema: "canonical-item/v1",
    platform: "youtube",
    platform_post_id: id,
    content_type: "post",
    url: url(r.url) ?? `https://www.youtube.com/watch?v=${id}`,
    text: desc ? `${title}\n\n${desc}` : title,
    lang_hint: null,
    published_at: published,
    parent: null,
    root_post_id: null,
    author: {
      platform_user_id: channelId,
      handle,
      display_name: str(r.channelName),
      followers: count(r.numberOfSubscribers),
      following: null,
      verified: null,
      created_at: null,
      location_raw: null,
      avatar_url: null,
    },
    metrics: {
      likes: count(r.likes),
      comments: count(r.commentsCount),
      shares: null,
      views: count(r.viewCount),
      quotes: null,
      saves: null,
      captured_at: meta.fetchedAt,
    },
    hashtags: arr(r.hashtags)
      .map(str)
      .filter((x): x is string => !!x)
      .map((h) => h.replace(/^#/, "")),
    mentions: [],
    media: thumb ? [{ type: "video", url: url(r.url) ?? `https://www.youtube.com/watch?v=${id}`, thumb }] : [],
    geo: noGeo,
    is_ad: null,
    extra: {},
    provenance: provenance(meta),
  };
}

export const YOUTUBE_STREAMERS: ActorSpec = {
  key: "apify.youtube.streamers",
  platform: "youtube",
  actorId: "streamers/youtube-scraper",
  version: "0.1.0",
  displayName: "YouTube via Apify (streamers/youtube-scraper)",
  docsUrl: "https://apify.com/streamers/youtube-scraper",
  operations: {
    search_keyword: {
      // bar pencarian YouTube: kata & "frasa" & OR (tanpa jaminan) → aman: term/phrase, 1 leaf per sub-query
      queryFeatures: ["term", "phrase"],
      maxQueryLength: 100,
      supportsSince: true,
      supportsUntil: false,
      supportsCursor: false,
      maxPageSize: 1000,
      returnsFields: ["metrics.views", "author.followers"],
      asyncExecution: true,
      resultOrder: "desc",
    },
  },
  buildInput(req) {
    return {
      searchQueries: [plainQuery(req)],
      maxResults: req.maxItems,
      maxResultsShorts: 0,
      maxResultStreams: 0,
      sortingOrder: "date",
      ...(youtubeDateFilter(windowAgeDays(req.window)) ? { dateFilter: youtubeDateFilter(windowAgeDays(req.window)) } : {}),
    };
  },
  normalize: normalizeYoutubeStreamers,
};
