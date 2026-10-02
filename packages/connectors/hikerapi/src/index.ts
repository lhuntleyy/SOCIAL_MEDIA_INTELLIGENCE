// Instagram via HikerAPI (SaaS HTTP, pembuat instagrapi) — sumber utama Instagram sejak 2026-10-01 (keputusan pemilik; PROVIDER_MATRIX
// "Uji HikerAPI"). Dua jalur dalam satu run search_keyword:
//   1. hashtag terbaru  GET /v2/hashtag/medias/recent?name=&page_id=  — ±30 post/request, TERBARU DULU → halaman diambil sampai post
//      lebih lama dari window.since (berhenti dini → tidak ada tagihan berulang; inkremental tepat seperti since_time X).
//   2. keyword         GET /gql/topsearch?query=&flat=true           — konten teratas (relevansi, bisa lama) untuk post yang hanya
//      menyebut topik di caption; 1 request/keyword/run. Post lama ≤ 30 hari tetap diteruskan (sudah dibayar; berguna untuk backfill).
// Auth header `x-access-key` (tidak di URL). Harga TIDAK di kode (Golden Rule 1): biaya = requests × connectors.config.usdPerRequest
// (diisi operator dengan sumber, mis. hikerapi.com/pricing). Respons GraphQL memakai awalan key (`1ltaken_at`, `1flat`) → dibaca keduanya.

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

export const HIKER_API = "https://api.instagrapi.com";
export const HIKER_HOSTS = ["api.instagrapi.com", "api.hikerapi.com"];
const KEY = "hikerapi.instagram";
const VERSION = "0.1.0";
/** Batas jalur "post lama tetap disimpan" untuk keyword topsearch (sama dengan kebijakan actor tanpa filter tanggal). */
const KEEP_OLD_MS = 30 * 86_400_000;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length ? v : typeof v === "number" ? String(v) : null);
/** Field biasa atau varian GraphQL ber-awalan tipe (`1l` long, `1f` float). */
const f = (o: Obj, k: string): unknown => o[k] ?? o[`1l${k}`] ?? o[`1f${k}`];

export interface HikerConfig {
  /** USD per request (sumber: halaman harga provider) — dipakai untuk usage.costUnits; tidak diisi → null (biaya tak tercatat). */
  usdPerRequest?: number;
  /** Maks. halaman hashtag per hashtag per run (pengaman; berhenti lebih awal saat melewati window). */
  maxHashtagPages?: number;
  /** Jalankan pencarian keyword /gql/topsearch (default true). */
  keywordSearch?: boolean;
  /** Maks. keyword (cabang OR) yang dicari per run. */
  maxKeywords?: number;
  /** Maks. hashtag yang diambil per run (default 8). */
  maxHashtags?: number;
}

export const HIKER_CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    usdPerRequest: { type: "number", minimum: 0, maximum: 1 },
    maxHashtagPages: { type: "integer", minimum: 1, maximum: 50 },
    keywordSearch: { type: "boolean" },
    maxKeywords: { type: "integer", minimum: 0, maximum: 20 },
    maxHashtags: { type: "integer", minimum: 1, maximum: 32 },
  },
} as const;

/** Cabang OR query native → kata kunci polos (tanpa kutip) & hashtag (frasa digabung, huruf kecil, ≥ 3 karakter). */
export function queryParts(native: string): { keywords: string[]; hashtags: string[] } {
  const keywords: string[] = [];
  const hashtags: string[] = [];
  for (const raw of native.split(/\s+OR\s+/i)) {
    const part = raw
      .replace(/\bNOT\b.*$/i, "")
      .replace(/[()]/g, "")
      .trim();
    if (!part) continue;
    const plain = part.replace(/"/g, "").replace(/^#/, "").trim();
    if (!part.startsWith("#") && plain && !keywords.includes(plain)) keywords.push(plain);
    const tag = plain
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_]+/gu, "");
    if (tag.length >= 3 && !hashtags.includes(tag)) hashtags.push(tag);
  }
  return { keywords, hashtags };
}

