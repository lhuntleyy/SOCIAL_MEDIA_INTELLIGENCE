// API_SPEC §10 — admin tenant (operator), user & membership, API key (tenant admin); /auth/accept-invite (publik).
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { type Actor, type AdminService, API_KEY_SCOPES } from "../admin/service";
import type { AppEnv } from "../context";
import { ApiError } from "../errors";
import { requireOperator, requireRole } from "../middleware/auth";
import { parseJson } from "../validate";

const RoleZ = z.enum(["owner", "admin", "analyst", "viewer"]);
const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/);
const Id = z.uuid();

/** Pengelolaan identitas/akses butuh manusia: API key tidak boleh memakai rute admin. */
const humanOnly = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("auth")?.kind === "api_key") throw new ApiError("FORBIDDEN", "API key tidak boleh mengelola akses");
  await next();
});

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
/** Password yang diisi admin: sama dengan aturan halaman undangan (min. 12 karakter). */
const Password = z.string().min(12, "minimal 12 karakter").max(200);
const NewUserZ = z.strictObject({
  email: z.email().max(254),
  name: z.string().min(1).max(120),
  role: RoleZ,
  password: Password.optional(),
});
const param = (c: { req: { param: (n: string) => string } }, n: string) => {
  const r = Id.safeParse(c.req.param(n));
  if (!r.success) throw new ApiError("VALIDATION_FAILED", "ID tidak valid", [{ path: n, issue: "bukan UUID" }]);
  return r.data;
};

