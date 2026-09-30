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
});

export function analyticsRoutes(d: { db: Db; ch: ClickHouseClient }) {
  const r = new Hono<AppEnv>();
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
    r.get(path, read, async (c) => c.json({ data: await fn(await filter(c)), meta: meta(c) }));

  route("/analytics/summary", ({ f }) => A.summary(d.ch, f));
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
    const [items, total] = await Promise.all([A.feed(d.ch, f, o), q.count === "1" ? A.feedCount(d.ch, f, o) : undefined]);
    return c.json({ data: items, meta: { ...meta(c), ...(total !== undefined ? { total } : {}) } });
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
    return c.json({
      data: { label: b.label, source: "human", previous: r.previous, override_id: r.changed ? overrideId : null },
      meta: meta(c),
    });
  });
  return r;
}
