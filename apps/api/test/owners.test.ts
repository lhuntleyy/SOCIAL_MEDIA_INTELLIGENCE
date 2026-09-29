// Permintaan pemilik 2026-09-30: (1) owner platform TIDAK berada di kantor — login masuk ke tenant internal "platform",
// bisa melihat semua user & menambah owner lain; (2) admin kantor bisa mengisi password saat membuat user dan
// mereset password user kantornya (password langsung / link reset sekali pakai) — tapi tidak untuk user yang juga
// anggota kantor lain (cegah pengambilalihan lintas kantor).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ApiHarness, apiHarness, infraUp, tid } from "./helpers";

const up = await infraUp();
const PLATFORM = "00000000-0000-7000-8000-00000000f000";
const [A, B] = [tid(0xa01), tid(0xa02)];

describe.skipIf(!up)("owner platform + password oleh admin", () => {
  let h: ApiHarness;
  let op: string;
  const call = async (m: string, p: string, token: string, body?: unknown) => {
    const r = await h.call(m, p, { token, body });
    const t = await r.text();
    return { status: r.status, json: t ? JSON.parse(t) : null };
  };
  const login = async (email: string, password: string) => {
    const r = await h.call("POST", "/auth/login", { body: { email, password } });
    return { status: r.status, json: (await r.json()) as { data?: { access_token: string; tenants: { id: string; kind: string }[] } } };
  };
  beforeAll(async () => {
    h = await apiHarness("owners");
    await h.sql`insert into tenants (id, slug, name) values (${A}, 'kantor-a', 'Kantor A'), (${B}, 'kantor-b', 'Kantor B')`;
    const [pt] = await h.sql`select id, kind from tenants where kind = 'platform'`;
    expect(pt?.id).toBe(PLATFORM); // dibuat migrasi 0022
    op = await h.token({ sub: tid(0xa00), tid: PLATFORM, role: "owner", op: true });
    await h.sql`insert into users (id, email, name, password_hash, is_platform_operator) values (${tid(0xa00)}, 'root@smip.id', 'Root', 'x', true)`;
    await h.sql`insert into memberships (tenant_id, user_id, role) values (${PLATFORM}, ${tid(0xa00)}, 'owner')`;
  });
  afterAll(async () => h?.close());

  test("owner baru dengan password → login langsung ke tenant platform; tidak muncul di daftar kantor", async () => {
    const add = await call("POST", "/admin/owners", op, { email: "owner2@smip.id", name: "Owner 2", password: "passwordOwner-2026" });
    expect(add.status).toBe(201);
    expect(add.json.data.status).toBe("active");
    expect(add.json.data.invite_token).toBeUndefined();
    const l = await login("owner2@smip.id", "passwordOwner-2026");
    expect(l.status).toBe(200);
    expect(l.json.data!.tenants.map((t) => t.kind)).toEqual(["platform"]);
    const owners = (await call("GET", "/admin/owners", op)).json.data as { email: string }[];
    expect(owners.map((o) => o.email).sort()).toEqual(["owner2@smip.id", "root@smip.id"]);
    const offices = (await call("GET", "/admin/tenants", op)).json.data as { slug: string }[];
    expect(offices.map((t) => t.slug)).not.toContain("smip-platform");
    // bukan owner → tidak boleh
    const adminA = await h.token({ sub: tid(0xa10), tid: A, role: "owner" });
    expect((await call("POST", "/admin/owners", adminA, { email: "x@x.id", name: "X" })).status).toBe(403);
    expect((await call("DELETE", `/admin/owners/${tid(0xa00)}`, op)).status).toBe(409); // diri sendiri
    expect((await call("DELETE", `/admin/owners/${add.json.data.user_id}`, op)).status).toBe(204);
    expect((await login("owner2@smip.id", "passwordOwner-2026")).status).toBe(403); // tak punya kantor lagi
  });

  test("admin kantor: buat user dengan password; reset password (langsung & link); lintas kantor ditolak", async () => {
    const own = await call("POST", `/admin/tenants/${A}/users`, op, {
      email: "admin@a.id",
      name: "Admin A",
      role: "owner",
      password: "passwordAdminA-2026",
    });
    expect(own.json.data).toMatchObject({ status: "active" });
    const adminA = await h.token({ sub: own.json.data.user_id, tid: A, role: "owner" });
    const u = await call("POST", "/users", adminA, {
      email: "analis@a.id",
      name: "Analis",
      role: "analyst",
      password: "passwordAnalis-01",
    });
    expect(u.status).toBe(201);
    expect(u.json.data.invite_token).toBeUndefined();
    expect((await login("analis@a.id", "passwordAnalis-01")).status).toBe(200);
    expect((await call("POST", "/users", adminA, { email: "x@a.id", name: "X", role: "viewer", password: "pendek" })).status).toBe(400);

    const id = u.json.data.user_id as string;
    expect((await call("POST", `/users/${id}/password`, adminA, { password: "passwordBaru-2026!" })).status).toBe(200);
    expect((await login("analis@a.id", "passwordAnalis-01")).status).toBe(401);
    expect((await login("analis@a.id", "passwordBaru-2026!")).status).toBe(200);

    const link = await call("POST", `/users/${id}/password`, adminA, {});
    const token = link.json.data.reset_token as string;
    expect(token).toBeString();
    expect((await call("POST", "/auth/accept-invite", "", { token, password: "passwordDariLink-1" })).status).toBe(204);
    expect((await call("POST", "/auth/accept-invite", "", { token, password: "passwordDariLink-2" })).status).toBe(401); // sekali pakai
    expect((await login("analis@a.id", "passwordDariLink-1")).status).toBe(200);

    // user yang juga anggota kantor B → admin kantor A tidak boleh mereset; owner platform boleh
    await h.sql`insert into memberships (tenant_id, user_id, role) values (${B}, ${id}, 'viewer')`;
    expect((await call("POST", `/users/${id}/password`, adminA, { password: "passwordLain-2026" })).status).toBe(403);
    expect((await call("POST", `/admin/users/${id}/password`, op, { password: "passwordOwner-set1" })).status).toBe(200);
    // kantor lain / tidak ada → 404
    const adminB = await h.token({ sub: tid(0xa20), tid: B, role: "owner" });
    expect((await call("POST", `/users/${own.json.data.user_id}/password`, adminB, {})).status).toBe(404);

    // owner platform melihat semua user + kantornya; owner platform sendiri tidak ikut
    const all = (await call("GET", "/admin/users", op)).json.data as { email: string; offices: { tenant: string; role: string }[] }[];
    expect(all.find((x) => x.email === "analis@a.id")!.offices.map((o) => [o.tenant, o.role])).toEqual([
      ["Kantor A", "analyst"],
      ["Kantor B", "viewer"],
    ]);
    expect(all.some((x) => x.email === "root@smip.id")).toBe(false);
    const audit = await h.sql`select action from audit_logs where action like 'user.password%' order by at, id`;
    expect(audit.map((x) => x.action)).toEqual(["user.password_set", "user.password_reset_link", "user.password_set"]);
  });
});
