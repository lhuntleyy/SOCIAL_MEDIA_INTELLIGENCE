// API_SPEC §9 — admin provider management. Operator platform; akun BYO boleh dikelola admin tenant untuk tenant-nya sendiri.
// Rute ini generik (tanpa nama provider — lihat scripts/check-deps.ts). Secret credential hanya masuk, tak pernah keluar (SEC-02).

import { Operation, RunKind } from "@smip/contracts";
import { QUEUE_NAMES, type QueueName } from "@smip/core";
import { Hono } from "hono";
import { z } from "zod";
import type { ProviderAdminService } from "../admin/providers";
import type { Actor } from "../admin/service";
import type { AppEnv } from "../context";
import { ApiError } from "../errors";
import { requireOperator, requireRole } from "../middleware/auth";
import { parseJson } from "../validate";

const Id = z.uuid();
const Iso = z.iso.datetime({ offset: true });
const Secret = z
  .record(z.string().regex(/^[a-z][a-z0-9_]{0,40}$/), z.string().min(1).max(32_768)) // settings sesi instagrapi (JSON) bisa beberapa KB
  .refine((o) => Object.keys(o).length > 0 && Object.keys(o).length <= 8, {
    message: "1–8 field",
  });
/** Setiap kunci SETTING_DEFAULTS + rentang wajar; null = kembali ke default. */
const SettingsZ = z
  .strictObject({
    "topics.initial_backfill_days": z.int().min(0).max(31).nullable(),
    "fetch.min_items_per_run": z.int().min(1).max(100).nullable(),
    "demographics.enabled": z.boolean().nullable(),
    "comments.enabled": z.boolean().nullable(),
    "comments.top_posts_per_day": z.int().min(0).max(1000).nullable(),
    "comments.max_pages_per_post": z.int().min(1).max(50).nullable(),
    "comments.refetch_hours": z.int().min(1).max(720).nullable(),
    "schedule.adaptive_enabled": z.boolean().nullable(),
    "schedule.adaptive_max_interval_sec": z.int().min(300).max(86_400).nullable(),
    "schedule.night_enabled": z.boolean().nullable(),
    "schedule.night_start_hour": z.int().min(0).max(23).nullable(),
    "schedule.night_end_hour": z.int().min(0).max(23).nullable(),
    "schedule.night_interval_sec": z.int().min(300).max(86_400).nullable(),
    "comments.max_post_age_days": z.int().min(1).max(30).nullable(),
  })
  .partial();
const Credential = z.strictObject({ kind: z.enum(["api_key", "oauth2", "session", "basic", "cookie_jar"]), secret: Secret });

function actor(c: {
  get: (k: "auth" | "requestId") => unknown;
  req: { header: (n: string) => string | undefined };
}): Actor & { op: boolean } {
  const a = c.get("auth") as { sub: string; tid: string; op?: boolean };
  return {
    userId: a.sub,
    tenantId: a.tid,
    op: !!a.op,
    ip: c.req.header("x-smip-client-ip"),
    ua: c.req.header("user-agent"),
    requestId: c.get("requestId") as string,
  };
}
const param = (c: { req: { param: (n: string) => string } }, n: string) => {
  const r = Id.safeParse(c.req.param(n));
  if (!r.success) throw new ApiError("VALIDATION_FAILED", "ID tidak valid", [{ path: n, issue: "bukan UUID" }]);
  return r.data;
};
function query<S extends z.ZodType>(c: { req: { query: () => Record<string, string> } }, s: S): z.output<S> {
  const r = s.safeParse(c.req.query());
  if (!r.success)
    throw new ApiError(
      "VALIDATION_FAILED",
      "Query tidak valid",
      r.error.issues.map((i) => ({ path: i.path.join("."), issue: i.message })),
    );
  return r.data;
}

