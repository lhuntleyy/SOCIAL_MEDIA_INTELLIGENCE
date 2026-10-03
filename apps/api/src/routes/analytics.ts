// D-01/D-02 (API_SPEC §5): analitik & feed per topik. Topik diverifikasi milik tenant (Postgres RLS, withTenant) SEBELUM
// ClickHouse ditanya; query ClickHouse selalu memfilter tenant_id dari token (SEC-01). Parameter umum §1.4.
import type { ClickHouseClient } from "@clickhouse/client";
import * as A from "@smip/analytics";
import type { TenantId } from "@smip/core";
import { type Db, jsonbValue, withSystem, withTenant } from "@smip/db";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { ApiError } from "../errors";
import { type Cell, toCsv, toXlsx } from "../exports/files";
import { requireRole } from "../middleware/auth";
import { parseJson } from "../validate";
import { requireScope } from "./topics";

const Common = z.object({
  topic_id: z.uuid(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  platforms: z.string().max(200).optional(),
  granularity: z.enum(["1h", "1d"]).optional(),
  mode: z.enum(["count", "engagement"]).optional(),
  sentiment: z.enum(["negative", "neutral", "positive"]).optional(),
  emotion: z.enum(["anger", "anticipation", "disgust", "trust", "joy", "sadness", "surprise", "fear", "unknown"]).optional(),
  by: z.enum(["posts", "engagement", "replies", "reposts"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(10_000).optional(),
  // drill-down (klik widget → post di baliknya)
  hashtag: z.string().trim().min(1).max(140).optional(),
  issue: z.string().trim().min(1).max(200).optional(),
  author_id: z.string().min(1).max(200).optional(),
  region: z
    .string()
    .regex(/^[A-Z0-9._-]{1,20}$/i)
    .optional(),
  content_type: z.enum(["post", "reply", "repost", "quote", "comment", "replies", "reposts"]).optional(),
  sort: z.enum(["latest", "engagement"]).optional(),
  count: z.enum(["0", "1"]).optional(),
  media_type: z.enum(["image", "video"]).optional(),
});

/** Redis cache (subset perintah) — H-01: respons analitik dicache per versi data topik. */
export interface AnalyticsCache {
  send(cmd: string, args: string[]): Promise<unknown>;
}
export const topicVersionKey = (tenantId: string, topicId: string) => `rt:ver:${tenantId}:${topicId}`;
/** Data topik berubah (sink / koreksi sentimen) → versi naik → cache lama tidak terpakai lagi. */
export async function bumpTopicVersion(cache: AnalyticsCache | undefined, tenantId: string, topicId: string) {
  if (!cache) return;
  try {
    const k = topicVersionKey(tenantId, topicId);
    await cache.send("INCR", [k]);
    await cache.send("EXPIRE", [k, String(7 * 86_400)]);
  } catch {
    /* cache tidak tersedia → TTL yang membatasi basi */
  }
}
const CACHE_TTL_SEC = 300;

export function analyticsRoutes(d: { db: Db; ch: ClickHouseClient; cache?: AnalyticsCache }) {
  const r = new Hono<AppEnv>();
  /**
   * H-01 cache respons (load test: ClickHouse jenuh ± 80 req/dtk di server 2 CPU). Kunci = kantor + topik + VERSI data topik +
   * URL lengkap → viewer berbeda yang membuka topik/rentang sama (anchor `to` dibulatkan 5 menit di web) dilayani satu query;
   * versi naik saat data baru masuk / dikoreksi sehingga hasil tidak basi; TTL 5 menit sebagai batas atas. Gagal cache → hitung langsung.
   */
  const cached = async <T>(url: string, tid: string, topic: string, compute: () => Promise<T>): Promise<T> => {
    if (!d.cache) return compute();
    let key = "";
    try {
      const ver = ((await d.cache.send("GET", [topicVersionKey(tid, topic)])) as string | null) ?? "0";
      const u = new URL(url);
      key = `ac:${tid}:${topic}:${ver}:${new Bun.CryptoHasher("sha1").update(u.pathname + u.search).digest("hex")}`;
      const hit = (await d.cache.send("GET", [key])) as string | null;
      if (hit) return JSON.parse(hit) as T;
    } catch {
      return compute();
    }
    const v = await compute();
    d.cache.send("SET", [key, JSON.stringify(v), "EX", String(CACHE_TTL_SEC)]).catch(() => {});
    return v;
  };
  const read = requireScope("analytics:read");
  const filter = async (c: { req: { query: () => Record<string, string> }; get: (k: "auth") => { tid: string } }) => {
    const p = Common.safeParse(c.req.query());
    if (!p.success)
      throw new ApiError(
        "VALIDATION_FAILED",
        "Parameter tidak valid",
        p.error.issues.map((i) => ({ path: i.path.join("."), issue: i.message })),
      );
    const to = p.data.to ? new Date(p.data.to) : new Date();
    const from = p.data.from ? new Date(p.data.from) : new Date(to.getTime() - 7 * 86_400_000);
    if (from >= to || to.getTime() - from.getTime() > 400 * 86_400_000)
      throw new ApiError("VALIDATION_FAILED", "Rentang waktu tidak valid (maks 400 hari)", [{ path: "from", issue: "rentang" }]);
    const tid = c.get("auth").tid;
    const ok = await withTenant(d.db, tid as TenantId, (tx) =>
      tx.execute(sql`select 1 from topics where id = ${p.data.topic_id} and deleted_at is null`),
    );
    if (!(ok as unknown as unknown[]).length) throw new ApiError("NOT_FOUND", "Topik tidak ditemukan");
    const f: A.AnalyticsFilter = {
      tenantId: tid,
      topicId: p.data.topic_id,
      from,
      to,
      ...(p.data.platforms ? { platforms: p.data.platforms.split(",").filter((x) => /^[a-z][a-z0-9_]{0,31}$/.test(x)) } : {}),
    };
    return { f, q: p.data };
  };
  const meta = (c: { get: (k: "requestId") => string }) => ({ request_id: c.get("requestId") });
  const route = (path: string, fn: (x: Awaited<ReturnType<typeof filter>>) => Promise<unknown>) =>
    r.get(path, read, async (c) => {
      const x = await filter(c);
      return c.json({ data: await cached(c.req.url, x.f.tenantId, x.f.topicId, () => fn(x)), meta: meta(c) });
    });

  route("/analytics/summary", ({ f }) => A.summary(d.ch, f));
  // U-04 galeri: post bermedia (foto/video) untuk filter yang sama dengan feed
  route("/analytics/gallery", ({ f, q }) =>
    A.gallery(d.ch, f, {
      sentiment: q.sentiment,
      emotion: q.emotion,
      hashtag: q.hashtag,
      issue: q.issue,
      authorId: q.author_id,
      contentType: q.content_type,
      sort: q.sort,
      mediaType: q.media_type,
      limit: Math.min(q.limit ?? 48, 60),
      offset: q.offset ?? 0,
    }),
  );
  route("/analytics/exposure", ({ f, q }) => A.exposure(d.ch, f, q.granularity ?? A.autoGranularity(f), q.mode));
  route("/analytics/emotion/timeline", ({ f, q }) => A.emotionTimeline(d.ch, f, q.granularity ?? A.autoGranularity(f)));
  route("/analytics/accounts/active", ({ f }) => A.activeAccounts(d.ch, f));
  route("/analytics/accounts/reposted", ({ f, q }) => A.repostedAccounts(d.ch, f, q.limit ?? 10));
  route("/analytics/platforms", ({ f }) => A.platformBreakdown(d.ch, f));
  route("/analytics/activity", ({ f }) => A.activityHeatmap(d.ch, f));
  route("/analytics/accounts/created-year", ({ f }) => A.authorCreatedYear(d.ch, f));
  route("/analytics/sentiment/timeline", ({ f, q }) => A.sentimentTimeline(d.ch, f, q.mode, q.granularity ?? A.autoGranularity(f)));
  route("/analytics/sentiment/proportion", ({ f, q }) => A.sentimentProportion(d.ch, f, q.mode));
  route("/analytics/emotion/proportion", ({ f, q }) => A.emotionProportion(d.ch, f, q.mode));
  route("/analytics/psychography", ({ f }) => A.psychography(d.ch, f));
  route("/analytics/issues", ({ f, q }) => A.issues(d.ch, f, q.limit ?? 40, q.mode, q.sentiment));
  route("/analytics/hashtags", ({ f, q }) => A.hashtags(d.ch, f, q.limit ?? 30, q.sentiment));
  route("/analytics/accounts/top", ({ f, q }) => A.topAccounts(d.ch, f, q.by, q.limit ?? 10, q.sentiment));
  let regions: { at: number; names: Map<string, string> } | null = null;
  route("/analytics/locations", async ({ f }) => {
    if (!regions || Date.now() - regions.at > 600_000) {
      const rows = (await withSystem(d.db, (tx) => tx.execute(sql`select code, name from geo_regions`))) as unknown as {
        code: string;
        name: string;
      }[];
      regions = { at: Date.now(), names: new Map(rows.map((r) => [r.code, r.name])) };
    }
    const r = await A.locations(d.ch, f);
    return { ...r, items: r.items.map((x) => ({ ...x, name: regions!.names.get(x.code) ?? x.code })) };
  });
  r.get("/posts", read, async (c) => {
    const { f, q } = await filter(c);
    const o: A.FeedOptions = {
      sentiment: q.sentiment,
      emotion: q.emotion,
      hashtag: q.hashtag,
      issue: q.issue,
      authorId: q.author_id,
      region: q.region,
      contentType: q.content_type,
      sort: q.sort,
      limit: q.limit ?? 20,
      offset: q.offset ?? 0,
    };
    const [items, total] = await cached(c.req.url, f.tenantId, f.topicId, () =>
      Promise.all([A.feed(d.ch, f, o), q.count === "1" ? A.feedCount(d.ch, f, o) : undefined]),
    );
    return c.json({ data: items, meta: { ...meta(c), ...(total !== undefined ? { total } : {}) } });
  });
  // O-06 export CSV/XLSX (API_SPEC §8): post untuk filter yang sama dengan feed, langsung diunduh (maks. EXPORT_MAX_ROWS, terbaru
  // dulu; X-SMIP-Truncated bila terpotong). Dicatat di tabel exports + audit. Tanpa demografi individu (SEC-09).
  r.get("/exports/posts", requireRole("analyst"), requireScope("exports:write"), async (c) => {
    const fmt = z.enum(["csv", "xlsx"]).catch("xlsx").parse(c.req.query("format"));
    const { f, q } = await filter(c);
    const o = {
      sentiment: q.sentiment,
      emotion: q.emotion,
      hashtag: q.hashtag,
      issue: q.issue,
      authorId: q.author_id,
      region: q.region,
      contentType: q.content_type,
    };
    const rows = await A.exportRows(d.ch, f, o, A.EXPORT_MAX_ROWS + 1);
    const truncated = rows.length > A.EXPORT_MAX_ROWS;
    const data = rows.slice(0, A.EXPORT_MAX_ROWS);
    const SENT: Record<string, string> = { negative: "Negatif", neutral: "Netral", positive: "Positif" };
    const EMO: Record<string, string> = {
      anger: "Marah",
      anticipation: "Antisipasi",
      disgust: "Jijik",
      trust: "Percaya",
      joy: "Senang",
      sadness: "Sedih",
      surprise: "Terkejut",
      fear: "Takut",
      unknown: "Tidak jelas",
    };
    const wib = (s: string) =>
      new Date(`${s.replace(" ", "T")}Z`).toLocaleString("sv-SE", { timeZone: "Asia/Jakarta", hour12: false }).slice(0, 16);
    const num = (v: string | null) => (v === null || v === undefined ? null : Number(v));
    const header = [
      "Waktu (WIB)",
      "Platform",
      "Jenis",
      "Akun",
      "Nama",
      "Pengikut",
      "Teks",
      "URL",
      "Suka",
      "Komentar",
      "Bagikan",
      "Tayang",
      "Engagement",
      "Sentimen",
      "Emosi",
      "Isu",
      "Hashtag",
    ];
    const body: Cell[][] = data.map((x) => [
      wib(x.published_at),
      x.platform,
      x.content_type,
      x.author_handle,
      x.author_name,
      num(x.author_followers),
      x.text,
      x.url,
      num(x.likes),
      num(x.comments),
      num(x.shares),
      num(x.views),
      x.engagement_known ? Number(x.engagement) : null,
      SENT[x.sentiment] ?? x.sentiment,
      EMO[x.emotion] ?? x.emotion,
      (x.issues ?? []).join("; "),
      (x.hashtags ?? []).map((h) => `#${h}`).join(" "),
    ]);
    const [topic] = (await withSystem(d.db, (tx) => tx.execute(sql`select name from topics where id = ${f.topicId}`))) as unknown as {
      name: string;
    }[];
    const a = c.get("auth") as { sub: string; tid: string };
    const exportId = Bun.randomUUIDv7();
    await withSystem(d.db, async (tx) => {
      await tx.execute(sql`insert into exports (id, tenant_id, requested_by, kind, params, status, row_count)
        values (${exportId}, ${f.tenantId}, ${a.sub}, ${fmt}::e_export_kind, ${jsonbValue({ topic_id: f.topicId, from: f.from.toISOString(), to: f.to.toISOString(), platforms: f.platforms ?? null, ...o, truncated })},
                'done', ${data.length})`);
      await tx.execute(sql`insert into audit_logs (id, tenant_id, actor_type, actor_id, action, target_type, target_id, after, request_id)
        values (${Bun.randomUUIDv7()}, ${f.tenantId}, 'user', ${a.sub}, 'export.download', 'topic', ${f.topicId},
                ${jsonbValue({ export_id: exportId, format: fmt, rows: data.length, truncated })}, ${c.get("requestId") as string})`);
    });
    const slug =
      (topic?.name ?? "topik")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40) || "topik";
    const file = `smip-${slug}-${f.from.toISOString().slice(0, 10)}_${f.to.toISOString().slice(0, 10)}.${fmt}`;
    const bytes =
      fmt === "csv"
        ? toCsv(header, body)
        : toXlsx(topic?.name ?? "Data", header, body, [17, 10, 9, 18, 18, 10, 60, 30, 8, 9, 8, 9, 11, 9, 10, 30, 24]);
    return new Response(bytes, {
      headers: {
        "content-type": fmt === "csv" ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${file}"`,
        "x-smip-rows": String(data.length),
        "x-smip-truncated": String(truncated),
        "cache-control": "no-store",
      },
    });
  });
  // A-05 (API_SPEC §6): koreksi sentimen manual → −1/+1 di ClickHouse + sentiment_overrides (dataset training) + audit
  r.patch("/posts/:platform/:post_id/sentiment", requireRole("analyst"), requireScope("posts:write"), async (c) => {
    const platform = c.req.param("platform");
    const postId = c.req.param("post_id");
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(platform) || postId.length > 200) throw new ApiError("NOT_FOUND", "Post tidak ditemukan");
    const b = await parseJson(
      c,
      z.strictObject({
        topic_id: z.uuid(),
        label: z.enum(["negative", "neutral", "positive"]),
        reason: z.string().trim().max(500).optional(),
      }),
    );
    const auth = c.get("auth") as { tid: string; sub: string };
    const tid = auth.tid as TenantId;
    const ok = await withTenant(d.db, tid, (tx) => tx.execute(sql`select 1 from topics where id = ${b.topic_id} and deleted_at is null`));
    if (!(ok as unknown as unknown[]).length) throw new ApiError("NOT_FOUND", "Topik tidak ditemukan");
    const overrideId = Bun.randomUUIDv7();
    const r = await A.overrideSentiment(d.ch, {
      tenantId: tid,
      topicId: b.topic_id,
      platform,
      postId,
      label: b.label,
      batchId: overrideId,
    });
    if (!r) throw new ApiError("NOT_FOUND", "Post tidak ditemukan pada topik ini");
    if (r.changed)
      await withTenant(d.db, tid, async (tx) => {
        await tx.execute(sql`insert into sentiment_overrides (id, tenant_id, topic_id, platform, post_id, previous_label, new_label, previous_model_version, user_id, reason)
          values (${overrideId}, ${tid}, ${b.topic_id}, ${platform}, ${postId}, ${r.previous}, ${b.label}, ${r.previousModelVersion}, ${auth.sub}, ${b.reason ?? null})`);
        await tx.execute(sql`insert into audit_logs (id, tenant_id, actor_type, actor_id, action, target_type, target_id, before, after, request_id)
          values (${Bun.randomUUIDv7()}, ${tid}, 'user', ${auth.sub}, 'post.sentiment_override', 'post', ${`${platform}:${postId}`},
            ${jsonbValue({ label: r.previous, model_version: r.previousModelVersion })},
            ${jsonbValue({ label: b.label, topic_id: b.topic_id, reason: b.reason ?? null })}, ${c.get("requestId")})`);
      });
    await bumpTopicVersion(d.cache, tid, b.topic_id); // agregat berubah → cache analitik topik ini kedaluwarsa
    return c.json({
      data: { label: b.label, source: "human", previous: r.previous, override_id: r.changed ? overrideId : null },
      meta: meta(c),
    });
  });
  return r;
}
