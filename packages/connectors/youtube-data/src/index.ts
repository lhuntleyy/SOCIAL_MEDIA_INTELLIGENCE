// YouTube Data API v3 (official) — PROVIDER_MATRIX §2.0 prioritas 1 untuk YouTube (§6.7, S-17).
// Fakta API (developers.google.com/youtube/v3): search.list (bucket "Search Queries" ~100 panggilan/hari; q mendukung
// OR `|` & NOT `-`; publishedAfter/Before RFC 3339; order=date; maxResults ≤ 50; pageToken) TANPA statistik →
// videos.list (1 unit, ≤ 50 id: deskripsi penuh + statistik) → channels.list (1 unit, ≤ 50 id: subscriber, handle).
// Bentuk respons: docs/evidence/shapes/shape-youtube-data-api.json (probe 2026-09-29).
// API key dikirim lewat header `X-Goog-Api-Key` (bukan query string) → tidak pernah muncul di URL/log.
// Quota harian dimodelkan di `quota_policies` (scope connector/akun, unit requests, day, hard) — BUKAN di kode (Golden Rule 1).

import {
  type Connector,
  type ConnectorContext,
  ConnectorError,
  type ConnectorManifest,
  count,
  type FetchRequest,
  type FetchResult,
  type HealthProbeResult,
  parseRetryAfter,
  toUtcIso,
} from "@smip/connector-sdk";
import type { CanonicalItem } from "@smip/contracts";

export const YT_API = "https://www.googleapis.com/youtube/v3";
export const YT_HOSTS = ["www.googleapis.com"];
const KEY = "youtube_data_api.youtube";
const VERSION = "0.1.0";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length ? v : null);

export interface YoutubeDataConfig {
  /** ISO 3166-1 alpha-2 — bias hasil pencarian (mis. "ID"). */
  regionCode?: string;
  /** ISO 639-1 — bias bahasa (mis. "id"). */
  relevanceLanguage?: string;
  /** Ambil subscriber channel (1 unit per panggilan). */
  fetchChannels?: boolean;
}

export const YOUTUBE_DATA_CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    regionCode: { type: "string", pattern: "^[A-Z]{2}$" },
    relevanceLanguage: { type: "string", pattern: "^[a-z]{2,3}(-[A-Za-z]+)?$" },
    fetchChannels: { type: "boolean" },
  },
} as const;

/** Query native gaya X (`"frasa" OR term`) → sintaks bar pencarian YouTube (`"frasa"|term`). */
export function toYoutubeQuery(native: string): string {
  return native
    .replace(/\s+OR\s+/g, "|")
    .replace(/[()]/g, "")
    .trim();
}

/** Error Google API (`{ error: { code, errors[].reason, details[].reason } }`) → ConnectorError terklasifikasi. */
export function classifyGoogleError(status: number, body: unknown): ConnectorError {
  const e = obj(obj(body).error);
  const reasons = [
    ...(Array.isArray(e.errors) ? e.errors : []).map((x) => str(obj(x).reason)),
    ...(Array.isArray(e.details) ? e.details : []).map((x) => str(obj(x).reason)),
  ].filter((x): x is string => !!x);
  const has = (...r: string[]) => reasons.some((x) => r.includes(x));
  const msg = `HTTP ${status}${reasons.length ? ` (${[...new Set(reasons)].join(",")})` : ""}`;
  if (has("quotaExceeded", "dailyLimitExceeded", "RATE_LIMIT_EXCEEDED_DAILY"))
    return new ConnectorError("QUOTA_EXHAUSTED", `quota harian YouTube habis — ${msg}`, { httpStatus: status, scope: "account" });
  if (has("rateLimitExceeded", "userRateLimitExceeded", "RATE_LIMIT_EXCEEDED") || status === 429)
    return new ConnectorError("RATE_LIMITED", msg, { httpStatus: status, scope: "account" });
  if (has("keyInvalid", "API_KEY_INVALID", "keyExpired", "API_KEY_EXPIRED") || status === 401)
    return new ConnectorError("AUTH_INVALID", `API key ditolak — ${msg}`, { httpStatus: status, scope: "account" });
  if (has("accessNotConfigured", "SERVICE_DISABLED", "API_KEY_SERVICE_BLOCKED", "forbidden", "ipRefererBlocked"))
    return new ConnectorError("FORBIDDEN", `akses API ditolak (API belum diaktifkan / key dibatasi) — ${msg}`, {
      httpStatus: status,
      scope: "account",
    });
  if (status === 400) return new ConnectorError("INVALID_QUERY", msg, { httpStatus: status, scope: "request" });
  if (status >= 500) return new ConnectorError("UPSTREAM_5XX", msg, { httpStatus: status });
  return new ConnectorError(status === 403 ? "FORBIDDEN" : "UNKNOWN", msg, { httpStatus: status });
}

