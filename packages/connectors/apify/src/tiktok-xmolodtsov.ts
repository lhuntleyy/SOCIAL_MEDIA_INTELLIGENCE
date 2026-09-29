// TikTok via Apify `xmolodtsov/tiktok-search-scraper` — TikTok #2 (murah $0,30/1K, cadangan).
// Bentuk: docs/evidence/shapes/shape-xmolodtsov~tiktok-search-scraper.json. TANPA filter tanggal (sort diterapkan
// setelah fetch menurut skema input) → saring lokal saja; kurang efisien untuk inkremental → prioritas rendah.

import { count, toUtcIso } from "@smip/connector-sdk";
import type { CanonicalItem } from "@smip/contracts";
import type { ActorSpec } from "./actor";
import { arr, type NormMeta, type Obj, obj, plainQuery, provenance, str, url } from "./util";

export function normalizeXmolodtsovTiktok(r: Obj, meta: NormMeta): CanonicalItem | null {
  const id = str(r.id);
  const published = toUtcIso(r.uploadedAt, "epoch_s") ?? toUtcIso(r.uploadedAtFormatted);
  const ch = obj(r.channel);
  const authorId = str(ch?.id);
  const handle = str(ch?.username);
  if (!id || !published || !authorId || !handle) return null;
  const v = obj(r.video);
  const vurl = url(v?.url);
  const poi = obj(r.poi);
  return {
    schema: "canonical-item/v1",
    platform: "tiktok",
    platform_post_id: id,
    content_type: "post",
    url: url(r.postPage) ?? `https://www.tiktok.com/@${handle}/video/${id}`,
    text: str(r.title) ?? "",
    lang_hint: null,
    published_at: published,
    parent: null,
    root_post_id: null,
    author: {
      platform_user_id: authorId,
      handle,
      display_name: str(ch?.name),
      followers: count(ch?.followers),
      following: count(ch?.following),
      verified: typeof ch?.verified === "boolean" ? ch.verified : null,
      created_at: null,
      location_raw: null,
      avatar_url: url(ch?.avatar),
    },
    metrics: {
      likes: count(r.likes),
      comments: count(r.comments),
      shares: count(r.shares),
      views: count(r.views),
      quotes: null,
      saves: count(r.bookmarks),
      captured_at: meta.fetchedAt,
    },
    hashtags: arr(r.hashtags)
      .map(str)
      .filter((x): x is string => !!x),
    mentions: [],
    media: vurl ? [{ type: "video", url: vurl, thumb: url(v?.cover) ?? url(v?.thumbnail) }] : [],
    geo: { lat: null, lng: null, place_name: str(poi?.poiName) },
    is_ad: null,
    extra: {},
    provenance: provenance(meta),
  };
}

export const TIKTOK_XMOLODTSOV: ActorSpec = {
  key: "apify.tiktok.xmolodtsov",
  platform: "tiktok",
  actorId: "xmolodtsov/tiktok-search-scraper",
  version: "0.1.0",
  displayName: "TikTok via Apify (xmolodtsov/tiktok-search-scraper)",
  docsUrl: "https://apify.com/xmolodtsov/tiktok-search-scraper",
  operations: {
    search_keyword: {
      queryFeatures: ["term", "phrase"],
      maxQueryLength: 100,
      supportsSince: true, // lewat saring lokal
      supportsUntil: true,
      supportsCursor: false,
      maxPageSize: 1000,
      returnsFields: ["metrics.likes", "metrics.views", "author.followers"],
      asyncExecution: true,
      resultOrder: null,
    },
  },
  buildInput(req) {
    return { keywords: [plainQuery(req).replace(/"/g, "")], maxItems: req.maxItems, sortType: "DATE_POSTED" };
  },
  normalize: normalizeXmolodtsovTiktok,
};
