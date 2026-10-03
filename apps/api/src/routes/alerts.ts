// API_SPEC §8 — /alert-rules, /alert-events, /notification-channels (O-05).
import { Hono } from "hono";
import { z } from "zod";
import type { AlertService } from "../alerts/service";
import type { AppEnv } from "../context";
import { ApiError } from "../errors";
import { requireRole } from "../middleware/auth";
import type { Actor } from "../topics/service";
import { parseJson } from "../validate";

const Id = z.uuid();
const Hours = z.int().min(1).max(72);
const Params = {
  negative_ratio: z.strictObject({
    window_hours: Hours.default(3),
    threshold_pct: z.int().min(5).max(100).default(50),
    min_posts: z.int().min(1).max(100_000).default(20),
  }),
  volume_spike: z.strictObject({
    window_hours: Hours.default(1),
    factor: z.number().min(1.5).max(50).default(3),
    min_posts: z.int().min(1).max(100_000).default(30),
  }),
  new_issue: z.strictObject({ window_hours: Hours.default(6), min_mentions: z.int().min(2).max(100_000).default(10) }),
};
const RuleType = z.enum(["negative_ratio", "volume_spike", "new_issue"]);
const RuleZ = z.strictObject({
  topic_id: Id,
  type: RuleType,
  params: z.record(z.string(), z.number()).default({}),
  channels: z.array(Id).max(10).optional(),
  cooldown_sec: z
    .int()
    .min(900)
    .max(7 * 86_400)
    .optional(),
  enabled: z.boolean().optional(),
});
const RulePatchZ = RuleZ.omit({ topic_id: true, type: true }).partial();
const ChannelZ = z.strictObject({
  kind: z.enum(["telegram", "webhook"]),
  name: z.string().trim().min(1).max(80),
  config: z.strictObject({ chat_id: z.string().max(80).optional(), url: z.string().max(500).optional() }),
  secret: z.string().max(300).optional(),
  enabled: z.boolean().optional(),
});
const ChannelPatchZ = ChannelZ.omit({ kind: true }).partial();

function params(type: z.infer<typeof RuleType>, raw: Record<string, number>) {
  const p = Params[type].safeParse(raw);
  if (!p.success)
    throw new ApiError(
      "VALIDATION_FAILED",
      "Parameter aturan tidak valid",
      p.error.issues.map((i) => ({ path: `params.${i.path.join(".")}`, issue: i.message })),
    );
  return p.data as Record<string, number>;
}

export function alertRoutes(svc: AlertService) {
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
    if (!p.success) throw new ApiError("NOT_FOUND", "Tidak ditemukan");
    return p.data;
  };

  r.get("/alert-rules", async (c) => c.json({ data: await svc.listRules(actor(c)) }));
  r.post("/alert-rules", requireRole("analyst"), async (c) => {
    const b = await parseJson(c, RuleZ);
    return c.json({ data: await svc.createRule(actor(c), { ...b, params: params(b.type, b.params) }) }, 201);
  });
  r.patch("/alert-rules/:id", requireRole("analyst"), async (c) => {
    const b = await parseJson(c, RulePatchZ);
    if (b.params) {
      const [cur] = (await svc.listRules(actor(c))).filter((x) => (x as { id: string }).id === id(c)) as {
        type: z.infer<typeof RuleType>;
      }[];
      if (!cur) throw new ApiError("NOT_FOUND", "Aturan tidak ditemukan");
      b.params = params(cur.type, b.params);
    }
    return c.json({ data: await svc.updateRule(actor(c), id(c), b) });
  });
  r.delete("/alert-rules/:id", requireRole("analyst"), async (c) => {
    await svc.deleteRule(actor(c), id(c));
    return c.body(null, 204);
  });

  r.get("/alert-events", async (c) => {
    const q = z
      .object({ status: z.enum(["open", "acked", "resolved"]).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) })
      .safeParse(c.req.query());
    if (!q.success) throw new ApiError("VALIDATION_FAILED", "Parameter tidak valid");
    return c.json({ data: await svc.listEvents(actor(c), q.data) });
  });
  r.post("/alert-events/:id/ack", requireRole("analyst"), async (c) =>
    c.json({ data: await svc.setEventStatus(actor(c), id(c), "acked") }),
  );
  r.post("/alert-events/:id/resolve", requireRole("analyst"), async (c) =>
    c.json({ data: await svc.setEventStatus(actor(c), id(c), "resolved") }),
  );

  r.get("/notification-channels", async (c) => c.json({ data: await svc.listChannels(actor(c)) }));
  r.post("/notification-channels", requireRole("admin"), async (c) =>
    c.json({ data: await svc.createChannel(actor(c), await parseJson(c, ChannelZ)) }, 201),
  );
  r.patch("/notification-channels/:id", requireRole("admin"), async (c) =>
    c.json({ data: await svc.updateChannel(actor(c), id(c), await parseJson(c, ChannelPatchZ)) }),
  );
  r.delete("/notification-channels/:id", requireRole("admin"), async (c) => {
    await svc.deleteChannel(actor(c), id(c));
    return c.body(null, 204);
  });
  r.post("/notification-channels/:id/test", requireRole("admin"), async (c) => c.json({ data: await svc.testChannel(actor(c), id(c)) }));
  return r;
}