async function call<T>(ctx: ConnectorContext, path: string, params: Record<string, string | undefined>): Promise<T> {
  const key = ctx.credential.secret.api_key;
  if (!key) throw new ConnectorError("AUTH_INVALID", "credential YouTube tanpa api_key", { scope: "account" });
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, v);
  const res = await ctx.http.request(`${YT_API}/${path}?${qs}`, {
    signal: ctx.signal,
    headers: { "X-Goog-Api-Key": key, accept: "application/json" },
    throwOnStatus: false,
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    if (!res.ok) throw classifyGoogleError(res.status, null);
    throw new ConnectorError("PARSE_ERROR", "respons YouTube bukan JSON", { cause: e, httpStatus: res.status });
  }
  if (!res.ok) {
    const err = classifyGoogleError(res.status, body);
    if (err.code === "RATE_LIMITED") {
      // Google jarang mengirim Retry-After → router memakai backoff default bila null
      ctx.reportRateLimit({
        remaining: 0,
        resetAt: null,
        retryAfterMs: parseRetryAfter(res.headers.get("retry-after")) ?? null,
        scope: "provider_account",
      });
    }
    throw err;
  }
  return body as T;
}

interface Video {
  id: string;
  snippet?: Obj;
  statistics?: Obj;
}
interface Channel {
  id: string;
  snippet?: Obj;
  statistics?: Obj;
}

const HASHTAG = /#([\p{L}\p{N}_]{2,100})/gu;

interface CommentThread {
  id?: string;
  snippet?: Obj;
}

/** commentThreads.list → komentar tingkat atas (content_type comment, parent = video). Bentuk diverifikasi live 2026-10-03. */
export function normalizeComment(
  t: CommentThread,
  videoChannelId: string | null,
  meta: { fetchedAt: string; rawRef: string | null },
): CanonicalItem | null {
  const top = obj(obj(t.snippet).topLevelComment);
  const s = obj(top.snippet);
  const id = str(top.id) ?? str(t.id);
  const vid = str(s.videoId) ?? str(obj(t.snippet).videoId);
  const authorId = str(obj(s.authorChannelId).value);
  const name = str(s.authorDisplayName);
  const published = str(s.publishedAt);
  if (!id || !vid || !authorId || !published || Number.isNaN(Date.parse(published))) return null;
  const text = str(s.textOriginal) ?? str(s.textDisplay) ?? "";
  const handle = name?.startsWith("@") ? name.slice(1) : (name ?? authorId);
  return {
    schema: "canonical-item/v1",
    platform: "youtube",
    platform_post_id: id,
    content_type: "comment",
    url: `https://www.youtube.com/watch?v=${vid}&lc=${id}`,
    text,
    lang_hint: null,
    published_at: new Date(published).toISOString(),
    parent: { platform_post_id: vid, author: videoChannelId ? { platform_user_id: videoChannelId, handle: null } : null },
    root_post_id: vid,
    author: {
      platform_user_id: authorId,
      handle,
      display_name: name,
      followers: null,
      following: null,
      verified: null,
      created_at: null,
      location_raw: null,
      avatar_url: null,
    },
    metrics: {
      likes: typeof s.likeCount === "number" ? s.likeCount : null,
      comments: typeof obj(t.snippet).totalReplyCount === "number" ? (obj(t.snippet).totalReplyCount as number) : null,
      shares: null,
      views: null,
      quotes: null,
      saves: null,
      captured_at: meta.fetchedAt,
    },
    hashtags: [...new Set([...text.matchAll(HASHTAG)].map((m) => m[1]!.toLowerCase()))],
    mentions: [],
    media: [],
    geo: { lat: null, lng: null, place_name: null },
    is_ad: null,
    extra: {},
    provenance: { connector_key: KEY, connector_version: VERSION, fetched_at: meta.fetchedAt, raw_ref: meta.rawRef },
  };
}

