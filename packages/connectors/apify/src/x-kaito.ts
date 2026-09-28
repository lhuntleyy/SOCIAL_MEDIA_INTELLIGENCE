// X via Apify `kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest` — cadangan X #2 (setelah xquik).
// Bentuk: docs/evidence/shapes/shape-kaitoeasyapi~….json (probe 2026-09-29). Input: `twitterContent` + field operator
// terpisah (`since_time`/`until_time` detik Unix) — skema input actor; `maxItems` minimal 20 (catatan actor, PROVIDER_MATRIX).
// Dipilih menggantikan apidojo (ditolak pemilik 2026-09-29: batas run bulanan plan FREE).
import type { CanonicalItem } from "@smip/contracts";
import { count, toUtcIso } from "@smip/connector-sdk";
import type { ActorSpec } from "./actor";
import { arr, type NormMeta, type Obj, obj, provenance, str, url } from "./util";

const MEDIA: Record<string, "image" | "video" | "gif"> = { photo: "image", video: "video", animated_gif: "gif" };
/** Minimum item per run menurut actor — hasil berlebih tetap ditagih, dipotong di connector. */
export const KAITO_MIN_ITEMS = 20;

export function normalizeKaitoTweet(r: Obj, meta: NormMeta): CanonicalItem | null {
  const id = str(r.id);
  const published = toUtcIso(r.createdAt, "twitter_classic");
  const a = obj(r.author);
  const authorId = str(a?.id);
  const handle = str(a?.userName);
  if (!id || !published || !authorId || !handle) return null;
  const replyTo = str(r.inReplyToId);
  const q = obj(r.quoted_tweet);
  const quoted = str(q?.id) ?? str(obj(r.quoted_tweet_results)?.rest_id);
  const retweet = obj(r.retweeted_tweet);
  const type = retweet ? "repost" : r.isQuote === true || quoted ? "quote" : r.isReply === true || replyTo ? "reply" : "post";
  const qa = obj(q?.author);
  const ra = obj(retweet?.author);
  const parent =
    type === "reply" && replyTo
      ? {
          platform_post_id: replyTo,
          author: str(r.inReplyToUserId) ? { platform_user_id: str(r.inReplyToUserId)!, handle: str(r.inReplyToUsername) } : null,
        }
      : type === "quote" && quoted
        ? { platform_post_id: quoted, author: str(qa?.id) ? { platform_user_id: str(qa?.id)!, handle: str(qa?.userName) } : null }
        : type === "repost" && str(retweet?.id)
          ? {
              platform_post_id: str(retweet?.id)!,
              author: str(ra?.id) ? { platform_user_id: str(ra?.id)!, handle: str(ra?.userName) } : null,
            }
          : null;
  const ent = obj(r.entities);
  const ext = obj(r.extendedEntities);
  const conv = str(r.conversationId);
  const place = obj(r.place);
  return {
    schema: "canonical-item/v1",
    platform: "x",
    platform_post_id: id,
    content_type: type,
    url: url(r.url) ?? url(r.twitterUrl) ?? `https://x.com/${handle}/status/${id}`,
    text: str(r.text) ?? "",
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
      verified: typeof a?.isVerified === "boolean" ? a.isVerified : null,
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
    hashtags: arr(ent?.hashtags)
      .map((h) => str(obj(h)?.text))
      .filter((x): x is string => !!x),
    mentions: arr(ent?.user_mentions)
      .map((m) => str(obj(m)?.screen_name) ?? str(obj(m)?.username))
      .filter((x): x is string => !!x),
    media: arr(ext?.media).flatMap((m) => {
      const o = obj(m);
      const t = MEDIA[String(o?.type)];
      const u = url(o?.media_url_https);
      return t && u ? [{ type: t, url: u, thumb: null }] : [];
    }),
    geo: { lat: null, lng: null, place_name: str(place?.full_name) ?? str(place?.name) },
    is_ad: null,
    extra: {},
    provenance: provenance(meta),
  };
}

export const X_KAITO: ActorSpec = {
  key: "apify.x.kaito",
  platform: "x",
  actorId: "kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest",
  version: "0.1.0",
  displayName: "X via Apify (kaitoeasyapi tweet scraper)",
  docsUrl: "https://apify.com/kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest",
  operations: {
    search_keyword: {
      queryFeatures: ["term", "phrase", "or", "and", "not", "group"],
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
    const since = req.window?.since ? String(Math.floor(Date.parse(req.window.since) / 1000)) : undefined;
    const until = req.window?.until ? String(Math.floor(Date.parse(req.window.until) / 1000)) : undefined;
    return {
      twitterContent: req.query?.native ?? "",
      maxItems: Math.max(KAITO_MIN_ITEMS, req.maxItems),
      queryType: "Latest",
      ...(since ? { since_time: since } : {}),
      ...(until ? { until_time: until } : {}),
    };
  },
  normalize: normalizeKaitoTweet,
};