export function providerAdminRoutes(svc: ProviderAdminService) {
  const r = new Hono<AppEnv>();
  const op = requireOperator;
  // credential & routing provider = pengelolaan manusia (MFA); API key tenant tidak pernah boleh
  r.use("/admin/*", async (c, next) => {
    if (c.get("auth")?.kind === "api_key") throw new ApiError("FORBIDDEN", "API key tidak boleh mengelola provider");
    await next();
  });

  // ----- providers & connectors -----
  r.get("/admin/platforms", op, async (c) => c.json({ data: await svc.listPlatforms() }));
  r.patch("/admin/platforms/:code", op, async (c) => {
    const code = c.req.param("code");
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(code)) throw new ApiError("NOT_FOUND", "Platform tidak ditemukan");
    const b = await parseJson(
      c,
      z.strictObject({
        max_items_per_run: z.int().min(1).max(10_000).nullable().optional(),
        /** interval pengambilan platform (detik) — berlaku ke semua topik; null = bawaan sistem */
        crawl_interval_sec: z.int().min(60).max(86_400).nullable().optional(),
      }),
    );
    return c.json({ data: await svc.patchPlatform(actor(c), code, b) });
  });
  // ----- pengaturan sistem (Batas & jadwal) -----
  r.get("/admin/settings", op, async (c) => c.json({ data: await svc.getSettings() }));
  r.put("/admin/settings", op, async (c) => {
    const b = await parseJson(c, z.strictObject({ values: SettingsZ }));
    return c.json({ data: await svc.putSettings(actor(c), b.values) });
  });
  r.get("/admin/providers", op, async (c) => c.json({ data: await svc.listProviders() }));
  r.patch("/admin/providers/:id", op, async (c) => {
    const b = await parseJson(
      c,
      z.strictObject({
        enabled: z.boolean().optional(),
        risk_level: z.enum(["low", "medium", "high"]).optional(),
        notes: z.string().max(2000).nullable().optional(),
      }),
    );
    return c.json({ data: await svc.patchProvider(actor(c), param(c, "id"), b) });
  });
  r.get("/admin/connectors", op, async (c) =>
    c.json({
      data: await svc.listConnectors(
        query(c, z.object({ platform: z.string().max(40).optional(), provider: z.string().max(60).optional() })),
      ),
    }),
  );
  r.get("/admin/connectors/:id", op, async (c) => c.json({ data: await svc.getConnector(param(c, "id")) }));
  r.patch("/admin/connectors/:id", op, async (c) => {
    const b = await parseJson(
      c,
      z.strictObject({
        enabled: z.boolean().optional(),
        config: z.record(z.string(), z.unknown()).optional(),
        health: z
          .strictObject({
            failures: z.int().min(1).max(100).optional(),
            minSuccessRate: z.number().min(0).max(1).optional(),
            probeSuccesses: z.int().min(1).max(20).optional(),
            cooldownMs: z.int().min(1000).max(86_400_000).optional(),
            cooldownCapMs: z.int().min(1000).max(86_400_000).optional(),
          })
          .optional(),
      }),
    );
    return c.json({ data: await svc.patchConnector(actor(c), param(c, "id"), b) });
  });
  r.post("/admin/connectors/:id/health-check", op, async (c) =>
    c.json({ data: await svc.enqueueConnectorJob(actor(c), param(c, "id"), "health.probe") }, 202),
  );
  r.post("/admin/connectors/:id/verify", op, async (c) => {
    // memanggil provider SUNGGUHAN (bisa berbayar) → query wajib, sampel kecil, apply eksplisit
    const b = await parseJson(
      c,
      z.strictObject({
        query: z.string().min(1).max(500),
        operation: Operation.optional(),
        samples: z.int().min(1).max(5).default(1),
        max_items: z.int().min(1).max(50).default(10),
        window_hours: z.int().min(1).max(168).default(24),
        apply: z.boolean().default(false),
      }),
    );
    return c.json({ data: await svc.enqueueConnectorJob(actor(c), param(c, "id"), "connector.verify", b) }, 202);
  });
  // ----- accounts (admin tenant: BYO sendiri) -----
  const adm = requireRole("admin");
  r.get("/admin/accounts", adm, async (c) =>
    c.json({
      data: await svc.listAccounts(
        actor(c),
        query(
          c,
          z.object({
            provider: z.string().max(60).optional(),
            status: z.enum(["active", "cooling_down", "needs_attention", "disabled", "revoked"]).optional(),
          }),
        ),
      ),
    }),
  );
  r.post("/admin/accounts", adm, async (c) => {
    const b = await parseJson(
      c,
      z.strictObject({
        provider_id: Id,
        label: z.string().min(1).max(80),
        tenant_id: Id.nullable().optional(),
        credential: Credential,
        allowed_connector_ids: z.array(Id).max(50).nullable().optional(),
      }),
    );
    return c.json({ data: await svc.createAccount(actor(c), b) }, 201);
  });
  r.patch("/admin/accounts/:id", adm, async (c) => {
    const b = await parseJson(
      c,
      z.strictObject({
        status: z.enum(["active", "disabled"]).optional(),
        label: z.string().min(1).max(80).optional(),
        allowed_connector_ids: z.array(Id).max(50).nullable().optional(),
      }),
    );
    return c.json({ data: await svc.patchAccount(actor(c), param(c, "id"), b) });
  });
  r.put("/admin/accounts/:id/credential", adm, async (c) => {
    const b = await parseJson(c, Credential);
    return c.json({ data: await svc.rotateCredential(actor(c), param(c, "id"), b) });
  });
  r.delete("/admin/accounts/:id", adm, async (c) => {
    await svc.revokeAccount(actor(c), param(c, "id"));
    return c.body(null, 204);
  });

  // ----- routing policies -----
  r.get("/admin/routing-policies", op, async (c) =>
    c.json({
      data: await svc.listPolicies(
        query(c, z.object({ platform: z.string().max(40).optional(), operation: z.string().max(40).optional(), tenant_id: Id.optional() })),
      ),
    }),
  );
  r.post("/admin/routing-policies/simulate", op, async (c) => {
    const b = await parseJson(
      c,
      z.strictObject({
        tenant_id: Id,
        platform: z.string().min(1).max(40),
        operation: Operation,
        run_kind: RunKind,
        interval_sec: z.int().min(60).max(86_400),
        exclude_connector_ids: z.array(Id).max(50).optional(),
        shared_pool_only: z.boolean().optional(),
      }),
    );
    return c.json({ data: await svc.simulate(b) });
  });
  r.put("/admin/routing-policies/:id", op, async (c) => {
    const b = await parseJson(
      c,
      z.strictObject({
        strategy: z.enum(["priority_weighted", "round_robin", "cost_aware"]),
        failover_enabled: z.boolean(),
        max_attempts: z.int().min(1).max(5),
        allow_unverified: z.boolean(),
        enabled: z.boolean(),
        rules: z
          .array(
            z.strictObject({
              connector_id: Id,
              priority: z.int().min(1).max(100),
              weight: z.int().min(0).max(1000),
              enabled: z.boolean(),
              max_share_pct: z.int().min(1).max(100).nullable().optional(),
              run_kinds: z.array(RunKind).min(1).nullable().optional(),
            }),
          )
          .max(20),
      }),
    );
    const im = c.req.header("if-match")?.replace(/^W\//, "").replace(/"/g, "");
    const v = im !== undefined && /^\d+$/.test(im) ? Number(im) : undefined;
    const out = await svc.replacePolicy(actor(c), param(c, "id"), b, v);
    c.header("ETag", `"${out.version}"`);
    return c.json({ data: out });
  });

  // ----- rate limits & quotas -----
  const RL = z.strictObject({
    scope_type: z.enum(["provider", "connector", "provider_account"]),
    scope_id: Id,
    algorithm: z.enum(["token_bucket", "fixed_window", "concurrency"]),
    capacity: z.int().min(1),
    refill_tokens: z.int().min(0).optional(),
    refill_interval_ms: z.int().min(1).optional(),
    // setiap angka limit wajib bersumber (PROVIDER_MATRIX; Golden Rule "no invented numbers")
    source: z.enum(["provider_docs", "provider_header", "observed", "internal_safety"]),
    source_ref: z.string().min(3).max(500),
    enabled: z.boolean().optional(),
  });
  r.get("/admin/rate-limits", op, async (c) => c.json({ data: await svc.listRateLimits() }));
  r.post("/admin/rate-limits", op, async (c) => c.json({ data: await svc.upsertRateLimit(actor(c), null, await parseJson(c, RL)) }, 201));
  r.patch("/admin/rate-limits/:id", op, async (c) => {
    const b = await parseJson(
      c,
      RL.pick({ capacity: true, refill_tokens: true, refill_interval_ms: true, source: true, source_ref: true, enabled: true }).partial(),
    );
    if ((b.capacity !== undefined || b.refill_tokens !== undefined || b.refill_interval_ms !== undefined) && (!b.source || !b.source_ref))
      throw new ApiError("VALIDATION_FAILED", "Mengubah angka limit wajib menyertakan source + source_ref", [
        { path: "source_ref", issue: "wajib" },
      ]);
    return c.json({ data: await svc.upsertRateLimit(actor(c), param(c, "id"), b) });
  });
  const Q = z.strictObject({
    scope_type: z.enum(["global", "tenant", "topic", "provider", "connector", "provider_account"]),
    scope_id: Id.nullable().optional(),
    period: z.enum(["day", "month"]),
    unit: z.enum(["requests", "results", "cost_units"]),
    limit_value: z.number().min(0),
    hard: z.boolean().optional(),
    alert_thresholds: z.array(z.int().min(1).max(100)).max(5).optional(),
    reset_tz: z.string().max(60).optional(),
    enabled: z.boolean().optional(),
  });
  r.get("/admin/quotas", op, async (c) => c.json({ data: await svc.listQuotas() }));
  r.post("/admin/quotas", op, async (c) => c.json({ data: await svc.upsertQuota(actor(c), null, await parseJson(c, Q)) }, 201));
  r.patch("/admin/quotas/:id", op, async (c) =>
    c.json({
      data: await svc.upsertQuota(
        actor(c),
        param(c, "id"),
        await parseJson(c, Q.pick({ limit_value: true, hard: true, alert_thresholds: true, enabled: true }).partial()),
      ),
    }),
  );

  // ----- usage, audit, DLQ -----
  r.get("/admin/usage", op, async (c) => {
    const q = query(c, z.object({ group_by: z.enum(["connector", "account", "tenant"]), from: Iso, to: Iso }));
    if (Date.parse(q.to) <= Date.parse(q.from))
      throw new ApiError("VALIDATION_FAILED", "to harus > from", [{ path: "to", issue: "rentang" }]);
    return c.json({ data: await svc.usage(q) });
  });
  r.get("/admin/crawl-monitor", op, async (c) =>
    c.json({ data: await svc.crawlMonitor(query(c, z.object({ hours: z.coerce.number().int().min(1).max(168).default(24) })).hours) }),
  );
  r.get("/admin/audit-logs", op, async (c) =>
    c.json({
      data: await svc.auditLogs(
        query(
          c,
          z.object({
            target_type: z.string().max(60).optional(),
            actor: Id.optional(),
            from: Iso.optional(),
            to: Iso.optional(),
            exclude_action: z.string().max(60).optional(),
            limit: z.coerce.number().int().min(1).max(500).default(100),
          }),
        ),
      ),
    }),
  );
  const queue = (c: { req: { param: (n: string) => string } }) => {
    const q = c.req.param("queue") as QueueName;
    if (!QUEUE_NAMES.includes(q)) throw new ApiError("VALIDATION_FAILED", "Nama queue tidak valid", [{ path: "queue", issue: "format" }]);
    return q;
  };
  r.get("/admin/dlq/:queue", op, async (c) => c.json({ data: await svc.listDlq(queue(c)) }));
  r.post("/admin/dlq/:queue/:job_id/redrive", op, async (c) =>
    c.json({ data: await svc.redriveDlq(actor(c), queue(c), c.req.param("job_id").slice(0, 200)) }, 202),
  );
  r.delete("/admin/dlq/:queue/:job_id", op, async (c) => {
    await svc.discardDlq(actor(c), queue(c), c.req.param("job_id").slice(0, 200));
    return c.body(null, 204);
  });
  return r;
}
