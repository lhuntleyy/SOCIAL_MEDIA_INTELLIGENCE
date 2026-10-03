// Facebook keyword lebih murah (2026-10-03, keputusan pemilik: matikan sumber mahal):
//   `silentflow/facebook-search-scraper` ($0,0023/post) & `scrapeforge/facebook-search-posts` ($0,00259/post) — bentuk output
//   sama (docs/evidence/shapes/shape-silentflow~… & shape-scrapeforge~…), vs scraper_one $0,004/post.
//   - `recent_posts: true` → terurut terbaru → maxItems adaptif berlaku; `start_date`/`end_date` per hari + saring lokal
//   - `timestamp` epoch detik; handle dari `author.url` (fbHandle); total reaksi = likes; `reshare_count` = shares

import { count, toUtcIso } from "@smip/connector-sdk";
import type { CanonicalItem } from "@smip/contracts";
import type { ActorSpec } from "./actor";
import { fbHandle } from "./facebook-scraperone";
import { type NormMeta, noGeo, type Obj, obj, plainQuery, provenance, str, url, ymd } from "./util";

export function normalizeFacebookSearchPosts(r: Obj, meta: NormMeta): CanonicalItem | null {
  const id = str(r.post_id);
  const published = toUtcIso(r.timestamp, "epoch_s");
  const a = obj(r.author);
  const authorId = str(a?.id);
  const handle = fbHandle(url(a?.url), authorId);
  if (!id || !published || !authorId || !handle) return null;
  const text = str(r.message) ?? "";
  const video = url(r.video);
  const image = url(r.image);
  return {
    schema: "canonical-item/v1",
    platform: "facebook",
    platform_post_id: id,
    content_type: "post",
    url: url(r.url),
    text,
    lang_hint: null,
    published_at: published,
    parent: null,
    root_post_id: null,
    author: {
      platform_user_id: authorId,
      handle,
      display_name: str(a?.name),
      followers: null,
      following: null,
      verified: null,
      created_at: null,
      location_raw: null,
      avatar_url: url(a?.profile_picture_url),
    },
    metrics: {
      likes: count(r.reactions_count),
      comments: count(r.comments_count),
      shares: count(r.reshare_count),
      views: count(r.video_view_count),
      quotes: null,
      saves: null,
      captured_at: meta.fetchedAt,
    },
    hashtags: [...text.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1]!),
    mentions: [],
    media: video
      ? [{ type: "video", url: video, thumb: url(r.video_thumbnail) }]
      : image
        ? [{ type: "image", url: image, thumb: null }]
        : [],
    geo: noGeo,
    is_ad: null,
    extra: {},
    provenance: provenance(meta),
  };
}

const OP: NonNullable<ActorSpec["operations"]["search_keyword"]> = {
  queryFeatures: ["term", "phrase"],
  maxQueryLength: 100,
  supportsSince: true,
  supportsUntil: true,
  supportsCursor: false,
  maxPageSize: 500,
  returnsFields: ["metrics.likes", "metrics.comments"],
  asyncExecution: true,
  resultOrder: "desc",
  sinceGranularity: "day",
};
const input = (maxKey: "max_posts" | "max_results") => (req: Parameters<ActorSpec["buildInput"]>[0]) => ({
  query: plainQuery(req).replace(/"/g, ""),
  search_type: "posts",
  recent_posts: true,
  [maxKey]: req.maxItems,
  ...(req.window?.since ? { start_date: ymd(req.window.since) } : {}),
  ...(req.window?.until ? { end_date: ymd(req.window.until) } : {}),
});

export const FACEBOOK_SILENTFLOW: ActorSpec = {
  key: "apify.facebook.silentflow",
  platform: "facebook",
  actorId: "silentflow/facebook-search-scraper",
  version: "0.1.0",
  displayName: "Facebook keyword (terbaru) via Apify (silentflow)",
  docsUrl: "https://apify.com/silentflow/facebook-search-scraper",
  operations: { search_keyword: OP },
  buildInput: input("max_posts"),
  normalize: normalizeFacebookSearchPosts,
};

export const FACEBOOK_SCRAPEFORGE: ActorSpec = {
  key: "apify.facebook.scrapeforge",
  platform: "facebook",
  actorId: "scrapeforge/facebook-search-posts",
  version: "0.1.0",
  displayName: "Facebook keyword (terbaru) via Apify (scrapeforge)",
  docsUrl: "https://apify.com/scrapeforge/facebook-search-posts",
  operations: { search_keyword: OP },
  buildInput: input("max_results"),
  normalize: normalizeFacebookSearchPosts,
};
