// Instagram via hashtag — Apify resmi `apify/instagram-hashtag-scraper` (cadangan recall IG, PROVIDER_MATRIX §2.0 #3).
// Probe 2026-09-29: untuk "koperasi merah putih" OR kopdes, pencarian boolean hanya 6 post/7 hari, sedangkan feed hashtag
// #kopdes/#koperasimerahputih/#kdmp memberi 11 post dalam SATU hari (terpotong batas biaya). Bentuk:
// docs/evidence/shapes/shape-apify~instagram-hashtag-scraper.json.
//   - operasi `search_keyword`: term/frasa query → hashtag (huruf kecil, tanpa spasi/tanda baca); superset, matcher lokal
//     tetap menyaring post yang benar-benar cocok topik.
//   - hasil tidak dijamin terurut waktu → saring lokal ke window (ActorSpec runner).
//   - `paidPartnership` → sinyal iklan.
import { ConnectorError, count, toUtcIso } from "@smip/connector-sdk";
import type { CanonicalItem } from "@smip/contracts";
import type { ActorSpec } from "./actor";
import { arr, type NormMeta, noGeo, type Obj, provenance, str, url } from "./util";

/** Batas hashtag per run — biaya actor per hasil × jumlah hashtag. */
export const IG_MAX_HASHTAGS = 5;

/** `"koperasi merah putih" OR kopdes OR #KDMP` → ["koperasimerahputih", "kopdes", "kdmp"] (unik, ≥ 3 karakter). */
export function queryToHashtags(native: string): string[] {
  const out: string[] = [];
  for (const part of native.split(/\s+OR\s+/i)) {
    const tag = part
      .replace(/\bNOT\b.*$/i, "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_]+/gu, "");
    if (tag.length >= 3 && !out.includes(tag)) out.push(tag);
  }
  return out;
}

export function normalizeInstagramHashtag(r: Obj, meta: NormMeta): CanonicalItem | null {
  const code = str(r.shortCode);
  const published = toUtcIso(r.timestamp);
  const handle = str(r.ownerUsername);
  const authorId = str(r.ownerId) ?? handle;
  if (!code || !published || !handle || !authorId) return null;
  const isVideo = /video|clips|reel/i.test(`${str(r.type) ?? ""} ${str(r.productType) ?? ""}`);
  const media = url(r.displayUrl);
  return {
    schema: "canonical-item/v1",
    platform: "instagram",
    platform_post_id: code,
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
      display_name: str(r.ownerFullName),
      followers: null,
      following: null,
      verified: null,
      created_at: null,
      location_raw: null,
      avatar_url: null,
    },
    metrics: {
      likes: count(r.likesCount),
      comments: count(r.commentsCount),
      shares: null,
      views: count(r.videoViewCount),
      quotes: null,
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
      .map((m) => m.replace(/^@/, "")),
    media: media ? [{ type: isVideo ? "video" : "image", url: media, thumb: null }] : [],
    geo: str(r.locationName) ? { ...noGeo, place_name: str(r.locationName) } : noGeo,
    is_ad: typeof r.paidPartnership === "boolean" ? r.paidPartnership : null,
    extra: {},
    provenance: provenance(meta),
  };
}

export const INSTAGRAM_HASHTAG: ActorSpec = {
  key: "apify.instagram.hashtag",
  platform: "instagram",
  actorId: "apify/instagram-hashtag-scraper",
  version: "0.1.0",
  displayName: "Instagram via hashtag (Apify resmi)",
  docsUrl: "https://apify.com/apify/instagram-hashtag-scraper",
  operations: {
    search_keyword: {
      queryFeatures: ["term", "phrase", "or"],
      maxQueryLength: 300,
      supportsSince: false,
      supportsUntil: false,
      supportsCursor: false,
      maxPageSize: 200,
      returnsFields: ["metrics.likes", "metrics.comments"],
      asyncExecution: true,
      resultOrder: null,
      sinceGranularity: "day", // filter waktu provider per hari/jam (atau tidak ada) → poll mengembalikan ulang post lama
    },
  },
  buildInput(req) {
    const tags = queryToHashtags(req.query?.native ?? "");
    if (!tags.length) throw new ConnectorError("INVALID_QUERY", "query tidak menghasilkan hashtag", { scope: "request" });
    const use = tags.slice(0, IG_MAX_HASHTAGS);
    return { hashtags: use, resultsType: "posts", resultsLimit: Math.max(5, Math.ceil(req.maxItems / use.length)) };
  },
  normalize: normalizeInstagramHashtag,
};