export function normalizeVideo(
  v: Video,
  ch: Channel | undefined,
  meta: { fetchedAt: string; rawRef: string | null },
): CanonicalItem | null {
  const s = obj(v.snippet);
  const published = toUtcIso(s.publishedAt);
  const channelId = str(s.channelId);
  if (!str(v.id) || !published || !channelId) return null;
  const st = obj(v.statistics);
  const cs = obj(ch?.snippet);
  const cst = obj(ch?.statistics);
  const title = str(s.title) ?? "";
  const desc = str(s.description) ?? "";
  const text = desc ? `${title}\n\n${desc}` : title;
  const thumbs = obj(s.thumbnails);
  const thumb = str(obj(thumbs.high).url) ?? str(obj(thumbs.medium).url) ?? str(obj(thumbs.default).url);
  const link = `https://www.youtube.com/watch?v=${v.id}`;
  const lang = str(s.defaultAudioLanguage) ?? str(s.defaultLanguage);
  return {
    schema: "canonical-item/v1",
    platform: "youtube",
    platform_post_id: v.id,
    content_type: "post",
    url: link,
    text,
    lang_hint: lang ? lang.slice(0, 2).toLowerCase() : null,
    published_at: published,
    parent: null,
    root_post_id: null,
    author: {
      platform_user_id: channelId,
      handle: str(cs.customUrl)?.replace(/^@/, "") ?? channelId,
      display_name: str(s.channelTitle) ?? str(cs.title),
      // hiddenSubscriberCount → tak diketahui (null), bukan 0
      followers: cst.hiddenSubscriberCount === true ? null : count(cst.subscriberCount),
      following: null,
      verified: null,
      created_at: toUtcIso(cs.publishedAt),
      location_raw: null,
      avatar_url: str(obj(obj(cs.thumbnails).default).url),
    },
    metrics: {
      likes: count(st.likeCount),
      comments: count(st.commentCount),
      shares: null,
      views: count(st.viewCount),
      quotes: null,
      saves: null,
      captured_at: meta.fetchedAt,
    },
    hashtags: [...new Set([...text.matchAll(HASHTAG)].map((m) => m[1]!.toLowerCase()))],
    mentions: [],
    media: [{ type: "video", url: link, thumb }],
    geo: { lat: null, lng: null, place_name: null },
    is_ad: null,
    extra: {},
    provenance: { connector_key: KEY, connector_version: VERSION, fetched_at: meta.fetchedAt, raw_ref: meta.rawRef },
  };
}

export class YoutubeDataConnector implements Connector {
  readonly manifest: ConnectorManifest = {
    key: KEY,
    version: VERSION,
    providerKey: "youtube_data_api",
    providerKind: "official",
    platform: "youtube",
    runtime: "bun",
    displayName: "YouTube Data API v3 (official)",
    credentialKinds: ["api_key"],
    configSchema: YOUTUBE_DATA_CONFIG_SCHEMA,
    operations: {
      search_keyword: {
        // q: OR `|`, NOT `-`, "frasa" — grup/AND tidak dijamin ketat (relevansi) → matcher lokal tetap menyaring
        queryFeatures: ["term", "phrase", "or"],
        maxQueryLength: 500,
        supportsSince: true,
        supportsUntil: true,
        supportsCursor: true,
        maxPageSize: 50,
        returnsFields: ["metrics.views", "metrics.likes", "metrics.comments", "author.followers"],
        asyncExecution: false,
        resultOrder: "desc",
      },
      post_comments: {
        // komentar post teratas topik: commentThreads.list (1 unit kuota/panggilan, ≤ 100 komentar/halaman)
        queryFeatures: [],
        maxQueryLength: null,
        supportsSince: false,
        supportsUntil: false,
        supportsCursor: false,
        maxPageSize: 100,
        returnsFields: ["metrics.likes"],
        asyncExecution: false,
        resultOrder: "desc",
      },
      post_detail: {
        // engagement refresh (I-20): videos.list per ≤ 50 id
        queryFeatures: [],
        maxQueryLength: null,
        supportsSince: false,
        supportsUntil: false,
        supportsCursor: false,
        maxPageSize: 50,
        returnsFields: ["metrics.views", "metrics.likes", "metrics.comments"],
        asyncExecution: false,
        resultOrder: null,
      },
    },
    costModel: { unit: "request", reportsUsageInResponse: false },
    docsUrl: "https://developers.google.com/youtube/v3/docs/search/list",
    allowedHosts: YT_HOSTS,
  };