export function adminRoutes(svc: AdminService) {
  const r = new Hono<AppEnv>();
  r.use("/admin/*", humanOnly);
  r.use("/users/*", humanOnly);
  r.use("/users", humanOnly);
  r.use("/api-keys/*", humanOnly);
  r.use("/api-keys", humanOnly);

  // ----- owner platform: owner lain, semua user, password -----
  r.get("/admin/owners", requireOperator, async (c) => c.json({ data: await svc.listOwners() }));
  r.post("/admin/owners", requireOperator, async (c) => {
    const b = await parseJson(
      c,
      z.strictObject({ email: z.email().max(254), name: z.string().min(1).max(120), password: Password.optional() }),
    );
    return c.json({ data: await svc.addOwner(actor(c), b) }, 201);
  });
  r.delete("/admin/owners/:id", requireOperator, async (c) => {
    await svc.removeOwner(actor(c), param(c, "id"));
    return c.body(null, 204);
  });
  r.get("/admin/users", requireOperator, async (c) => c.json({ data: await svc.listAllUsers() }));
  r.post("/admin/users/:id/password", requireOperator, async (c) => {
    const b = await parseJson(c, z.strictObject({ password: Password.optional() }));
    const a = c.get("auth");
    return c.json({ data: await svc.setPassword(actor(c), param(c, "id"), b, { role: a.role, op: a.op, crossTenant: true }) });
  });

  // ----- operator: tenant -----
  r.get("/admin/tenants", requireOperator, async (c) => c.json({ data: await svc.listTenants() }));
  r.post("/admin/tenants", requireOperator, async (c) => {
    const b = await parseJson(
      c,
      z.strictObject({ slug: Slug, name: z.string().min(2).max(120), plan_code: z.string().optional(), timezone: z.string().optional() }),
    );
    return c.json({ data: await svc.createTenant(actor(c), b) }, 201);
  });
  r.patch("/admin/tenants/:id", requireOperator, async (c) => {
    const b = await parseJson(
      c,
      z.strictObject({
        status: z.enum(["active", "suspended", "closed"]).optional(),
        plan_code: z.string().optional(),
        name: z.string().min(2).max(120).optional(),
        /** I-19: true = connector provider unofficial (risk high) tidak pernah melayani tenant ini. */
        deny_high_risk_providers: z.boolean().optional(),
      }),
    );
    return c.json({ data: await svc.updateTenant(actor(c), param(c, "id"), b) });
  });

  r.get("/admin/tenants/:id/users", requireOperator, async (c) => c.json({ data: await svc.listUsers(param(c, "id") as never) }));
  r.post("/admin/tenants/:id/users", requireOperator, async (c) => {
    const b = await parseJson(c, NewUserZ);
    return c.json({ data: await svc.inviteToTenant(actor(c), param(c, "id"), b) }, 201);
  });

  // ----- tenant admin: user & membership -----
  r.get("/users", requireRole("admin"), async (c) => c.json({ data: await svc.listUsers(c.get("auth").tid as never) }));
  r.post("/users", requireRole("admin"), async (c) => {
    const b = await parseJson(c, NewUserZ);
    if (b.role === "owner" && c.get("auth").role !== "owner" && !c.get("auth").op)
      throw new ApiError("FORBIDDEN", "Hanya owner yang dapat menambah owner");
    return c.json({ data: await svc.inviteUser(actor(c), b) }, 201);
  });
  r.post("/users/:id/password", requireRole("admin"), async (c) => {
    const b = await parseJson(c, z.strictObject({ password: Password.optional() }));
    const a = c.get("auth");
    return c.json({ data: await svc.setPassword(actor(c), param(c, "id"), b, { role: a.role, op: a.op, crossTenant: false }) });
  });
  r.patch("/users/:id", requireRole("admin"), async (c) => {
    const b = await parseJson(c, z.strictObject({ role: RoleZ.optional(), status: z.enum(["active", "disabled"]).optional() }));
    const a = c.get("auth");
    const id = param(c, "id");
    const out: Record<string, unknown> = { id };
    if (b.role) Object.assign(out, await svc.updateMemberRole(actor(c), id, b.role, { role: a.role, op: a.op }));
    if (b.status) {
      // status user bersifat GLOBAL (lintas tenant) → hanya operator
      if (!a.op) throw new ApiError("FORBIDDEN", "Status user hanya dapat diubah platform operator");
      Object.assign(out, await svc.setUserStatus(actor(c), id, b.status));
    }
    return c.json({ data: out });
  });
  r.post("/users/:id/memberships", requireOperator, async (c) => {
    const b = await parseJson(c, z.strictObject({ tenant_id: Id, role: RoleZ }));
    return c.json({ data: await svc.addMembership(actor(c), param(c, "id"), b.tenant_id, b.role) }, 201);
  });
  r.delete("/users/:id/memberships/:tenantId", requireRole("admin"), async (c) => {
    const a = c.get("auth");
    await svc.removeMembership(actor(c), param(c, "id"), param(c, "tenantId"), {
      role: a.role,
      op: a.op,
      crossTenant: a.op && !a.impersonating,
    });
    return c.body(null, 204);
  });

  // ----- API key -----
  r.get("/api-keys", requireRole("admin"), async (c) => c.json({ data: await svc.listApiKeys(c.get("auth").tid as never) }));
  r.post("/api-keys", requireRole("admin"), async (c) => {
    const b = await parseJson(
      c,
      z.strictObject({
        name: z.string().min(1).max(80),
        scopes: z.array(z.enum(API_KEY_SCOPES)).min(1),
        expires_at: z.iso.datetime().optional(),
      }),
    );
    return c.json({ data: await svc.createApiKey(actor(c), b), meta: { note: "secret hanya ditampilkan sekali" } }, 201);
  });
  r.delete("/api-keys/:id", requireRole("admin"), async (c) => {
    await svc.revokeApiKey(actor(c), param(c, "id"));
    return c.body(null, 204);
  });
  return r;
}

export function publicAdminRoutes(svc: AdminService) {
  const r = new Hono<AppEnv>();
  r.post("/auth/accept-invite", async (c) => {
    const b = await parseJson(c, z.strictObject({ token: z.string().min(20).max(200), password: z.string().min(12).max(512) }));
    await svc.acceptInvite(b.token, b.password);
    return c.body(null, 204);
  });
  return r;
}
