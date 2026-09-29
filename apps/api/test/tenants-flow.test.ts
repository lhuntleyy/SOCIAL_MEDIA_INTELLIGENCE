// Alur multi-kantor (permintaan pemilik 2026-09-30): administrator platform membuat Kantor A & B → mengundang admin kantor →
// admin kantor mengundang user sendiri. Topik kantor A tidak terlihat kantor B (RLS); administrator melihat semua
// (ringkasan /admin/tenants + impersonasi X-Tenant-Id yang diaudit).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TopicService } from "../src/topics/service";
import { type ApiHarness, apiHarness, infraUp, tid } from "./helpers";

const up = await infraUp();
const OP = tid(0x900);

describe.skipIf(!up)("alur multi-kantor", () => {
  let h: ApiHarness;
  let op: string;
  const call = async (m: string, p: string, token: string, body?: unknown, headers?: Record<string, string>) => {
    const r = await h.call(m, p, { token, body, headers });
    const t = await r.text();
    return { status: r.status, json: t ? JSON.parse(t) : null };
  };
  beforeAll(async () => {
    h = await apiHarness("tflow", undefined, (db) => ({ topics: new TopicService(db) }));
    await h.sql`insert into tenants (id, slug, name) values (${tid(0x901)}, 'platform', 'Platform')`;
    await h.sql`insert into users (id, email, name, password_hash, is_platform_operator) values (${OP}, 'root@smip.id', 'Root', 'x', true)`;
    await h.sql`insert into memberships (tenant_id, user_id, role) values (${tid(0x901)}, ${OP}, 'owner')`;
    op = await h.token({ sub: OP, tid: tid(0x901), role: "owner", op: true });
  });
  afterAll(async () => h?.close());

  test("administrator → kantor A & B → admin kantor → user sendiri; topik terisolasi; administrator melihat semua", async () => {
    const a = await call("POST", "/admin/tenants", op, { slug: "kantor-a", name: "Kantor A" });
    const b = await call("POST", "/admin/tenants", op, { slug: "kantor-b", name: "Kantor B" });
    expect([a.status, b.status]).toEqual([201, 201]);
    const A = a.json.data.id as string;
    const B = b.json.data.id as string;

    // administrator mengundang owner tiap kantor → token undangan → user membuat password
    const invA = await call("POST", `/admin/tenants/${A}/users`, op, { email: "admin@kantor-a.id", name: "Admin A", role: "owner" });
    const invB = await call("POST", `/admin/tenants/${B}/users`, op, { email: "admin@kantor-b.id", name: "Admin B", role: "owner" });
    expect(invA.json.data.invite_token).toBeString();
    expect(
      (await call("POST", "/auth/accept-invite", "", { token: invA.json.data.invite_token, password: "passwordKantorA-123" })).status,
    ).toBe(204);
    expect(
      (await call("POST", "/auth/accept-invite", "", { token: invA.json.data.invite_token, password: "lagi-lagi-123456" })).status,
    ).toBe(401); // sekali pakai
    // bukan operator → tidak boleh mengundang ke kantor lain
    const ownerA = await h.token({ sub: invA.json.data.user_id, tid: A, role: "owner" });
    const ownerB = await h.token({ sub: invB.json.data.user_id, tid: B, role: "owner" });
    expect((await call("POST", `/admin/tenants/${B}/users`, ownerA, { email: "x@x.id", name: "X", role: "admin" })).status).toBe(403);

    // admin kantor A mengundang analis sendiri — hanya masuk kantor A
    const an = await call("POST", "/users", ownerA, { email: "analis@kantor-a.id", name: "Analis A", role: "analyst" });
    expect(an.status).toBe(201);
    expect((await call("GET", "/users", ownerA)).json.data.map((u: { email: string }) => u.email).sort()).toEqual([
      "admin@kantor-a.id",
      "analis@kantor-a.id",
    ]);
    expect((await call("GET", "/users", ownerB)).json.data.map((u: { email: string }) => u.email)).toEqual(["admin@kantor-b.id"]);

    // topik per kantor (seed langsung) — saling tidak terlihat
    await h.sql`insert into topics (id, tenant_id, name) values (${tid(0x910)}, ${A}, 'Demo KDMP'), (${tid(0x911)}, ${B}, 'Demo Mahasiswa')`;
    const names = async (t: string, hdr?: Record<string, string>) =>
      (await call("GET", "/topics", t, undefined, hdr)).json.data.map((x: { name: string }) => x.name);
    expect(await names(ownerA)).toEqual(["Demo KDMP"]);
    expect(await names(ownerB)).toEqual(["Demo Mahasiswa"]);
    expect((await call("GET", `/topics/${tid(0x910)}`, ownerB)).status).toBe(404);

    // administrator: ringkasan semua kantor + melihat data kantor B via impersonasi (wajib alasan, diaudit)
    const all = (await call("GET", "/admin/tenants", op)).json.data as { slug: string; users: number; topic_names: string[] }[];
    expect(all.filter((t) => t.slug.startsWith("kantor")).map((t) => [t.slug, t.users, t.topic_names])).toEqual([
      ["kantor-a", 2, ["Demo KDMP"]],
      ["kantor-b", 1, ["Demo Mahasiswa"]],
    ]);
    // administrator melihat user kantor mana pun (halaman "Kantor & pengguna"); admin kantor tidak
    const usersA = (await call("GET", `/admin/tenants/${A}/users`, op)).json.data as { email: string; role: string }[];
    expect(usersA.map((u) => [u.email, u.role]).sort()).toEqual([
      ["admin@kantor-a.id", "owner"],
      ["analis@kantor-a.id", "analyst"],
    ]);
    expect((await call("GET", `/admin/tenants/${B}/users`, ownerA)).status).toBe(403);
    expect((await call("GET", "/topics", op, undefined, { "x-tenant-id": B })).status).toBe(400); // tanpa alasan
    expect(await names(op, { "x-tenant-id": B, "x-impersonation-reason": "Pemantauan administrator" })).toEqual(["Demo Mahasiswa"]);
    expect(
      (await call("GET", "/topics", ownerA, undefined, { "x-tenant-id": B, "x-impersonation-reason": "coba intip kantor lain" })).status,
    ).toBe(403);
    const [aud] = await h.sql`select count(*)::int as n from audit_logs where action = 'operator.impersonate' and tenant_id = ${B}`;
    expect(aud!.n).toBe(1);
  });
});