/** Semua objek media (punya `code` + `taken_at`) di struktur respons apa pun, unik per code. */
export function collectMedias(body: unknown): Obj[] {
  const out = new Map<string, Obj>();
  const walk = (x: unknown) => {
    if (Array.isArray(x)) {
      for (const v of x) walk(v);
      return;
    }
    if (!x || typeof x !== "object") return;
    const o = x as Obj;
    const code = str(o.code);
    if (code && f(o, "taken_at") !== undefined && !out.has(code)) {
      out.set(code, o);
      return;
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(body);
  return [...out.values()];
}

const HASHTAG = /#([\p{L}\p{N}_]{2,100})/gu;
const MENTION = /@([A-Za-z0-9._]{1,30})/g;

export function normalizeHikerMedia(m: Obj, meta: { fetchedAt: string; rawRef: string | null }): CanonicalItem | null {
  const code = str(m.code);
  const ts = Number(f(m, "taken_at"));
  const user = obj(m.user);
  const handle = str(user.username);
  const userId = str(user.pk) ?? str(user.id) ?? handle;
  if (!code || !Number.isFinite(ts) || ts <= 0 || !handle || !userId) return null;
  const text = str(obj(m.caption).text) ?? "";
  const isVideo = Number(m.media_type) === 2;
  const img = str(obj(((obj(m.image_versions2).candidates as unknown[]) ?? [])[0]).url);
  const vid = str(obj(((m.video_versions as unknown[]) ?? [])[0]).url);
  const loc = obj(m.location);
  const lat = Number(f(loc, "lat"));
  const lng = Number(f(loc, "lng"));
  const paid = m.is_paid_partnership;
  return {
    schema: "canonical-item/v1",
    platform: "instagram",
    platform_post_id: code, // shortcode — sama dengan connector Apify (dedupe lintas provider)
    content_type: "post",
    url: `https://www.instagram.com/p/${code}/`,
    text,
    lang_hint: null,
    published_at: new Date(ts * 1000).toISOString(),
    parent: null,
    root_post_id: null,
    author: {
      platform_user_id: userId,
      handle,
      display_name: str(user.full_name),
      followers: null, // tidak ada di feed hashtag/topsearch (butuh request profil terpisah)
      following: null,
      verified: typeof user.is_verified === "boolean" ? user.is_verified : null,
      created_at: null,
      location_raw: null,
      avatar_url: null,
    },
    metrics: {
      likes: count(m.like_count),
      comments: count(m.comment_count),
      shares: null,
      views: count(m.play_count ?? m.view_count),
      quotes: null,
      saves: null,
      captured_at: meta.fetchedAt,
    },
    hashtags: [...new Set([...text.matchAll(HASHTAG)].map((x) => x[1]!.toLowerCase()))],
    mentions: [...new Set([...text.matchAll(MENTION)].map((x) => x[1]!.toLowerCase()))],
    media: (isVideo ? vid : img) ? [{ type: isVideo ? "video" : "image", url: (isVideo ? vid : img)!, thumb: img }] : [],
    geo: {
      lat: Number.isFinite(lat) && lat >= -90 && lat <= 90 && f(loc, "lat") !== undefined ? lat : null,
      lng: Number.isFinite(lng) && lng >= -180 && lng <= 180 && f(loc, "lng") !== undefined ? lng : null,
      place_name: str(loc.name),
    },
    // kemitraan berbayar = konten bersponsor (sinyal iklan seperti Threads isPaidPartnership); tak ada field → null
    is_ad: typeof paid === "boolean" ? paid : null,
    extra: {},
    provenance: { connector_key: KEY, connector_version: VERSION, fetched_at: meta.fetchedAt, raw_ref: meta.rawRef },
  };
}

function classify(status: number, body: string): ConnectorError {
  const msg = `HTTP ${status}${body ? ` ${body.slice(0, 120).replace(/\s+/g, " ")}` : ""}`;
  if (status === 401 || status === 403)
    return new ConnectorError("AUTH_INVALID", `access key ditolak — ${msg}`, { httpStatus: status, scope: "account" });
  if (status === 402)
    return new ConnectorError("QUOTA_EXHAUSTED", `saldo HikerAPI habis — ${msg}`, { httpStatus: status, scope: "account" });
  if (status === 429) return new ConnectorError("RATE_LIMITED", msg, { httpStatus: status, scope: "account" });
  if (status === 400 || status === 422) return new ConnectorError("INVALID_QUERY", msg, { httpStatus: status, scope: "request" });
  if (status >= 500) return new ConnectorError("UPSTREAM_5XX", msg, { httpStatus: status });
  return new ConnectorError("UNKNOWN", msg, { httpStatus: status });
}

export class HikerApiConnector implements Connector {
  readonly manifest: ConnectorManifest = {
    key: KEY,
    version: VERSION,
    providerKey: "hikerapi",
    providerKind: "third_party", // memakai API privat Instagram → risk_level high diset operator (scripts/live-routing.ts)
    platform: "instagram",
    runtime: "bun",
    displayName: "Instagram via HikerAPI (hashtag terbaru + keyword topsearch)",
    credentialKinds: ["api_key"],
    configSchema: HIKER_CONFIG_SCHEMA,
    operations: {
      search_keyword: {
        queryFeatures: ["term", "phrase", "or"],
        maxQueryLength: 500,
        // topsearch (keyword) tidak bisa difilter waktu → post lama ≤ 30 hari ikut (seperti actor IG hashtag Apify); jalur hashtag
        // tetap berhenti di window.since
        supportsSince: false,
        supportsUntil: true,
        supportsCursor: false,
        maxPageSize: 30,
        // like/komentar hanya ±69% (verify live 2026-10-01: Instagram menyembunyikan jumlah like sebagian post → null) → tidak diklaim
        returnsFields: [],
        asyncExecution: false,
        // hashtag terbaru-dulu + topsearch relevansi digabung → tak terurut untuk celah partial (seluruh window)
        resultOrder: null,
        sinceGranularity: "exact", // berhenti per taken_at (detik) → tanpa tagihan berulang
      },
      // pantau akun (menu Akun): post terbaru akun lewat grid profil
      user_timeline: {
        queryFeatures: [],
        maxQueryLength: null,
        supportsSince: false,
        supportsUntil: true,
        supportsCursor: false,
        maxPageSize: 12,
        returnsFields: [],
        asyncExecution: false,
        resultOrder: "desc",
        sinceGranularity: "exact",
      },
    },
    costModel: { unit: "request", reportsUsageInResponse: false },
    docsUrl: "https://api.instagrapi.com/docs",
    allowedHosts: HIKER_HOSTS,
  };

  private async call(ctx: ConnectorContext, path: string, params: Record<string, string | undefined>): Promise<unknown> {
    const key = ctx.credential.secret.api_key ?? ctx.credential.secret.api_token;
    if (!key) throw new ConnectorError("AUTH_INVALID", "credential HikerAPI tanpa api_key", { scope: "account" });
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, v);
    const res = await ctx.http.request(`${HIKER_API}${path}${qs.size ? `?${qs}` : ""}`, {
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
      return await res.json();
    } catch (e) {
      throw new ConnectorError("PARSE_ERROR", "respons HikerAPI bukan JSON", { cause: e, httpStatus: res.status });
    }
  }

  async fetch(req: FetchRequest, ctx: ConnectorContext): Promise<FetchResult> {
    if (ctx.signal.aborted) throw new ConnectorError("TIMEOUT", "deadline sudah lewat");
    if (req.operation !== "search_keyword" && req.operation !== "user_timeline")
      throw new ConnectorError("NOT_SUPPORTED", `operation ${req.operation} tidak didukung`, { scope: "connector" });
    const cfg = ctx.config as HikerConfig;
    const timeline = req.operation === "user_timeline";
    const handles = timeline ? (req.targetIds ?? []).map((h) => h.replace(/^@/, "").trim()).filter(Boolean) : [];
    if (timeline && !handles.length)
      throw new ConnectorError("INVALID_QUERY", "user_timeline butuh targetIds (username)", { scope: "request" });
    const { keywords, hashtags } = timeline ? { keywords: [], hashtags: [] } : queryParts(req.query?.native ?? "");
    if (!timeline && !hashtags.length && !keywords.length) throw new ConnectorError("INVALID_QUERY", "query kosong", { scope: "request" });
    const sinceMs = req.window?.since ? Date.parse(req.window.since) : null;
    const untilMs = req.window?.until ? Date.parse(req.window.until) : null;
    const maxPages = cfg.maxHashtagPages ?? Math.max(req.pageLimit, Math.ceil(req.maxItems / 30));
    const raw: Obj[] = [];
    let requests = 0;
    let returned = 0;
    const warnings: FetchResult["warnings"] = [];

    // 0) pantau akun (menu Akun): username → user_id → post terbaru (grid profil), berhenti saat melewati window.since
    for (const h of handles.slice(0, 20)) {
      let info: unknown;
      try {
        info = await this.call(ctx, "/v1/user/by/username", { username: h });
      } catch (e) {
        if (e instanceof ConnectorError && e.httpStatus === 404) continue; // akun tidak ada / privat
        throw e;
      }
      requests++;
      const uid = str(obj(info).pk) ?? str(obj(info).id);
      if (!uid) continue;
      let cursor: string | undefined;
      for (let p = 0; p < Math.min(5, Math.max(1, req.pageLimit)); p++) {
        const body = obj(await this.call(ctx, "/gql/user/medias", { user_id: uid, profile_grid_items_cursor: cursor, flat: "true" }));
        requests++;
        const ms = collectMedias(body);
        returned += ms.length;
        raw.push(...ms);
        cursor = str(body.end_cursor) ?? str(body.profile_grid_items_cursor) ?? str(body.next_max_id) ?? undefined;
        // post sematan bisa lama di urutan atas → berhenti hanya bila SEMUA post halaman ini lebih lama dari window
        const fresh = ms.some((m) => sinceMs === null || Number(f(m, "taken_at")) * 1000 >= sinceMs);
        if (!ms.length || !cursor || !fresh) break;
      }
    }
    // 1) hashtag terbaru: halaman demi halaman sampai melewati window.since
    // batas jumlah hashtag per run: tiap hashtag ≤ maxPages request berbayar (query OR panjang → biaya berlipat)
    const maxTags = cfg.maxHashtags ?? 8;
    if (hashtags.length > maxTags)
      warnings.push({ code: "HASHTAGS_TRUNCATED", message: `${hashtags.length} hashtag, hanya ${maxTags} pertama yang diambil` });
    for (const tag of hashtags.slice(0, maxTags)) {
      let page: string | undefined;
      for (let p = 0; p < maxPages; p++) {
        let body: unknown;
        try {
          body = await this.call(ctx, "/v2/hashtag/medias/recent", { name: tag, page_id: page });
        } catch (e) {
          // hashtag tak dikenal Instagram → lewati hashtag itu saja
          if (e instanceof ConnectorError && e.httpStatus === 404) break;
          throw e;
        }
        requests++;
        const ms = collectMedias(body);
        returned += ms.length;
        raw.push(...ms);
        // post tanpa taken_at diabaikan (Math.min dengan NaN = NaN → paging tak pernah berhenti di window)
        const times = ms.map((m) => Number(f(m, "taken_at")) * 1000).filter(Number.isFinite);
        const oldest = times.length ? Math.min(...times) : Number.NEGATIVE_INFINITY;
        page = str(obj(body).next_page_id) ?? undefined;
        if (!ms.length || !page || (sinceMs !== null && oldest < sinceMs)) break;
      }
    }
    // 2) keyword topsearch (relevansi): 1 halaman per keyword
    if (cfg.keywordSearch !== false && !timeline)
      for (const kw of keywords.slice(0, cfg.maxKeywords ?? 3)) {
        const body = await this.call(ctx, "/gql/topsearch", { query: kw, flat: "true" });
        requests++;
        const ms = collectMedias(body);
        returned += ms.length;
        raw.push(...ms);
      }

    const fetchedAt = new Date().toISOString();
    const rawRef = raw.length
      ? await ctx.archiveRaw(raw, { platform: "instagram", crawlRunId: req.idempotencyKey, attemptNo: 1, page: 1 })
      : null;
    const seen = new Set<string>();
    const items: CanonicalItem[] = [];
    let dropped = 0;
    const now = Date.now();
    for (const m of raw) {
      const it = normalizeHikerMedia(m, { fetchedAt, rawRef });
      if (!it || seen.has(it.platform_post_id)) {
        if (!it) dropped++;
        continue;
      }
      const t = Date.parse(it.published_at);
      // di luar window: post lebih baru dari until dibuang; post lama ≤ 30 hari tetap diteruskan (sudah dibayar)
      if ((untilMs !== null && t > untilMs) || now - t > KEEP_OLD_MS) continue;
      seen.add(it.platform_post_id);
      items.push(it);
    }
    if (dropped) warnings.push({ code: "ITEMS_DROPPED", message: `${dropped} item dibuang (normalisasi)` });
    return {
      items,
      nextCursor: null,
      hasMore: false,
      rawRefs: rawRef ? [rawRef] : [],
      // usage = yang DIKEMBALIKAN provider (CONNECTOR_SPEC §4a); provider menagih per request
      usage: {
        requests,
        results: returned,
        costUnits: typeof cfg.usdPerRequest === "number" ? Math.round(requests * cfg.usdPerRequest * 1e6) / 1e6 : null,
        costUnitLabel: typeof cfg.usdPerRequest === "number" ? "usd" : null,
      },
      upstream: { httpStatuses: [200], requestIds: [] },
      warnings,
    };
  }

  async healthProbe(ctx: ConnectorContext): Promise<HealthProbeResult> {
    // probe gratis: saldo akun (tidak memotong kuota request)
    const t0 = performance.now();
    try {
      if (ctx.signal.aborted) return { ok: false, latencyMs: 0, errorCode: "TIMEOUT" };
      const b = obj(await this.call(ctx, "/sys/balance", {}));
      return { ok: true, latencyMs: Math.round(performance.now() - t0), details: { requests_left: b.requests ?? null } };
    } catch (e) {
      return { ok: false, latencyMs: Math.round(performance.now() - t0), errorCode: e instanceof ConnectorError ? e.code : "UNKNOWN" };
    }
  }
}

export const allowedHosts = HIKER_HOSTS;
