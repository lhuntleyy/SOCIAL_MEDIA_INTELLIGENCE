// Facebook keyword via Apify `scraper_one/facebook-posts-search` — PROVIDER_MATRIX §2.0 prioritas 1 (TESTED).
// Bentuk: docs/evidence/shapes/shape-scraper_one~facebook-posts-search.json. `query` teks biasa, `searchType: latest`,
// `startDate`/`endDate` (YYYY-MM-DD) + saring lokal. `timestamp` epoch ms. Output tanpa handle → dari profileUrl.

import { count, toUtcIso } from "@smip/connector-sdk";
import type { CanonicalItem } from "@smip/contracts";
import type { ActorSpec } from "./actor";
import { arr, type NormMeta, noGeo, type Obj, obj, plainQuery, provenance, str, url, ymd } from "./util";

/** Handle FB dari URL profil: /<username> atau profile.php?id=<id> → id. Bukan tebakan: identitas dari URL resmi. */
export function fbHandle(profileUrl: string | null, id: string | null): string | null {
  if (profileUrl) {
    try {
      const u = new URL(profileUrl);
      const q = u.searchParams.get("id");
      if (u.pathname.startsWith("/profile.php") && q) return q;
      const seg = u.pathname.split("/").filter(Boolean)[0];
      if (seg && !["people", "pages", "groups"].includes(seg)) return seg;
    } catch {}
  }
  return id;
}

const MEDIA: Record<string, "image" | "video"> = { photo: "image", image: "image", video: "video" };

export function normalizeFacebookScraperOne(r: Obj, meta: NormMeta): CanonicalItem | null {
  const id = str(r.postId);
  const published = toUtcIso(r.timestamp, "epoch_ms");
  const a = obj(r.author);
  const authorId = str(a?.id);
  const handle = fbHandle(url(a?.profileUrl), authorId);
  if (!id || !published || !authorId || !handle) return null;
  return {
    schema: "canonical-item/v1",
    platform: "facebook",
    platform_post_id: id,
    content_type: "post",
    url: url(r.url),
    text: str(r.postText) ?? "",
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
      avatar_url: url(a?.profilePicture),
    },
    metrics: {
      likes: count(r.reactionsCount), // total reaksi (like+love+…) = padanan "likes" lintas platform
      comments: count(r.commentsCount),
      shares: count(r.sharesCount),
      views: null,
      quotes: null,
      saves: null,
      captured_at: meta.fetchedAt,
    },
    hashtags: [...(str(r.postText) ?? "").matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1]!),
    mentions: [],
    media: arr(r.attachments).flatMap((m) => {
      const o = obj(m);
      const t = MEDIA[String(o?.type).toLowerCase()];
      const u = url(o?.url);
      return t && u ? [{ type: t, url: u, thumb: null }] : [];
    }),
    geo: noGeo,
    is_ad: null,
    extra: {},
    provenance: provenance(meta),
  };
}

export const FACEBOOK_SCRAPERONE: ActorSpec = {
  key: "apify.facebook.scraperone",
  platform: "facebook",
  actorId: "scraper_one/facebook-posts-search",
  version: "0.1.0",
  displayName: "Facebook keyword via Apify (scraper_one/facebook-posts-search)",
  docsUrl: "https://apify.com/scraper_one/facebook-posts-search",
  operations: {
    search_keyword: {
      queryFeatures: ["term", "phrase"],
      maxQueryLength: 100,
      supportsSince: true,
      supportsUntil: true,
      supportsCursor: false,
      maxPageSize: 1000,
      returnsFields: ["metrics.likes", "metrics.comments"],
      asyncExecution: true,
      resultOrder: "desc",
    },
  },
  buildInput(req) {
    return {
      query: plainQuery(req).replace(/"/g, ""),
      resultsCount: req.maxItems,
      searchType: "latest",
      ...(req.window?.since ? { startDate: ymd(req.window.since) } : {}),
      ...(req.window?.until ? { endDate: ymd(req.window.until) } : {}),
    };
  },
  normalize: normalizeFacebookScraperOne,
};