  private cfg(ctx: ConnectorContext): YoutubeDataConfig {
    return ctx.config as YoutubeDataConfig;
  }

  /** videos.list (+ channels.list) untuk ≤ 50 id → item kanonik. Mengembalikan jumlah request yang dipakai. */
  private async hydrate(ids: string[], req: FetchRequest, ctx: ConnectorContext) {
    if (!ids.length) return { items: [] as CanonicalItem[], raw: [] as Video[], requests: 0, dropped: 0 };
    const vids = await call<{ items?: Video[] }>(ctx, "videos", { part: "snippet,statistics", id: ids.join(","), maxResults: "50" });
    const raw = vids.items ?? [];
    let requests = 1;
    const chans = new Map<string, Channel>();
    const chIds = [...new Set(raw.map((v) => str(obj(v.snippet).channelId)).filter((x): x is string => !!x))];
    if (chIds.length && this.cfg(ctx).fetchChannels !== false) {
      const c = await call<{ items?: Channel[] }>(ctx, "channels", { part: "snippet,statistics", id: chIds.join(","), maxResults: "50" });
      requests++;
      for (const x of c.items ?? []) chans.set(x.id, x);
    }
    const fetchedAt = new Date().toISOString();
    const rawRef = raw.length
      ? await ctx.archiveRaw(
          { videos: raw, channels: [...chans.values()] },
          { platform: "youtube", crawlRunId: req.idempotencyKey, attemptNo: 1, page: 1 },
        )
      : null;
    const items: CanonicalItem[] = [];
    let dropped = 0;
    for (const v of raw) {
      const it = normalizeVideo(v, chans.get(str(obj(v.snippet).channelId) ?? ""), { fetchedAt, rawRef });
      if (!it || (req.window?.since && it.published_at < req.window.since) || (req.window?.until && it.published_at > req.window.until)) {
        dropped++;
        continue;
      }
      items.push(it);
    }
    return { items, raw, requests, dropped, rawRef };
  }

  async fetch(req: FetchRequest, ctx: ConnectorContext): Promise<FetchResult> {
    if (ctx.signal.aborted) throw new ConnectorError("TIMEOUT", "deadline sudah lewat");
    if (req.operation === "post_detail") {
      const ids = (req.targetIds ?? []).slice(0, 50);
      if (!ids.length) throw new ConnectorError("INVALID_QUERY", "post_detail butuh targetIds", { scope: "request" });
      const h = await this.hydrate(ids, { ...req, window: undefined }, ctx);
      return {
        items: h.items,
        nextCursor: null,
        hasMore: false,
        rawRefs: h.rawRef ? [h.rawRef] : [],
        usage: { requests: h.requests, results: h.raw.length, costUnits: 0, costUnitLabel: "usd" },
        upstream: { httpStatuses: [200], requestIds: [] },
        warnings: h.dropped ? [{ code: "ITEMS_DROPPED", message: `${h.dropped} item dibuang (normalisasi)` }] : [],
      };
    }
    if (req.operation === "post_comments") return this.comments(req, ctx);
    if (req.operation !== "search_keyword")
      throw new ConnectorError("NOT_SUPPORTED", `operation ${req.operation} tidak didukung`, { scope: "connector" });
    const q = toYoutubeQuery(req.query?.native ?? "");
    if (!q) throw new ConnectorError("INVALID_QUERY", "query kosong", { scope: "request" });
    const cfg = this.cfg(ctx);
    const search = await call<{ items?: { id?: { videoId?: string } }[]; nextPageToken?: string }>(ctx, "search", {
      part: "id",
      type: "video",
      order: "date",
      q,
      maxResults: String(Math.max(1, Math.min(50, req.maxItems))),
      publishedAfter: req.window?.since,
      publishedBefore: req.window?.until,
      pageToken: req.cursor ?? undefined,
      regionCode: cfg.regionCode,
      relevanceLanguage: cfg.relevanceLanguage,
      safeSearch: "none",
    });
    const ids = [...new Set((search.items ?? []).map((x) => x.id?.videoId).filter((x): x is string => !!x))];
    const h = await this.hydrate(ids, req, ctx);
    return {
      items: h.items.slice(0, req.maxItems),
      nextCursor: search.nextPageToken ?? null,
      hasMore: !!search.nextPageToken && ids.length > 0,
      rawRefs: h.rawRef ? [h.rawRef] : [],
      // API gratis: biaya USD 0; yang membatasi = quota harian (requests) → quota_policies
      usage: { requests: 1 + h.requests, results: ids.length, costUnits: 0, costUnitLabel: "usd" },
      upstream: { httpStatuses: [200], requestIds: [] },
      warnings: h.dropped ? [{ code: "ITEMS_DROPPED", message: `${h.dropped} item dibuang (normalisasi/window)` }] : [],
    };
  }

