// Threads via Apify `scrapersdelight/threads-keyword-search-scraper` — PROVIDER_MATRIX §2.0 prioritas 2
// (tanpa start fee → cocok polling rapat). Bentuk: docs/evidence/shapes/shape-scrapersdelight~….json (probe 2026-09-29).
//   - `keywords` teks biasa; tanpa cursor (SERP logged-out); `postedWithinDays` (hari) + saring lokal
//   - hasil campuran baru & lama (dokumen actor) → resultOrder null
//   - `isPaidPartnership` = sinyal iklan (FR-I07); `countsHidden` → metrik tidak diketahui (null, bukan 0)
import type { CanonicalItem } from "@smip/contracts";
import { count, toUtcIso } from "@smip/connector-sdk";
import type { ActorSpec } from "./actor";
import { arr, type NormMeta, type Obj, noGeo, plainQuery, provenance, str, url, windowAgeDays } from "./util";

export function normalizeThreads(r: Obj, meta: NormMeta): CanonicalItem | null {
  const id = str(r.postId);
  const published = toUtcIso(r.postedAt);
  const authorId = str(r.authorId);
  const handle = str(r.authorUsername);
  if (!id || !published || !authorId || !handle) return null;
  const hidden = r.countsHidden === true;
  const m = (v: unknown) => (hidden ? null : count(v));
  const img = url(r.imageUrl);
  const vid = url(r.videoUrl);
  return {
    schema: "canonical-item/v1",
    platform: "threads",
    platform_post_id: id,
    content_type: r.isReply === true ? "reply" : "post",
    url: url(r.postUrl),
    text: str(r.text) ?? "",
    lang_hint: str(r.language),
    published_at: published,
    parent: null, // output hanya memberi username yang dibalas, bukan ID post → tidak menebak
    root_post_id: null,
    author: {
      platform_user_id: authorId,
      handle,
      display_name: str(r.authorFullName),
      followers: null,
      following: null,
      verified: typeof r.authorIsVerified === "boolean" ? r.authorIsVerified : null,
      created_at: null,
      location_raw: null,
      avatar_url: url(r.authorProfilePicUrl),
    },
    metrics: {
      likes: m(r.likeCount),
      comments: m(r.replyCount),
      shares: m(r.repostCount),
      views: null,
      quotes: m(r.quoteCount),
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
    media: [...(vid ? [{ type: "video" as const, url: vid, thumb: img }] : img ? [{ type: "image" as const, url: img, thumb: null }] : [])],
    geo: noGeo,
    is_ad: typeof r.isPaidPartnership === "boolean" ? r.isPaidPartnership : null,
    extra: {},
    provenance: provenance(meta),
  };
}

export const THREADS_SCRAPERSDELIGHT: ActorSpec = {
  key: "apify.threads.scrapersdelight",
  platform: "threads",
  actorId: "scrapersdelight/threads-keyword-search-scraper",
  version: "0.1.0",
  displayName: "Threads keyword via Apify (scrapersdelight)",
  docsUrl: "https://apify.com/scrapersdelight/threads-keyword-search-scraper",
  operations: {
    search_keyword: {
      queryFeatures: ["term", "phrase"],
      maxQueryLength: 100,
      supportsSince: true,
      supportsUntil: true,
      supportsCursor: false,
      maxPageSize: 100,
      returnsFields: ["metrics.likes", "metrics.comments"],
      asyncExecution: true,
      resultOrder: null,
    },
  },
  buildInput(req) {
    const age = windowAgeDays(req.window);
    return {
      keywords: [plainQuery(req).replace(/"/g, "")],
      searchType: "top",
      maxItems: req.maxItems,
      maxPostsPerKeyword: req.maxItems,
      passesPerSurface: 1,
      ...(age !== null ? { postedWithinDays: Math.max(1, Math.ceil(age)) } : {}),
    };
  },
  normalize: normalizeThreads,
};
