// X via Apify `apidojo/tweet-scraper` — PROVIDER_MATRIX §2.0 prioritas 3 (cadangan xquik).
// Bentuk: docs/evidence/shapes/shape-apidojo~tweet-scraper.json. `searchTerms` = sintaks advanced search X
// (dokumen actor merujuk igorbrigadir/twitter-advanced-search: since_time/until_time) → inkremental sama dgn xquik.
import type { CanonicalItem } from "@smip/contracts";
import { count, toUtcIso } from "@smip/connector-sdk";
import type { ActorSpec } from "./actor";
import { arr, type NormMeta, type Obj, obj, provenance, str, url } from "./util";
import { xWindowOperators } from "./x-xquik";

const MEDIA: Record<string, "image" | "video" | "gif"> = { photo: "image", video: "video", animated_gif: "gif" };

export function normalizeApidojoTweet(r: Obj, meta: NormMeta): CanonicalItem | null {
  const id = str(r.id);
  const published = toUtcIso(r.createdAt, "twitter_classic");
  const a = obj(r.author);
  const authorId = str(a?.id);
  const handle = str(a?.userName);
  if (!id || !published || !authorId || !handle) return null;
  const replyTo = str(r.inReplyToId);
  const q = obj(r.quote);
  const quoted = str(r.quoteId) ?? str(q?.id);
  const type = r.isRetweet === true ? "repost" : r.isQuote === true || quoted ? "quote" : r.isReply === true || replyTo ? "reply" : "post";
  const qa = obj(q?.author);
  const parent =
    type === "reply" && replyTo
      ? {
          platform_post_id: replyTo,
          author: str(r.inReplyToUserId) ? { platform_user_id: str(r.inReplyToUserId)!, handle: str(r.inReplyToUsername) } : null,
        }
      : type === "quote" && quoted
        ? { platform_post_id: quoted, author: str(qa?.id) ? { platform_user_id: str(qa?.id)!, handle: str(qa?.userName) } : null }
        : null;
  const ent = obj(r.entities);
  const conv = str(r.conversationId);
  const place = obj(r.place);
  return {
    schema: "canonical-item/v1",
    platform: "x",
    platform_post_id: id,
    content_type: type,
    url: url(r.url) ?? url(r.twitterUrl) ?? `https://x.com/${handle}/status/${id}`,
    text: str(r.fullText) ?? str(r.text) ?? "",
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
    media: arr(ent?.media).flatMap((m) => {
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

export const X_APIDOJO: ActorSpec = {
  key: "apify.x.apidojo",
  platform: "x",
  actorId: "apidojo/tweet-scraper",
  version: "0.1.0",
  displayName: "X via Apify (apidojo/tweet-scraper)",
  docsUrl: "https://apify.com/apidojo/tweet-scraper",
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
    const w = xWindowOperators(req.window);
    const q = req.query?.native ?? "";
    return { searchTerms: [w ? `${q} ${w}` : q], maxItems: req.maxItems, sort: "Latest" };
  },
  normalize: normalizeApidojoTweet,
};
