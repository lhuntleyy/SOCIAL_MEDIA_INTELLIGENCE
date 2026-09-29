// API_SPEC §4 Topics (+ backfill & riwayat run, I-12).
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { AppEnv } from "../context";
import { ApiError } from "../errors";
import { requireRole } from "../middleware/auth";
import type { Actor, TopicService } from "../topics/service";
import { parseJson } from "../validate";

const Id = z.uuid();
const Interval = z.union([z.literal(300), z.literal(900), z.literal(1800), z.literal(2700), z.literal(3600)]);
const Lang = z.enum(["id", "en", "ms"]);
const Operation = z.enum(["search_keyword", "search_hashtag", "user_timeline", "post_detail", "post_comments", "profile"]);
const PlatformCode = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const Str = (max: number) => z.string().trim().max(max);

const QueryZ = z.strictObject({
  id: Id.optional(),
  kind: z.enum(["main", "sub"]),
  label: Str(120).nullish(),
  query_text: z.string().max(2000).nullish(),
  keywords: z.array(Str(100)).max(50).optional(),
  languages: z.array(Lang).max(3).nullish(),
  media_tags: z.array(Str(100)).max(50).optional(),
  not_media_tags: z.array(Str(100)).max(50).optional(),
  platforms: z.array(PlatformCode).max(20).nullish(),
  enabled: z.boolean().optional(),
});
const PlatformZ = z.strictObject({
  code: PlatformCode,
  interval_sec: Interval.optional(),
  operations: z.array(Operation).min(1).max(6).optional(),
  enabled: z.boolean().optional(),
});
const TopicZ = z.strictObject({
  name: Str(200).min(2),
  description: Str(2000).nullish(),
  platforms: z.array(PlatformZ).min(1).max(20),
  taxonomy_type: z.enum(["interest", "industry"]).optional(),
  taxonomy_ids: z.array(Id).max(50).optional(),
  filter_ads: z.boolean().optional(),
  language_hints: z.array(Lang).min(1).max(3).optional(),
  default_interval_sec: Interval.optional(),
  queries: z.array(QueryZ).min(1).max(20),
});
const PatchZ = TopicZ.partial();
const EstimateZ = z.strictObject({
  platforms: z.array(PlatformZ).min(1).max(20),
  queries: z.array(QueryZ).min(1).max(20),
  default_interval_sec: Interval.optional(),
});
const PreviewZ = z.strictObject({ platforms: z.array(PlatformCode).min(1).max(20), queries: z.array(QueryZ).min(1).max(20) });
const ListQ = z.object({
  search: z.string().max(100).optional(),
  status: z.enum(["active", "paused", "archived"]).optional(),
  type: z.enum(["interest", "industry"]).optional(),
  sort: z.enum(["name:asc", "name:desc", "created_at:asc", "created_at:desc", "updated_at:desc"]).default("name:asc"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
});

/** API key hanya boleh memakai rute sesuai scope-nya (SECURITY §2). Token user tidak dibatasi scope. */
export const requireScope = (scope: string) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const a = c.get("auth");
    if (a?.kind === "api_key") {
      const ok = a.scopes?.includes(scope) || (scope.endsWith(":read") && a.scopes?.includes(scope.replace(":read", ":write")));
      if (!ok) throw new ApiError("FORBIDDEN", `API key tidak punya scope ${scope}`);
    }
    await next();
  });

const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
function decodeCursor(c?: string): number {
  if (!c) return 0;
  try {
    const o = JSON.parse(Buffer.from(c, "base64url").toString()).o;
    if (Number.isInteger(o) && o >= 0 && o <= 100_000) return o;
  } catch {}
  throw new ApiError("VALIDATION_FAILED", "Cursor tidak valid", [{ path: "cursor", issue: "tidak valid" }]);
}
function ifMatch(h: string | undefined): number | undefined {
  if (h === undefined) return undefined;
  const m = /^(?:W\/)?"?(\d{1,9})"?$/.exec(h.trim());
  if (!m) throw new ApiError("VALIDATION_FAILED", "If-Match tidak valid", [{ path: "If-Match", issue: 'format "<version>"' }]);
  return Number(m[1]);
}

