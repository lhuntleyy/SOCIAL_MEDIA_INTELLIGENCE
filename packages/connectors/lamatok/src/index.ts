// TikTok via LamaTok (SaaS HTTP, satu penerbit dengan HikerAPI) — satu-satunya sumber TikTok sejak 2026-10-01 (keputusan pemilik;
// PROVIDER_MATRIX "Uji LamaTok"). Operasi:
//   search_keyword  GET /v2/search?keyword=&count=30&page_id=   — ±30 video/request, cukup segar (uji: 39/60 ≤ 24 jam) tapi tidak
//                   terurut ketat → maks. `maxSearchPages` halaman; berhenti dini bila satu halaman tak punya video ≥ window.since.
//   user_timeline   GET /v1/user/by/username → secUid → GET /v2/user/medias/by/secUid — pantau akun (menu Akun).
//   post_comments   GET /v2/media/comments/by/id?count=50 — komentar video (content_type comment, parent = video).
// Auth header `x-access-key`. Harga TIDAK di kode (Golden Rule 1): biaya = requests × connectors.config.usdPerRequest.

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
} from "@smip/connector-sdk";
import type { CanonicalItem } from "@smip/contracts";

export const LAMATOK_API = "https://api.lamatok.com";
export const LAMATOK_HOSTS = ["api.lamatok.com"];
const KEY = "lamatok.tiktok";
const VERSION = "0.1.0";
const KEEP_OLD_MS = 30 * 86_400_000;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length ? v : typeof v === "number" ? String(v) : null);

export interface LamatokConfig {
  usdPerRequest?: number;
  /** Maks. halaman pencarian per keyword per run (default = pageLimit request, maks 5). */
  maxSearchPages?: number;
  /** Maks. keyword (cabang OR) per run. */
  maxKeywords?: number;
  /** Maks. halaman komentar per video (50 komentar/halaman). */
  maxCommentPages?: number;
}

export const LAMATOK_CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    usdPerRequest: { type: "number", minimum: 0, maximum: 1 },
    maxSearchPages: { type: "integer", minimum: 1, maximum: 20 },
    maxKeywords: { type: "integer", minimum: 1, maximum: 20 },
    maxCommentPages: { type: "integer", minimum: 1, maximum: 20 },
  },
} as const;

