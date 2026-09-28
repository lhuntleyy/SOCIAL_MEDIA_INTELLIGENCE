// X via Apify actor `xquik/x-tweet-scraper` — PROVIDER_MATRIX §2.0 prioritas 2 (TESTED 2026-09-28).
// Bentuk output & skema input: docs/evidence/shapes/shape-xquik~x-tweet-scraper.json (probe 2026-09-29, build 1.12.324).
//   - `searchTerms` menerima sintaks search X termasuk operator waktu Unix (`since_time:`/`until_time:`) → inkremental
//   - `queryType: "Latest"` = terbaru dulu (resultOrder desc)
//   - waktu `createdAt` = format Twitter klasik → toUtcIso(…, "twitter_classic")
// Hanya field CanonicalItem yang dipetakan; bio/profil/lainnya dibuang (minimisasi PII, SECURITY §9).
import type { CanonicalItem } from "@smip/contracts";
import { count, type FetchRequest, toUtcIso } from "@smip/connector-sdk";
import type { ActorSpec } from "./actor";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length ? v : null);
const url = (v: unknown): string | null => {
  const s = str(v);
  return s && /^https?:\/\//.test(s) ? s : null;
};

/** `since_time:`/`until_time:` dari window (detik Unix) — ditambahkan ke setiap search term. */
export function xWindowOperators(w: FetchRequest["window"]): string {
  const parts: string[] = [];
  if (w?.since) parts.push(`since_time:${Math.floor(Date.parse(w.since) / 1000)}`);
  if (w?.until) parts.push(`until_time:${Math.floor(Date.parse(w.until) / 1000)}`);
  return parts.join(" ");
}

const MEDIA: Record<string, "image" | "video" | "gif"> = { photo: "image", video: "video", animated_gif: "gif" };

export function normalizeXquik(
  r: Obj,
  meta: { key: string; version: string; fetchedAt: string; rawRef: string | null },
): CanonicalItem | null {
  const id = str(r.id);
  const published = toUtcIso(r.createdAt, "twitter_classic");
  const a = obj(r.author);
  const authorId = str(a?.id);
  const handle = str(a?.username);
  if (!id || !published || !authorId || !handle) return null; // wajib; JANGAN menebak
  const replyTo = str(r.inReplyToId);
  const quoted = str(r.quotedTweetId) ?? str(obj(r.quoted_tweet)?.id);
  const contentType =
    r.isRetweet === true ? "repost" : quoted || r.isQuoteStatus === true ? "quote" : replyTo || r.isReply === true ? "reply" : "post";
  const parent =
    contentType === "reply" && replyTo
      ? {
          platform_post_id: replyTo,
          author: str(r.inReplyToUserId) ? { platform_user_id: str(r.inReplyToUserId)!, handle: str(r.inReplyToUsername) } : null,
        }
      : contentType === "quote" && quoted
        ? {
            platform_post_id: quoted,
            author: (() => {
              const qa = obj(obj(r.quoted_tweet)?.author);
              return str(qa?.id) ? { platform_user_id: str(qa?.id)!, handle: str(qa?.username) } : null;
            })(),
          }
        : null; // retweet: penulis asli tidak ada di output → null (bukan tebakan)
  const conv = str(r.conversationId);
  const ent = obj(r.entities);
  const tags = Array.isArray(ent?.hashtags)
    ? (ent.hashtags as unknown[]).map((h) => str(obj(h)?.text)).filter((x): x is string => !!x)
    : [];
  const mentions = Array.isArray(ent?.user_mentions)
    ? (ent.user_mentions as unknown[]).map((m) => str(obj(m)?.screen_name) ?? str(obj(m)?.username)).filter((x): x is string => !!x)
    : [];
  const media = Array.isArray(r.media)
    ? (r.media as unknown[]).flatMap((m) => {
        const o = obj(m);
        const t = MEDIA[String(o?.type)];
        const u = url(o?.mediaUrl) ?? url(o?.url);
        return t && u ? [{ type: t, url: u, thumb: null }] : [];
      })
    : [];
  const place = obj(r.place);
  return {
    schema: "canonical-item/v1",
    platform: "x",
    platform_post_id: id,
    content_type: contentType,
    url: url(r.url) ?? `https://x.com/${handle}/status/${id}`,
    text: typeof r.text === "string" ? r.text : "",
    lang_hint: str(r.lang),
    published_at: published,
    parent,
    root_post_id: conv && conv !== id ? conv : null,
    author: {
      platform_user_id: authorId,
      handle,
      display_name: str(a?.name),
      followers: count(a?.followers),
      following: count(a?.following),
      verified: typeof a?.isVerified === "boolean" ? a.isVerified : typeof a?.verified === "boolean" ? (a.verified as boolean) : null,
      created_at: toUtcIso(a?.createdAt, "twitter_classic"),
      location_raw: str(a?.location),
      avatar_url: url(a?.profilePicture),
    },
    metrics: {
      likes: count(r.likeCount),
      comments: count(r.replyCount),
      shares: count(r.retweetCount),
      views: count(r.viewCount),
      quotes: count(r.quoteCount),
      saves: count(r.bookmarkCount),
      captured_at: meta.fetchedAt,
    },
    hashtags: tags,
    mentions,
    media,
    geo: { lat: null, lng: null, place_name: str(place?.full_name) ?? str(place?.name) },
    is_ad: null, // tidak ada sinyal iklan di output (FR-I07)
    extra: {},
    provenance: { connector_key: meta.key, connector_version: meta.version, fetched_at: meta.fetchedAt, raw_ref: meta.rawRef },
  };
}

export const X_XQUIK: ActorSpec = {
  key: "apify.x.xquik",
  platform: "x",
  actorId: "xquik/x-tweet-scraper",
  version: "0.1.0",
  displayName: "X via Apify (xquik/x-tweet-scraper)",
  docsUrl: "https://apify.com/xquik/x-tweet-scraper",
  operations: {
    search_keyword: {
      // sintaks search X: "frasa", OR, spasi=AND, -neg, (grup), lang:
      queryFeatures: ["term", "phrase", "or", "and", "not", "group"],
      // batas teknis panjang query search X; operator waktu (~45 karakter) ikut ditambahkan
      maxQueryLength: 450,
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
    const w = xWindowOperators(req.window);
    const q = req.query?.native ?? "";
    return { searchTerms: [w ? `${q} ${w}` : q], maxItems: req.maxItems, queryType: "Latest" };
  },
  normalize: normalizeXquik,
};
