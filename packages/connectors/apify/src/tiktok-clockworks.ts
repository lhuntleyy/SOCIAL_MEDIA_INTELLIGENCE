// TikTok via Apify `clockworks/free-tiktok-scraper` — TikTok #1 (menggantikan apidojo, ditolak pemilik 2026-09-29).
// Bentuk: docs/evidence/shapes/shape-clockworks~free-tiktok-scraper.json. Search video: `searchSection: "/video"`,
// `videoSearchSorting: LATEST`, `videoSearchDateFilter` (PAST_24_HOURS … ALL_TIME) + saring lokal. Filter berbayar kecil
// per run (event `filter-applied`) — dikendalikan maxTotalChargeUsd. Sinyal iklan: `isAd`/`isSponsored`; bahasa: `textLanguage`.
import type { CanonicalItem } from "@smip/contracts";
import { count, toUtcIso } from "@smip/connector-sdk";
import type { ActorSpec } from "./actor";
import { arr, type NormMeta, type Obj, noGeo, obj, plainQuery, provenance, str, url, windowAgeDays } from "./util";

export function clockworksDateFilter(ageDays: number | null): string {
  if (ageDays === null) return "ALL_TIME";
  if (ageDays <= 1) return "PAST_24_HOURS";
  if (ageDays <= 7) return "PAST_WEEK";
  if (ageDays <= 30) return "PAST_MONTH";
  if (ageDays <= 90) return "LAST_3_MONTHS";
  if (ageDays <= 180) return "LAST_6_MONTHS";
  return "ALL_TIME";
}

export function normalizeClockworksTiktok(r: Obj, meta: NormMeta): CanonicalItem | null {
  const id = str(r.id);
  const published = toUtcIso(r.createTimeISO) ?? toUtcIso(r.createTime, "epoch_s");
  const a = obj(r.authorMeta);
  const authorId = str(a?.id);
  const handle = str(a?.name);
  if (!id || !published || !authorId || !handle) return null;
  const page = url(r.webVideoUrl) ?? `https://www.tiktok.com/@${handle}/video/${id}`;
  const vm = obj(r.videoMeta);
  const ad = typeof r.isAd === "boolean" || typeof r.isSponsored === "boolean" ? r.isAd === true || r.isSponsored === true : null;
  return {
    schema: "canonical-item/v1",
    platform: "tiktok",
    platform_post_id: id,
    content_type: "post",
    url: page,
    text: str(r.text) ?? "",
    lang_hint: str(r.textLanguage),
    published_at: published,
    parent: null,
    root_post_id: null,
    author: {
      platform_user_id: authorId,
      handle,
      display_name: str(a?.nickName),
      followers: count(a?.fans),
      following: count(a?.following),
      verified: typeof a?.verified === "boolean" ? a.verified : null,
      created_at: toUtcIso(a?.createTime, "epoch_s"),
      location_raw: null,
      avatar_url: url(a?.avatar),
    },
    metrics: {
      likes: count(r.diggCount),
      comments: count(r.commentCount),
      shares: count(r.shareCount),
      views: count(r.playCount),
      quotes: null,
      saves: count(r.collectCount),
      captured_at: meta.fetchedAt,
    },
    hashtags: arr(r.hashtags)
      .map((h) => str(obj(h)?.name))
      .filter((x): x is string => !!x),
    mentions: arr(r.mentions)
      .map(str)
      .filter((x): x is string => !!x)
      .map((m) => m.replace(/^@/, "")),
    media: [{ type: "video", url: page, thumb: url(vm?.coverUrl) }],
    geo: noGeo, // `locationCreated` = kode negara pembuatan, bukan tempat → tidak dipetakan
    is_ad: ad,
    extra: {},
    provenance: provenance(meta),
  };
}

export const TIKTOK_CLOCKWORKS: ActorSpec = {
  key: "apify.tiktok.clockworks",
  platform: "tiktok",
  actorId: "clockworks/free-tiktok-scraper",
  version: "0.1.0",
  displayName: "TikTok via Apify (clockworks/free-tiktok-scraper)",
  docsUrl: "https://apify.com/clockworks/free-tiktok-scraper",
  operations: {
    search_keyword: {
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
      searchQueries: [plainQuery(req).replace(/"/g, "")],
      searchSection: "/video",
      resultsPerPage: req.maxItems,
      videoSearchSorting: "LATEST",
      videoSearchDateFilter: clockworksDateFilter(windowAgeDays(req.window)),
    };
  },
  normalize: normalizeClockworksTiktok,
};