/** Cabang OR query native → keyword polos (tanpa kutip, tanpa NOT). */
export function keywordsOf(native: string): string[] {
  const out: string[] = [];
  for (const raw of native.split(/\s+OR\s+/i)) {
    const k = raw
      .replace(/\bNOT\b.*$/i, "")
      .replace(/[()"]/g, "")
      .replace(/^#/, "")
      .trim();
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

/** Semua objek video (aweme: punya aweme_id + create_time + desc) di respons apa pun, unik per id. */
export function collectVideos(body: unknown): Obj[] {
  const out = new Map<string, Obj>();
  const walk = (x: unknown) => {
    if (Array.isArray(x)) {
      for (const v of x) walk(v);
      return;
    }
    if (!x || typeof x !== "object") return;
    const o = x as Obj;
    const id = str(o.aweme_id);
    if (id && o.create_time !== undefined && "desc" in o) {
      if (!out.has(id)) out.set(id, o);
      return;
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(body);
  return [...out.values()];
}

const authorOf = (a: Obj) => {
  const handle = str(a.unique_id);
  return {
    platform_user_id: str(a.uid) ?? handle ?? "",
    handle,
    display_name: str(a.nickname),
    followers: count(a.follower_count),
    following: count(a.following_count),
    verified: typeof a.verification_type === "number" ? a.verification_type > 0 : null,
    created_at: null,
    location_raw: null,
    avatar_url: str(arr(obj(a.avatar_thumb).url_list)[0]),
  };
};

export function normalizeVideo(v: Obj, meta: { fetchedAt: string; rawRef: string | null }): CanonicalItem | null {
  const id = str(v.aweme_id);
  const ts = Number(v.create_time);
  const author = authorOf(obj(v.author));
  const handle = author.handle;
  if (!id || !Number.isFinite(ts) || ts <= 0 || !author.platform_user_id || !handle) return null;
  const st = obj(v.statistics);
  const text = str(v.desc) ?? "";
  const cover = str(arr(obj(obj(v.video).cover).url_list)[0]);
  const tags = arr(v.text_extra)
    .map((t) => str(obj(t).hashtag_name))
    .filter((t): t is string => !!t)
    .map((t) => t.toLowerCase());
  const mentions = arr(v.text_extra)
    .map((t) => str(obj(t).user_unique_id) ?? str(obj(t).user_id))
    .filter((t): t is string => !!t && !/^\d+$/.test(t))
    .map((t) => t.toLowerCase());
  const lang = str(v.desc_language);
  const url = `https://www.tiktok.com/@${handle}/video/${id}`;
  return {
    schema: "canonical-item/v1",
    platform: "tiktok",
    platform_post_id: id,
    content_type: "post",
    url,
    text,
    lang_hint: lang && lang !== "un" ? lang.slice(0, 2).toLowerCase() : null,
    published_at: new Date(ts * 1000).toISOString(),
    parent: null,
    root_post_id: null,
    author: { ...author, handle },
    metrics: {
      likes: count(st.digg_count),
      comments: count(st.comment_count),
      shares: count(st.share_count),
      views: count(st.play_count),
      quotes: null,
      saves: count(st.collect_count),
      captured_at: meta.fetchedAt,
    },
    hashtags: [...new Set(tags)],
    mentions: [...new Set(mentions)],
    media: [{ type: "video", url, thumb: cover }],
    geo: { lat: null, lng: null, place_name: null },
    is_ad: typeof v.is_ads === "boolean" ? v.is_ads : null,
    extra: {},
    provenance: { connector_key: KEY, connector_version: VERSION, fetched_at: meta.fetchedAt, raw_ref: meta.rawRef },
  };
}

export function normalizeComment(
  c: Obj,
  parent: { id: string; authorId: string | null; authorHandle: string | null },
  meta: { fetchedAt: string; rawRef: string | null },
): CanonicalItem | null {
  const id = str(c.cid);
  const ts = Number(c.create_time);
  const user = authorOf(obj(c.user));
  const handle = user.handle;
  if (!id || !Number.isFinite(ts) || ts <= 0 || !user.platform_user_id || !handle) return null;
  const text = str(c.text) ?? "";
  return {
    schema: "canonical-item/v1",
    platform: "tiktok",
    platform_post_id: id,
    content_type: "comment",
    url: parent.authorHandle ? `https://www.tiktok.com/@${parent.authorHandle}/video/${parent.id}` : null,
    text,
    lang_hint: str(c.comment_language)?.slice(0, 2).toLowerCase() ?? null,
    published_at: new Date(ts * 1000).toISOString(),
    parent: {
      platform_post_id: parent.id,
      author: parent.authorId ? { platform_user_id: parent.authorId, handle: parent.authorHandle } : null,
    },
    root_post_id: parent.id,
    author: { ...user, handle, followers: null, following: null },
    metrics: {
      likes: count(c.digg_count),
      comments: count(c.reply_comment_total),
      shares: null,
      views: null,
      quotes: null,
      saves: null,
      captured_at: meta.fetchedAt,
    },
    hashtags: [...new Set([...text.matchAll(/#([\p{L}\p{N}_]{2,100})/gu)].map((m) => m[1]!.toLowerCase()))],
    mentions: [],
    media: [],
    geo: { lat: null, lng: null, place_name: null },
    is_ad: null,
    extra: {},
    provenance: { connector_key: KEY, connector_version: VERSION, fetched_at: meta.fetchedAt, raw_ref: meta.rawRef },
  };
}

function classify(status: number, body: string): ConnectorError {
  const msg = `HTTP ${status}${body ? ` ${body.slice(0, 120).replace(/\s+/g, " ")}` : ""}`;
  if (status === 401 || status === 403)
    return new ConnectorError("AUTH_INVALID", `access key ditolak — ${msg}`, { httpStatus: status, scope: "account" });
  if (status === 402)
    return new ConnectorError("QUOTA_EXHAUSTED", `saldo LamaTok habis — ${msg}`, { httpStatus: status, scope: "account" });
  if (status === 429) return new ConnectorError("RATE_LIMITED", msg, { httpStatus: status, scope: "account" });
  if (status === 400 || status === 422) return new ConnectorError("INVALID_QUERY", msg, { httpStatus: status, scope: "request" });
  if (status >= 500) return new ConnectorError("UPSTREAM_5XX", msg, { httpStatus: status });
  return new ConnectorError("UNKNOWN", msg, { httpStatus: status });
}

const op = (o: Partial<ConnectorManifest["operations"]["search_keyword"]>) => ({
  queryFeatures: [] as never[],
  maxQueryLength: null,
  supportsSince: false,
  supportsUntil: true,
  supportsCursor: false,
  maxPageSize: 30,
  returnsFields: ["metrics.likes", "metrics.views", "metrics.comments", "author.followers"],
  asyncExecution: false,
  resultOrder: null,
  sinceGranularity: "exact" as const,
  ...o,
});

export class LamatokConnector implements Connector {
  readonly manifest: ConnectorManifest = {
    key: KEY,
    version: VERSION,
    providerKey: "lamatok",
    providerKind: "third_party", // memakai API privat TikTok → risk_level high diset operator (scripts/live-routing.ts)
    platform: "tiktok",
    runtime: "bun",
    displayName: "TikTok via LamaTok (keyword, akun, komentar)",
    credentialKinds: ["api_key"],
    configSchema: LAMATOK_CONFIG_SCHEMA,
    operations: {
      // pencarian tak terurut ketat; post lama ≤ 30 hari ikut (sudah dibayar) → supportsSince false (contract suite)
      search_keyword: op({ queryFeatures: ["term", "phrase", "or"] as never[], maxQueryLength: 500 }),
      user_timeline: op({ resultOrder: "desc", maxPageSize: 30 }),
      post_comments: op({ maxPageSize: 50, returnsFields: ["metrics.likes"] }),
    },
    costModel: { unit: "request", reportsUsageInResponse: false },
    docsUrl: "https://api.lamatok.com/docs",
    allowedHosts: LAMATOK_HOSTS,
  };

  private async call(ctx: ConnectorContext, path: string, params: Record<string, string | number | undefined>): Promise<Obj> {
    const key = ctx.credential.secret.api_key ?? ctx.credential.secret.api_token;
    if (!key) throw new ConnectorError("AUTH_INVALID", "credential LamaTok tanpa api_key", { scope: "account" });
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
    const res = await ctx.http.request(`${LAMATOK_API}${path}${qs.size ? `?${qs}` : ""}`, {
      signal: ctx.signal,
      headers: { "x-access-key": key, accept: "application/json" },
      throwOnStatus: false,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = classify(res.status, body);
      if (err.code === "RATE_LIMITED")
        ctx.reportRateLimit({
          remaining: 0,
          resetAt: null,
          retryAfterMs: parseRetryAfter(res.headers.get("retry-after")) ?? null,
          scope: "provider_account",
        });
      throw err;
    }
    try {
      return obj(await res.json());
    } catch (e) {
      throw new ConnectorError("PARSE_ERROR", "respons LamaTok bukan JSON", { cause: e, httpStatus: res.status });
    }
  }

  async fetch(req: FetchRequest, ctx: ConnectorContext): Promise<FetchResult> {
    if (ctx.signal.aborted) throw new ConnectorError("TIMEOUT", "deadline sudah lewat");
    const cfg = ctx.config as LamatokConfig;
    const sinceMs = req.window?.since ? Date.parse(req.window.since) : null;
    const untilMs = req.window?.until ? Date.parse(req.window.until) : null;
    const raw: Obj[] = [];
    const comments: { c: Obj; parent: { id: string; authorId: string | null; authorHandle: string | null } }[] = [];
    let requests = 0;
    let returned = 0;
    const isNewEnough = (v: Obj) => sinceMs === null || Number(v.create_time) * 1000 >= sinceMs;

    if (req.operation === "search_keyword") {
      const kws = keywordsOf(req.query?.native ?? "").slice(0, cfg.maxKeywords ?? 3);
      if (!kws.length) throw new ConnectorError("INVALID_QUERY", "query kosong", { scope: "request" });
      const maxPages = cfg.maxSearchPages ?? Math.min(5, Math.max(1, req.pageLimit));
      for (const kw of kws) {
        let page: string | undefined;
        for (let p = 0; p < maxPages; p++) {
          const body = await this.call(ctx, "/v2/search", { keyword: kw, count: 30, page_id: page });
          requests++;
          const vs = collectVideos(body);
          returned += vs.length;
          raw.push(...vs);
          page = str(body.next_page_id) ?? undefined;
          // tak terurut ketat: berhenti bila halaman ini tidak berisi satu pun video dalam window
          if (!vs.length || !page || body.has_more === false || !vs.some(isNewEnough)) break;
        }
      }
    } else if (req.operation === "user_timeline") {
      const handles = (req.targetIds ?? []).map((h) => h.replace(/^@/, "").trim()).filter(Boolean);
      if (!handles.length) throw new ConnectorError("INVALID_QUERY", "user_timeline butuh targetIds (username)", { scope: "request" });
      for (const h of handles.slice(0, 20)) {
        const info = await this.call(ctx, "/v1/user/by/username", { username: h });
        requests++;
        const secUid = findKey(info, ["secUid", "sec_uid"]);
        if (!secUid) continue; // akun tidak ditemukan / privat
        let cursor: string | undefined;
        for (let p = 0; p < Math.min(5, Math.max(1, req.pageLimit)); p++) {
          const body = await this.call(ctx, "/v2/user/medias/by/secUid", { secUid, count: 30, max_cursor: cursor });
          requests++;
          const vs = collectVideos(body);
          returned += vs.length;
          raw.push(...vs);
          cursor = str(body.max_cursor) ?? undefined;
          // terbaru dulu (selain video sematan) → berhenti saat semua video halaman ini lebih lama dari window
          if (!vs.length || !cursor || body.has_more === false || !vs.some(isNewEnough)) break;
        }
      }
    } else if (req.operation === "post_comments") {
      const ids = (req.targetIds ?? []).filter((x) => /^\d{5,25}$/.test(x)).slice(0, 50);
      if (!ids.length) throw new ConnectorError("INVALID_QUERY", "post_comments butuh targetIds (id video)", { scope: "request" });
      for (const id of ids) {
        let cursor = 0;
        for (let p = 0; p < (cfg.maxCommentPages ?? 2); p++) {
          const body = await this.call(ctx, "/v2/media/comments/by/id", { id, count: 50, cursor });
          requests++;
          const cs = arr(body.comments).map(obj);
          returned += cs.length;
          for (const c of cs) comments.push({ c, parent: { id, authorId: null, authorHandle: null } });
          cursor = Number(body.cursor ?? 0);
          if (!cs.length || !body.has_more || !cursor) break;
        }
      }
    } else {
      throw new ConnectorError("NOT_SUPPORTED", `operation ${req.operation} tidak didukung`, { scope: "connector" });
    }

    const fetchedAt = new Date().toISOString();
    const rawRef =
      raw.length || comments.length
        ? await ctx.archiveRaw(raw.length ? raw : comments.map((x) => x.c), {
            platform: "tiktok",
            crawlRunId: req.idempotencyKey,
            attemptNo: 1,
            page: 1,
          })
        : null;
    const items: CanonicalItem[] = [];
    const seen = new Set<string>();
    let dropped = 0;
    const now = Date.now();
    const keep = (it: CanonicalItem | null) => {
      if (!it) {
        dropped++;
        return;
      }
      const t = Date.parse(it.published_at);
      if (seen.has(it.platform_post_id) || (untilMs !== null && t > untilMs) || now - t > KEEP_OLD_MS) return;
      seen.add(it.platform_post_id);
      items.push(it);
    };
    for (const v of raw) keep(normalizeVideo(v, { fetchedAt, rawRef }));
    for (const x of comments) keep(normalizeComment(x.c, x.parent, { fetchedAt, rawRef }));
    return {
      items,
      nextCursor: null,
      hasMore: false,
      rawRefs: rawRef ? [rawRef] : [],
      usage: {
        requests,
        results: returned,
        costUnits: typeof cfg.usdPerRequest === "number" ? Math.round(requests * cfg.usdPerRequest * 1e6) / 1e6 : null,
        costUnitLabel: typeof cfg.usdPerRequest === "number" ? "usd" : null,
      },
      upstream: { httpStatuses: [200], requestIds: [] },
      warnings: dropped ? [{ code: "ITEMS_DROPPED", message: `${dropped} item dibuang (normalisasi)` }] : [],
    };
  }

  async healthProbe(ctx: ConnectorContext): Promise<HealthProbeResult> {
    const t0 = performance.now();
    try {
      if (ctx.signal.aborted) return { ok: false, latencyMs: 0, errorCode: "TIMEOUT" };
      const b = await this.call(ctx, "/sys/balance", {});
      return { ok: true, latencyMs: Math.round(performance.now() - t0), details: { requests_left: b.requests ?? null } };
    } catch (e) {
      return { ok: false, latencyMs: Math.round(performance.now() - t0), errorCode: e instanceof ConnectorError ? e.code : "UNKNOWN" };
    }
  }
}

/** Nilai string pertama untuk salah satu kunci di struktur bersarang (mis. secUid di respons profil). */
function findKey(body: unknown, keys: string[]): string | null {
  if (Array.isArray(body)) {
    for (const v of body) {
      const r = findKey(v, keys);
      if (r) return r;
    }
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const o = body as Obj;
  for (const k of keys) if (str(o[k])) return str(o[k]);
  for (const v of Object.values(o)) {
    const r = findKey(v, keys);
    if (r) return r;
  }
  return null;
}

export const allowedHosts = LAMATOK_HOSTS;
