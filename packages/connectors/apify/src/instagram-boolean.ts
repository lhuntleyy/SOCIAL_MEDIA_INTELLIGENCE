// Instagram keyword via Apify `scraping_solutions/instagram-boolean-search-scraper-posts-reels` —
// PROVIDER_MATRIX §2.0 prioritas 1 (TESTED, tanpa login). Bentuk: docs/evidence/shapes/shape-scraping_solutions~….json.
//   - `searchQuery` boolean (AND/OR/NOT, kutip, #tag), maks 32 cabang boolean per query (skema input actor)
//   - hasil TIDAK terurut waktu → `oldestPostDate`/`newestPostDate` (tanggal) + saring lokal
//   - biaya: event per halaman search + per hasil (COST_MODEL §3) → batasi lewat connectors.config.maxTotalChargeUsd
import type { CanonicalItem } from "@smip/contracts";
import { ConnectorError, count, toUtcIso } from "@smip/connector-sdk";
import type { ActorSpec } from "./actor";
import { arr, type NormMeta, type Obj, provenance, str, url, ymd } from "./util";

/** Batas actor: 32 cabang boolean — compiler hanya memakai OR, jadi cabang = jumlah operand OR. */
export const IG_MAX_BRANCHES = 32;

export function normalizeInstagramBoolean(r: Obj, meta: NormMeta): CanonicalItem | null {
  const code = str(r.shortCode);
  const published = toUtcIso(r.publishedAt);
  const handle = str(r.username);
  const authorId = str(r.userId) ?? handle; // userId kadang kosong; username unik di IG
  if (!code || !published || !handle || !authorId) return null;
  const media = url(r.mediaUrl);
  const isVideo = /reel|video|clip/i.test(String(r.contentType ?? ""));
  const lat = typeof r.latitude === "number" ? r.latitude : null;
  const lng = typeof r.longitude === "number" ? r.longitude : null;
  return {
    schema: "canonical-item/v1",
    platform: "instagram",
    platform_post_id: code, // shortcode = ID publik post (URL /p/<shortcode>)
    content_type: "post",
    url: url(r.url) ?? `https://www.instagram.com/p/${code}/`,
    text: str(r.caption) ?? "",
    lang_hint: null,
    published_at: published,
    parent: null,
    root_post_id: null,
    author: {
      platform_user_id: authorId,
      handle,
      display_name: str(r.fullName),
      followers: null, // tidak ada di output actor
      following: null,
      verified: typeof r.verified === "boolean" ? r.verified : null,
      created_at: null,
      location_raw: null,
      avatar_url: null,
    },
    metrics: {
      likes: count(r.likeCount),
      comments: count(r.commentCount),
      shares: count(r.shareCount),
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
    media: media ? [{ type: isVideo ? "video" : "image", url: media, thumb: url(r.thumbnailUrl) }] : [],
    geo: {
      lat: lat !== null && lat >= -90 && lat <= 90 ? lat : null,
      lng: lng !== null && lng >= -180 && lng <= 180 ? lng : null,
      place_name: str(r.locationName),
    },
    is_ad: null,
    extra: {},
    provenance: provenance(meta),
  };
}

export const INSTAGRAM_BOOLEAN: ActorSpec = {
  key: "apify.instagram.boolean",
  platform: "instagram",
  actorId: "scraping_solutions/instagram-boolean-search-scraper-posts-reels",
  version: "0.1.0",
  displayName: "Instagram keyword via Apify (scraping_solutions boolean search)",
  docsUrl: "https://apify.com/scraping_solutions/instagram-boolean-search-scraper-posts-reels",
  operations: {
    search_keyword: {
      queryFeatures: ["term", "phrase", "or"],
      maxQueryLength: 300,
      supportsSince: true,
      supportsUntil: true,
      supportsCursor: false,
      maxPageSize: 1000,
      returnsFields: ["metrics.likes", "metrics.comments"],
      asyncExecution: true,
      resultOrder: null, // tidak terurut waktu (uji kontrak 2026-09-28)
    },
  },
  buildInput(req) {
    const q = req.query?.native ?? "";
    const branches = q.split(/\s+OR\s+/).length;
    if (branches > IG_MAX_BRANCHES) {
      throw new ConnectorError("INVALID_QUERY", `query ${branches} cabang > batas actor ${IG_MAX_BRANCHES}`, { scope: "request" });
    }
    return {
      searchQuery: q,
      resultsLimit: req.maxItems,
      contentType: "posts_and_reels",
      hashtagFeedType: "recent",
      searchCoverage: "efficient",
      ...(req.window?.since ? { oldestPostDate: ymd(req.window.since) } : {}),
      ...(req.window?.until ? { newestPostDate: ymd(req.window.until) } : {}),
    };
  },
  normalize: normalizeInstagramBoolean,
};
