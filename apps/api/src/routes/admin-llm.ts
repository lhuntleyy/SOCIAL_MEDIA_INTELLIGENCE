// Pengaturan LLM (Fase 3, A-03) — operator platform. Tanpa nama vendor di rute: provider = baris DB (kind = protokol).
import { Hono } from "hono";
import { z } from "zod";
import { LLM_TASKS, type LlmAdminService } from "../admin/llm";
import type { Actor } from "../admin/service";
import type { AppEnv } from "../context";
import { ApiError } from "../errors";
import { requireOperator } from "../middleware/auth";
import { parseJson } from "../validate";

const Id = z.uuid();
const Kind = z.enum(["gemini", "openai_compatible", "anthropic"]);
const ApiKey = z.string().min(8).max(512);
const ModelId = z.string().min(1).max(200);

function actor(c: { get: (k: "auth" | "requestId") => unknown; req: { header: (n: string) => string | undefined } }): Actor {
  const a = c.get("auth") as { sub: string; tid: string };
  return {
    userId: a.sub,
    tenantId: a.tid,
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

export function llmAdminRoutes(svc: LlmAdminService) {
  const r = new Hono<AppEnv>();
  const op = requireOperator;
  r.get("/admin/llm", op, async (c) => c.json({ data: await svc.overview() }));
  r.post("/admin/llm/providers", op, async (c) => {
    const b = await parseJson(
      c,
      z.strictObject({
        key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
        name: z.string().min(1).max(80),
        kind: Kind,
        base_url: z.url().max(300).nullable().optional(),
        api_key: ApiKey.optional(),
        key_label: z.string().min(1).max(60).optional(),
      }),
    );
    return c.json({ data: { id: await svc.createProvider(actor(c), b) } }, 201);
  });
  r.patch("/admin/llm/providers/:id", op, async (c) => {
    const b = await parseJson(
      c,
      z.strictObject({
        name: z.string().min(1).max(80).optional(),
        base_url: z.url().max(300).nullable().optional(),
        enabled: z.boolean().optional(),
      }),
    );
    await svc.patchProvider(actor(c), param(c, "id"), b);
    return c.body(null, 204);
  });
  r.delete("/admin/llm/providers/:id", op, async (c) => {
    await svc.deleteProvider(actor(c), param(c, "id"));
    return c.body(null, 204);
  });
  r.post("/admin/llm/providers/:id/keys", op, async (c) => {
    const b = await parseJson(c, z.strictObject({ label: z.string().min(1).max(60), api_key: ApiKey }));
    return c.json({ data: await svc.addKey(actor(c), param(c, "id"), b) }, 201);
  });
  r.patch("/admin/llm/keys/:id", op, async (c) => {
    const b = await parseJson(
      c,
      z.strictObject({ status: z.enum(["active", "disabled"]).optional(), label: z.string().min(1).max(60).optional() }),
    );
    await svc.patchKey(actor(c), param(c, "id"), b);
    return c.body(null, 204);
  });
  r.delete("/admin/llm/keys/:id", op, async (c) => {
    await svc.revokeKey(actor(c), param(c, "id"));
    return c.body(null, 204);
  });
  r.get("/admin/llm/providers/:id/models", op, async (c) => c.json({ data: await svc.models(param(c, "id")) }));
  r.post("/admin/llm/providers/:id/models/refresh", op, async (c) => c.json({ data: await svc.refreshModels(actor(c), param(c, "id")) }));
  r.post("/admin/llm/test", op, async (c) => {
    const b = await parseJson(
      c,
      z.strictObject({
        provider_id: Id,
        model_id: ModelId,
        text: z.string().min(1).max(2000).optional(),
        topic: z.string().max(200).optional(),
      }),
    );
    return c.json({ data: await svc.test(actor(c), b) });
  });
  r.put("/admin/llm/tasks/:task", op, async (c) => {
    const t = z.enum(LLM_TASKS).safeParse(c.req.param("task"));
    if (!t.success) throw new ApiError("NOT_FOUND", "Tugas tidak dikenal");
    const b = await parseJson(
      c,
      z.strictObject({
        provider_id: Id.nullable(),
        model_id: ModelId.nullable(),
        fallback_provider_id: Id.nullable().optional(),
        fallback_model_id: ModelId.nullable().optional(),
        enabled: z.boolean(),
        params: z
          .strictObject({
            max_output_tokens: z.int().min(16).max(8192).optional(),
            batch_size: z.int().min(1).max(100).optional(),
            max_rpm: z.int().min(1).max(10_000).optional(),
          })
          .optional(),
      }),
    );
    await svc.putTask(actor(c), t.data, b);
    return c.body(null, 204);
  });
  return r;
}
