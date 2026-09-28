// TikTok via Apify `apidojo/tiktok-scraper` — PROVIDER_MATRIX §2.0 prioritas 1 (TESTED).
// Bentuk: docs/evidence/shapes/shape-apidojo~tiktok-scraper.json. Filter waktu actor hanya `dateRange` kasar
// (YESTERDAY … ALL_TIME) → pilih rentang terkecil yang mencakup window, lalu saring lokal (published_at ≥ since).
import type { CanonicalItem } from "@smip/contracts";
import { count, toUtcIso } from "@smip/connector-sdk";
import type { ActorSpec } from "./actor";
import { arr, type NormMeta, type Obj, noGeo, obj, plainQuery, provenance, str, url, windowAgeDays } from "./util";

export function tiktokDateRange(ageDays: number | null): string {
  if (ageDays === null) return "DEFAULT";
  if (ageDays <= 1) return "YESTERDAY";
  if (ageDays <= 7) return "THIS_WEEK";
  if (ageDays <= 30) return "THIS_MONTH";
  if (ageDays <= 90) return "LAST_THREE_MONTHS";
  if (ageDays <= 180) return "LAST_SIX_MONTHS";
  return "ALL_TIME";
}

export function normalizeTiktok(r: Obj, meta: NormMeta): CanonicalItem | null {
  const id = str(r.id);
  const published = toUtcIso(r.uploadedAt, "epoch_s") ?? toUtcIso(r.uploadedAtFormatted);
  const ch = obj(r.channel);
  const authorId = str(ch?.id);
  const handle = str(ch?.username);
  if (!id || !published || !authorId || !handle) return null;
  const v = obj(r.video);
  const vurl = url(v?.url);
  return {
    schema: "canonical-item/v1",
    platform: "tiktok",
    platform_post_id: id,
    content_type: "post",
    url: url(r.postPage) ?? `https://www.tiktok.com/@${handle}/video/${id}`,
    text: str(r.title) ?? "",
    lang_hint: null, // output tidak memuat bahasa teks (subtitle ≠ bahasa caption) — jangan menebak
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
    geo: noGeo,
    is_ad: null,
    extra: {},
    provenance: provenance(meta),
  };
}

export const TIKTOK_APIDOJO: ActorSpec = {
  key: "apify.tiktok.apidojo",
  platform: "tiktok",
  actorId: "apidojo/tiktok-scraper",
  version: "0.1.0",
  displayName: "TikTok via Apify (apidojo/tiktok-scraper)",
  docsUrl: "https://apify.com/apidojo/tiktok-scraper",
  operations: {
    search_keyword: {
      // kata kunci biasa (tanpa operator boolean terdokumentasi) → 1 leaf per sub-query; presisi = matcher lokal
      queryFeatures: ["term", "phrase"],
      maxQueryLength: 100,
      supportsSince: true,
      supportsUntil: true,
      supportsCursor: false,
      maxPageSize: 1000,
      returnsFields: ["metrics.likes", "metrics.views", "author.followers"],
      asyncExecution: true,
      resultOrder: "desc",
    },
  },
  buildInput(req) {
    return {
      keywords: [plainQuery(req).replace(/"/g, "")],
      maxItems: req.maxItems,
      sortType: "DATE_POSTED",
      dateRange: tiktokDateRange(windowAgeDays(req.window)),
    };
  },
  normalize: normalizeTiktok,
};
