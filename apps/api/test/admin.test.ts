// F-10 integrasi: admin tenant (operator), user/membership (tenant admin), API key, impersonasi operator, isolasi tenant.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ApiHarness, apiHarness, infraUp, tid } from "./helpers";

const up = await infraUp();
const A = tid(1);
const B = tid(2);
const U = { ownerA: tid(10), adminA: tid(11), analystA: tid(12), viewerA: tid(13), ownerB: tid(20), op: tid(30) };
const j = async <T = Record<string, unknown>>(r: Response) => (await r.json()) as { data: T; error?: { code: string } };

describe.skipIf(!up)("admin API (integrasi)", () => {
  let h: ApiHarness;
  const tok: Record<string, string> = {};

  beforeAll(async () => {
    h = await apiHarness("admin", (p) => {
      p.get("/ping", (c) => c.json({ data: { tid: c.get("auth").tid, kind: c.get("auth").kind ?? "user" } }));
      p.patch("/topics/:id", (c) => c.json({ data: "ok" }));
    });
    const { sql } = h;
    await sql`insert into plans (id, code, name, limits) values (${tid(90)}, 'pro', 'Pro', '{}')`;
    await sql`insert into tenants (id, slug, name) values (${A}, 'org-a', 'Org A'), (${B}, 'org-b', 'Org B')`;
    const users: [string, string, string, string][] = [
      [U.ownerA, "owner@a.id", A, "owner"],
      [U.adminA, "admin@a.id", A, "admin"],
      [U.analystA, "analyst@a.id", A, "analyst"],
      [U.viewerA, "viewer@a.id", A, "viewer"],
      [U.ownerB, "owner@b.id", B, "owner"],
    ];
    for (const [id, email, t, role] of users) {
      await sql`insert into users (id, email, name, password_hash) values (${id}, ${email}, ${email}, 'x')`;
      await sql`insert into memberships (tenant_id, user_id, role) values (${t}, ${id}, ${role})`;
    }
    await sql`insert into users (id, email, name, is_platform_operator) values (${U.op}, 'op@smip.id', 'Operator', true)`;
    tok.ownerA = await h.token({ sub: U.ownerA, tid: A, role: "owner" });
    tok.adminA = await h.token({ sub: U.adminA, tid: A, role: "admin" });
    tok.analystA = await h.token({ sub: U.analystA, tid: A, role: "analyst" });
    tok.op = await h.token({ sub: U.op, tid: A, role: "viewer", op: true });
  });
  afterAll(async () => h?.close());

  test("operator mengelola tenant; bukan operator ditolak", async () => {
    const c = await h.call("POST", "/admin/tenants", { token: tok.op, body: { slug: "org-c", name: "Org C", plan_code: "pro" } });
    expect(c.status).toBe(201);
    const id = (await j<{ id: string }>(c)).data.id;
    expect((await h.call("POST", "/admin/tenants", { token: tok.op, body: { slug: "org-c", name: "Dup" } })).status).toBe(409);
    expect((await h.call("PATCH", `/admin/tenants/${id}`, { token: tok.op, body: { status: "suspended" } })).status).toBe(200);
    expect((await h.call("GET", "/admin/tenants", { token: tok.ownerA })).status).toBe(403);
    const list = await j<{ slug: string }[]>(await h.call("GET", "/admin/tenants", { token: tok.op }));
    expect(list.data.map((t) => t.slug)).toContain("org-c");
  });

  test("isolasi: admin A hanya melihat anggota A (users kini ber-RLS)", async () => {
    const r = await j<{ email: string }[]>(await h.call("GET", "/users", { token: tok.adminA }));
    expect(r.data.map((u) => u.email).sort()).toEqual(["admin@a.id", "analyst@a.id", "owner@a.id", "viewer@a.id"]);
    expect((await h.call("GET", "/users", { token: tok.analystA })).status).toBe(403);
  });

  test("undang user baru → token sekali pakai → set password; undang user tenant lain → hanya membership", async () => {
    const r = await h.call("POST", "/users", { token: tok.adminA, body: { email: "baru@a.id", name: "Baru", role: "analyst" } });
    expect(r.status).toBe(201);
    const inv = (await j<{ user_id: string; status: string; invite_token: string }>(r)).data;
    expect(inv.status).toBe("invited");
    expect((await h.call("POST", "/auth/accept-invite", { body: { token: inv.invite_token, password: "Password-Baru-123" } })).status).toBe(
      204,
    );
    expect((await h.call("POST", "/auth/accept-invite", { body: { token: inv.invite_token, password: "Password-Baru-123" } })).status).toBe(
      401,
    ); // sekali pakai
    const login = await h.call("POST", "/auth/login", { body: { email: "baru@a.id", password: "Password-Baru-123" } });
    expect(login.status).toBe(200);

    const r2 = await h.call("POST", "/users", { token: tok.adminA, body: { email: "owner@b.id", name: "x", role: "viewer" } });
    const d2 = (await j<{ status: string; invite_token?: string }>(r2)).data;
    expect([r2.status, d2.status, d2.invite_token]).toEqual([201, "active", undefined]);
    expect((await h.call("POST", "/users", { token: tok.adminA, body: { email: "owner@b.id", name: "x", role: "viewer" } })).status).toBe(
      409,
    );
    const [a] = await h.sql`select count(*)::int c from audit_logs where action = 'user.invite' and tenant_id = ${A}`;
    expect(a!.c).toBe(2);
  });

  test("aturan owner: admin tak bisa menetapkan/menurunkan owner; owner terakhir tak bisa diturunkan/dicabut", async () => {
    expect((await h.call("PATCH", `/users/${U.analystA}`, { token: tok.adminA, body: { role: "owner" } })).status).toBe(403);
    expect((await h.call("PATCH", `/users/${U.ownerA}`, { token: tok.adminA, body: { role: "viewer" } })).status).toBe(403);
    expect((await h.call("PATCH", `/users/${U.analystA}`, { token: tok.adminA, body: { role: "viewer" } })).status).toBe(200);
    const last = await h.call("PATCH", `/users/${U.ownerA}`, { token: tok.ownerA, body: { role: "admin" } });
    expect([last.status, (await j(last)).error?.code]).toEqual([409, "CONFLICT"]);
    expect((await h.call("DELETE", `/users/${U.ownerA}/memberships/${A}`, { token: tok.ownerA })).status).toBe(409);
    // status user global hanya operator
    expect((await h.call("PATCH", `/users/${U.viewerA}`, { token: tok.ownerA, body: { status: "disabled" } })).status).toBe(403);
  });

  test("admin A tidak bisa mencabut membership tenant B; operator bisa lintas tenant", async () => {
    expect((await h.call("DELETE", `/users/${U.ownerB}/memberships/${B}`, { token: tok.adminA })).status).toBe(404);
    const add = await h.call("POST", `/users/${U.analystA}/memberships`, { token: tok.op, body: { tenant_id: B, role: "viewer" } });
    expect(add.status).toBe(201);
    expect((await h.call("DELETE", `/users/${U.analystA}/memberships/${B}`, { token: tok.op })).status).toBe(204);
  });

  test("API key: secret sekali, tidak pernah di-list; scope read → viewer (tak bisa PATCH); tak boleh kelola akses; revoke", async () => {
    const c = await h.call("POST", "/api-keys", { token: tok.adminA, body: { name: "BI dashboard", scopes: ["analytics:read"] } });
    expect(c.status).toBe(201);
    const k = (await j<{ id: string; secret: string; prefix: string }>(c)).data;
    expect(k.secret).toMatch(/^smip_[0-9A-Za-z]{8}_[A-Za-z0-9_-]{43}$/);
    const list = JSON.stringify(await j(await h.call("GET", "/api-keys", { token: tok.adminA })));
    // bagian rahasia = setelah "smip_<prefix>_"; base64url bisa memuat "_" sehingga split("_") tidak aman (flaky CI 2026-09-28)
    const secretPart = k.secret.slice(`smip_${k.prefix}_`.length);
    expect(secretPart).toHaveLength(43);
    expect(list).not.toContain(secretPart);
    expect(list).not.toContain("key_hash");
    const ping = await h.call("GET", "/ping", { headers: { "x-api-key": k.secret } });
    expect(ping.status).toBe(200);
    expect((await j<{ tid: string; kind: string }>(ping)).data).toEqual({ tid: A, kind: "api_key" });
    expect((await h.call("PATCH", `/topics/${A}`, { headers: { "x-api-key": k.secret }, body: {} })).status).toBe(403);
    expect((await h.call("GET", "/api-keys", { headers: { "x-api-key": k.secret } })).status).toBe(403);
    expect((await h.call("GET", "/ping", { headers: { "x-api-key": `${k.secret.slice(0, -2)}xx` } })).status).toBe(401);
    expect((await h.call("DELETE", `/api-keys/${k.id}`, { token: tok.adminA })).status).toBe(204);
    expect((await h.call("GET", "/ping", { headers: { "x-api-key": k.secret } })).status).toBe(401);
    const w = (
      await j<{ secret: string }>(await h.call("POST", "/api-keys", { token: tok.adminA, body: { name: "ETL", scopes: ["topics:write"] } }))
    ).data;
    expect((await h.call("PATCH", `/topics/${A}`, { headers: { "x-api-key": w.secret }, body: {} })).status).toBe(200);
    expect((await h.call("POST", "/api-keys", { token: tok.adminA, body: { name: "x", scopes: ["admin:all"] } })).status).toBe(400);
  });

  test("impersonasi: hanya operator, wajib alasan, diaudit per request; non-operator ditolak", async () => {
    const hdr = { "x-tenant-id": B };
    expect((await h.call("GET", "/users", { token: tok.adminA, headers: hdr })).status).toBe(403);
    expect((await h.call("GET", "/users", { token: tok.op, headers: hdr })).status).toBe(400);
    const r = await h.call("GET", "/users", { token: tok.op, headers: { ...hdr, "x-impersonation-reason": "tiket SUP-123 cek anggota" } });
    expect(r.status).toBe(200);
    expect((await j<{ email: string }[]>(r)).data.map((u) => u.email)).toContain("owner@b.id");
    const [a] = await h.sql`select after->>'reason' r from audit_logs where action = 'operator.impersonate' and tenant_id = ${B}`;
    expect(a!.r).toBe("tiket SUP-123 cek anggota");
    expect(
      (
        await h.call("GET", "/users", {
          token: tok.op,
          headers: { "x-tenant-id": tid(99), "x-impersonation-reason": "tenant tidak ada sama sekali" },
        })
      ).status,
    ).toBe(404);
  });
});