  /** Komentar tingkat atas video target, terbaru dulu; ≤ pageLimit halaman × 100 per video. Komentar dimatikan → video dilewati. */
  private async comments(req: FetchRequest, ctx: ConnectorContext): Promise<FetchResult> {
    const ids = (req.targetIds ?? []).filter((x) => /^[\w-]{2,64}$/.test(x)).slice(0, 50);
    if (!ids.length) throw new ConnectorError("INVALID_QUERY", "post_comments butuh targetIds (id video)", { scope: "request" });
    const raw: CommentThread[] = [];
    const owner = new Map<string, string | null>();
    let requests = 0;
    let skipped = 0;
    for (const vid of ids) {
      let page: string | undefined;
      for (let p = 0; p < Math.max(1, req.pageLimit); p++) {
        let body: { items?: CommentThread[]; nextPageToken?: string };
        requests++; // panggilan yang ditolak (komentar dimatikan) tetap memakai kuota
        try {
          body = await call(ctx, "commentThreads", {
            part: "snippet",
            videoId: vid,
            maxResults: "100",
            order: "time",
            textFormat: "plainText",
            pageToken: page,
          });
        } catch (e) {
          // video dengan komentar dimatikan / dihapus / privat: lewati video itu (bukan masalah akun)
          if (
            e instanceof ConnectorError &&
            (e.httpStatus === 403 || e.httpStatus === 404) &&
            /commentsDisabled|videoNotFound|forbidden/.test(e.message)
          ) {
            skipped++;
            break;
          }
          throw e;
        }
        for (const t of body.items ?? []) {
          raw.push(t);
          owner.set(str(t.id) ?? "", str(obj(t.snippet).channelId));
        }
        page = body.nextPageToken;
        if (!page || !(body.items ?? []).length) break;
      }
    }
    const fetchedAt = new Date().toISOString();
    const rawRef = raw.length
      ? await ctx.archiveRaw(raw, { platform: "youtube", crawlRunId: req.idempotencyKey, attemptNo: 1, page: 1 })
      : null;
    const items: CanonicalItem[] = [];
    let dropped = 0;
    for (const t of raw) {
      const it = normalizeComment(t, owner.get(str(t.id) ?? "") ?? null, { fetchedAt, rawRef });
      if (it) items.push(it);
      else dropped++;
    }
    const warnings: FetchResult["warnings"] = [];
    if (skipped) warnings.push({ code: "TARGETS_SKIPPED", message: `${skipped} video tanpa komentar (dimatikan/dihapus)` });
    if (dropped) warnings.push({ code: "ITEMS_DROPPED", message: `${dropped} komentar dibuang (normalisasi)` });
    return {
      items: items.slice(0, req.maxItems),
      nextCursor: null,
      hasMore: false,
      rawRefs: rawRef ? [rawRef] : [],
      usage: { requests, results: raw.length, costUnits: 0, costUnitLabel: "usd" },
      upstream: { httpStatuses: [200], requestIds: [] },
      warnings,
    };
  }

  async healthProbe(ctx: ConnectorContext): Promise<HealthProbeResult> {
    // probe termurah (1 unit, tidak memakai bucket search): daftar region
    const t0 = performance.now();
    try {
      if (ctx.signal.aborted) return { ok: false, latencyMs: 0, errorCode: "TIMEOUT" };
      await call(ctx, "i18nRegions", { part: "id", hl: "id" });
      return { ok: true, latencyMs: Math.round(performance.now() - t0) };
    } catch (e) {
      return { ok: false, latencyMs: Math.round(performance.now() - t0), errorCode: e instanceof ConnectorError ? e.code : "UNKNOWN" };
    }
  }
}

export const allowedHosts = YT_HOSTS;
