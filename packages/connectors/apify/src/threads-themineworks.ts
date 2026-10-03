// Threads via Apify `themineworks/threads-search-scraper` — dipilih 2026-10-03 untuk memangkas biaya Threads.
// Bentuk: docs/evidence/shapes/shape-themineworks~threads-search-scraper.json (probe: 10 post / $0,005).
//   - `searchQuery` teks biasa (1 query per run), `resultType: recent` → **terurut terbaru** (resultOrder desc)
//     → maxItems adaptif di dispatch berlaku: poll rapat hanya meminta ± post baru, bukan 24 jam penuh (COST_MODEL §12).
//     Actor lama (scrapersdelight) hanya filter per hari & tak terurut → tiap poll menagih ulang post 24 jam.
//   - tanpa filter tanggal → saring lokal (≤ LOOKBACK_DAYS); tanpa user id → username = id penulis (unik di Threads)
//   - baris ringkasan actor (`_type`, `delivered`, `message`) bukan post → dibuang normalizer
//   - harga (DOCS Apify, 2026-10-03): $0,001/post (FREE) → $0,0006 (GOLD); run kosong/terblokir tidak ditagih

import { count, toUtcIso } from "@smip/connector-sdk";
import type { CanonicalItem } from "@smip/contracts";
import type { ActorSpec } from "./actor";
import { arr, type NormMeta, noGeo, type Obj, plainQuery, provenance, str, url } from "./util";

export function normalizeThreadsMineworks(r: Obj, meta: NormMeta): CanonicalItem | null {
  if (r._type !== undefined && r.post_id === undefined) return null; // ringkasan run
  const id = str(r.post_id);
  const published = toUtcIso(r.posted_at);
  const handle = str(r.username);
  if (!id || !published || !handle) return null;
  const media = arr(r.media_urls)
    .map(url)
    .filter((x): x is string => !!x);
  const isVideo = /video/i.test(String(r.media_type ?? ""));
  return {
    schema: "canonical-item/v1",
    platform: "threads",
    platform_post_id: id,
    content_type: r.is_repost === true ? "repost" : r.is_reply === true ? "reply" : "post",
    url: url(r.url) ?? (str(r.code) ? `https://www.threads.com/@${handle}/post/${str(r.code)}` : null),
    text: str(r.text) ?? "",
    lang_hint: null,
    published_at: published,
    parent: null,
    root_post_id: null,
    author: {
      platform_user_id: handle,
      handle,
      display_name: str(r.user_full_name),
      followers: null,
      following: null,
      verified: typeof r.user_verified === "boolean" ? r.user_verified : null,
      created_at: null,
      location_raw: null,
      avatar_url: url(r.user_pic_url),
    },
    metrics: {
      likes: count(r.like_count),
      comments: count(r.reply_count),
      shares: count(r.repost_count),
      views: null,
      quotes: count(r.quote_count),
      saves: null,
      captured_at: meta.fetchedAt,
    },
    hashtags: arr(r.hashtags)
      .map(str)
      .filter((x): x is string => !!x)
      .map((h) => h.replace(/^#/, "")),
    mentions: arr(r.mentions)
      .map(str)
      .filter((x): x is string => !!x)
      .map((h) => h.replace(/^@/, "")),
    media: media.map((u) => ({ type: isVideo ? ("video" as const) : ("image" as const), url: u, thumb: null })),
    geo: noGeo,
    is_ad: null,
    extra: {},
    provenance: provenance(meta),
  };
}

export const THREADS_MINEWORKS: ActorSpec = {
  key: "apify.threads.themineworks",
  platform: "threads",
  actorId: "themineworks/threads-search-scraper",
  version: "0.1.0",
  displayName: "Threads keyword (terbaru) via Apify (themineworks)",
  docsUrl: "https://apify.com/themineworks/threads-search-scraper",
  operations: {
    search_keyword: {
      queryFeatures: ["term", "phrase"],
      maxQueryLength: 100,
      supportsSince: false,
      supportsUntil: false,
      supportsCursor: false,
      maxPageSize: 500,
      returnsFields: ["metrics.likes", "metrics.comments"],
      asyncExecution: true,
      resultOrder: "desc",
      sinceGranularity: "day", // tanpa filter waktu → setara "per hari": maxItems adaptif memotong tagihan ulang
    },
  },
  buildInput(req) {
    return { searchQuery: plainQuery(req).replace(/"/g, ""), resultType: "recent", maxPosts: req.maxItems };
  },
  normalize: normalizeThreadsMineworks,
};