export function topicRoutes(svc: TopicService) {
  const r = new Hono<AppEnv>();
  const actor = (c: { get: (k: "auth" | "requestId") => unknown; req: { header: (n: string) => string | undefined } }): Actor => {
    const a = c.get("auth") as { sub: string; tid: string };
    return {
      userId: a.sub,
      tenantId: a.tid,
      ip: c.req.header("x-smip-client-ip"),
      ua: c.req.header("user-agent"),
      requestId: c.get("requestId") as string,
    };
  };
  const id = (c: { req: { param: (n: string) => string } }) => {
    const p = Id.safeParse(c.req.param("id"));
    if (!p.success) throw new ApiError("NOT_FOUND", "Topik tidak ditemukan");
    return p.data;
  };
  const read = requireScope("topics:read");
  const write = requireScope("topics:write");
  const meta = (c: { get: (k: "requestId") => string }) => ({ request_id: c.get("requestId") });

  r.get("/topics", read, async (c) => {
    const q = ListQ.safeParse(c.req.query());
    if (!q.success)
      throw new ApiError(
        "VALIDATION_FAILED",
        "Parameter tidak valid",
        q.error.issues.map((i) => ({ path: i.path.join("."), issue: i.message })),
      );
    const offset = decodeCursor(q.data.cursor);
    const { items, total } = await svc.list(actor(c), { ...q.data, offset });
    const next = offset + items.length < total ? encodeCursor(offset + items.length) : null;
    return c.json({ data: items, meta: { ...meta(c), page: { next_cursor: next, limit: q.data.limit, total } } });
  });
  r.get("/platforms", read, async (c) => c.json({ data: await svc.platforms(actor(c)), meta: meta(c) }));
  r.post("/topics/validate-query", requireRole("analyst"), write, async (c) => {
    const b = await parseJson(c, QueryZ.omit({ id: true, kind: true, label: true, enabled: true, platforms: true }));
    return c.json({ data: svc.validateQuery({ ...b, kind: "main" }), meta: meta(c) });
  });
  r.post("/topics/preview", requireRole("analyst"), write, async (c) => {
    const b = await parseJson(c, PreviewZ);
    return c.json({ data: await svc.preview(b), meta: meta(c) });
  });
  r.post("/topics/cost-estimate", requireRole("analyst"), write, async (c) => {
    const b = await parseJson(c, EstimateZ);
    return c.json({ data: await svc.costEstimate(actor(c), b), meta: meta(c) });
  });
  r.post("/topics", requireRole("analyst"), write, async (c) => {
    const b = await parseJson(c, TopicZ);
    const { warnings, ...data } = await svc.create(actor(c), b);
    return c.json({ data, ...(warnings.length ? { warnings } : {}), meta: meta(c) }, 201);
  });
  r.get("/topics/:id", read, async (c) => c.json({ data: await svc.get(actor(c), id(c)), meta: meta(c) }));
  r.patch("/topics/:id", requireRole("analyst"), write, async (c) => {
    const b = await parseJson(c, PatchZ);
    const { warnings, ...data } = await svc.update(actor(c), id(c), b, ifMatch(c.req.header("if-match")));
    return c.json({ data, ...(warnings.length ? { warnings } : {}), meta: meta(c) });
  });
  r.delete("/topics/:id", requireRole("admin"), write, async (c) => {
    await svc.setStatus(actor(c), id(c), "archived", ifMatch(c.req.header("if-match")));
    return c.body(null, 204);
  });
  r.post("/topics/:id/backfill", requireRole("admin"), write, async (c) => {
    const b = await parseJson(
      c,
      z.strictObject({ from: z.iso.datetime(), to: z.iso.datetime(), platforms: z.array(PlatformCode).max(20).optional() }),
    );
    return c.json({ data: await svc.backfill(actor(c), id(c), b), meta: meta(c) }, 202);
  });
  r.get("/topics/:id/runs", requireRole("analyst"), read, async (c) => {
    const q = z
      .object({
        platform: PlatformCode.optional(),
        status: z
          .enum(["queued", "dispatching", "fetching", "processing", "succeeded", "partial", "failed", "skipped", "cancelled"])
          .optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .safeParse(c.req.query());
    if (!q.success)
      throw new ApiError(
        "VALIDATION_FAILED",
        "Parameter tidak valid",
        q.error.issues.map((i) => ({ path: i.path.join("."), issue: i.message })),
      );
    return c.json({ data: await svc.runs(actor(c), id(c), q.data), meta: meta(c) });
  });
  r.post("/topics/:id/pause", requireRole("analyst"), write, async (c) =>
    c.json({ data: await svc.setStatus(actor(c), id(c), "paused", ifMatch(c.req.header("if-match"))), meta: meta(c) }),
  );
  r.post("/topics/:id/resume", requireRole("analyst"), write, async (c) =>
    c.json({ data: await svc.setStatus(actor(c), id(c), "active", ifMatch(c.req.header("if-match"))), meta: meta(c) }),
  );
  return r;
}
