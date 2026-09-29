// X via Apify `scraper_one/x-posts-search` — cadangan X #3. Bentuk: docs/evidence/shapes/shape-scraper_one~x-posts-search.json.
// Input: `query`, `searchType: latest`, `timeWindowHours` (hanya berlaku utk latest), `resultsCount` (plan FREE: maks 100/query).

import { count, toUtcIso } from "@smip/connector-sdk";
import type { CanonicalItem } from "@smip/contracts";
import type { ActorSpec } from "./actor";
import { arr, type NormMeta, noGeo, type Obj, obj, plainQuery, provenance, str, url, windowAgeDays } from "./util";

export const SCRAPERONE_X_MAX = 100; // catatan skema input: plan FREE maks 100 post per query
const MEDIA: Record<string, "image" | "video" | "gif"> = { photo: "image", video: "video", animated_gif: "gif" };

export function normalizeScraperOneX(r: Obj, meta: NormMeta): CanonicalItem | null {
  const id = str(r.postId);
  const published = toUtcIso(r.timestamp, "epoch_ms");
  const a = obj(r.author);
  const authorId = str(a?.userId);
  const handle = str(a?.screenName);
  if (!id || !published || !authorId || !handle) return null;
  const conv = str(r.conversationId);
  return {
    schema: "canonical-item/v1",
    platform: "x",
    platform_post_id: id,
    content_type: "post", // output tanpa penanda reply/quote/repost → jangan menebak
    url: url(r.postUrl) ?? `https://x.com/${handle}/status/${id}`,
    text: str(r.postText) ?? "",
    lang_hint: null,
    published_at: published,
    parent: null,
    root_post_id: conv && conv !== id ? conv : null,
    author: {
      platform_user_id: authorId,
      handle,
      display_name: str(a?.name),
      followers: null,
      following: null,
      verified: null,
      created_at: null,
      location_raw: null,
      avatar_url: url(a?.profileImageUrl),
    },
    metrics: {
      likes: count(r.favouriteCount),
      comments: count(r.replyCount),
      shares: count(r.repostCount),
      views: null,
      quotes: count(r.quoteCount),
      saves: null,
      captured_at: meta.fetchedAt,
    },
    hashtags: [...(str(r.postText) ?? "").matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1]!),
    mentions: [],
    media: arr(r.media).flatMap((m) => {
      const o = obj(m);
      const t = MEDIA[String(o?.type)];
      const u = url(o?.mediaUrlHttps);
      return t && u ? [{ type: t, url: u, thumb: null }] : [];
    }),
    geo: noGeo,
    is_ad: null,
    extra: {},
    provenance: provenance(meta),
  };
}

export const X_SCRAPERONE: ActorSpec = {
  key: "apify.x.scraperone",
  platform: "x",
  actorId: "scraper_one/x-posts-search",
  version: "0.1.0",
  displayName: "X via Apify (scraper_one/x-posts-search)",
  docsUrl: "https://apify.com/scraper_one/x-posts-search",
  operations: {
    search_keyword: {
      queryFeatures: ["term", "phrase"],
      maxQueryLength: 200,
      supportsSince: true,
      supportsUntil: true,
      supportsCursor: false,
      maxPageSize: SCRAPERONE_X_MAX,
      returnsFields: ["metrics.likes", "metrics.comments"],
      asyncExecution: true,
      resultOrder: "desc",
    },
  },
  buildInput(req) {
    const age = windowAgeDays(req.window);
    return {
      query: plainQuery(req),
      resultsCount: Math.min(SCRAPERONE_X_MAX, req.maxItems),
      searchType: "latest",
      ...(age !== null ? { timeWindowHours: Math.max(1, Math.ceil(age * 24)) } : {}),
    };
  },
  normalize: normalizeScraperOneX,
};
