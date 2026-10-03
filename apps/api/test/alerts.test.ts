// O-05 integrasi: aturan alert, saluran notifikasi (secret write-only, disegel), event ack/resolve, isolasi tenant & peran.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { LocalDevKms } from "@smip/crypto";
import { AlertService } from "../src/alerts/service";
import { type ApiHarness, apiHarness, infraUp, tid } from "./helpers";

const up = await infraUp();
const A = tid(1);
const B = tid(2);
const TOPIC = tid(30);
const TOPIC_B = tid(31);

describe.skipIf(!up)("O-05 alerts API (integrasi)", () => {
  let h: ApiHarness;
  const kms = new LocalDevKms({ v1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64") });
  const tok = { admin: "", analyst: "", viewer: "", adminB: "" };
  const bodies: string[] = [];
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const r = await h.call(method, path, { token, body });
    const text = await r.text();
    bodies.push(text);
    return { status: r.status, json: text ? JSON.parse(text) : null };
  };

  beforeAll(async () => {
    h = await apiHarness("alerts", undefined, (db) => ({
      alerts: new AlertService(db, { kms, fingerprintPepper: new Uint8Array(32).fill(7) }),
    }));
    const s = h.sql;
    await s`insert into tenants (id, slug, name) values (${A}, 'a', 'Kantor A'), (${B}, 'b', 'Kantor B')`;
    const users = [
      [tid(11), "adm@a.id", A, "admin"],
      [tid(12), "an@a.id", A, "analyst"],
      [tid(13), "vw@a.id", A, "viewer"],
      [tid(20), "adm@b.id", B, "admin"],
    ] as const;
    for (const [id, email, t, role] of users) {
      await s`insert into users (id, email, name, password_hash) values (${id}, ${email}, ${email}, 'x')`;
      await s`insert into memberships (tenant_id, user_id, role) values (${t}, ${id}, ${role})`;
    }
    await s.begin(async (tx) => {
      await tx`SET LOCAL ROLE smip_system`;
      await tx`insert into topics (id, tenant_id, name) values (${TOPIC}, ${A}, 'BPIP'), (${TOPIC_B}, ${B}, 'Rahasia B')`;
    });
    tok.admin = await h.token({ sub: tid(11), tid: A, role: "admin" });
    tok.analyst = await h.token({ sub: tid(12), tid: A, role: "analyst" });
    tok.viewer = await h.token({ sub: tid(13), tid: A, role: "viewer" });
    tok.adminB = await h.token({ sub: tid(20), tid: B, role: "admin" });
  });
  afterAll(async () => h?.close());

  test("saluran: telegram wajib token (format), secret tidak pernah dikembalikan; webhook wajib https publik; admin saja", async () => {
    expect(
      (await call("POST", "/notification-channels", tok.admin, { kind: "telegram", name: "Grup", config: { chat_id: "-100123" } })).status,
    ).toBe(400);
    expect(
      (
        await call("POST", "/notification-channels", tok.admin, {
          kind: "telegram",
          name: "Grup",
          config: { chat_id: "-100123" },
          secret: "salah",
        })
      ).status,
    ).toBe(400);
    const SECRET = "123456789:AAH-rahasia_bot_token_panjang_sekali";
    const t = await call("POST", "/notification-channels", tok.admin, {
      kind: "telegram",
      name: "Grup humas",
      config: { chat_id: "-100123" },
      secret: SECRET,
    });
    expect(t.status).toBe(201);
    expect(
      (await call("POST", "/notification-channels", tok.admin, { kind: "webhook", name: "Lokal", config: { url: "http://10.0.0.1/x" } }))
        .status,
    ).toBe(400);
    const w = await call("POST", "/notification-channels", tok.admin, {
      kind: "webhook",
      name: "SIEM",
      config: { url: "https://hooks.example.com/smip" },
    });
    expect(w.status).toBe(201);
    expect(
      (await call("POST", "/notification-channels", tok.analyst, { kind: "webhook", name: "x", config: { url: "https://a.example" } }))
        .status,
    ).toBe(403);
    const list = await call("GET", "/notification-channels", tok.viewer);
    expect(list.json.data.map((c: { name: string; has_secret: boolean }) => [c.name, c.has_secret])).toEqual([
      ["Grup humas", true],
      ["SIEM", false],
    ]);
    expect((await call("GET", "/notification-channels", tok.adminB)).json.data).toEqual([]);
    const [cred] = await h.sql`select ciphertext from credentials where tenant_id = ${A}`;
    expect(Buffer.from(cred!.ciphertext).toString()).not.toContain("rahasia_bot");
    expect(bodies.join("\n")).not.toContain("rahasia_bot");
  });

  test("aturan: validasi parameter per jenis, saluran harus milik kantor, viewer baca saja, isolasi tenant", async () => {
    const ch = (await call("GET", "/notification-channels", tok.admin)).json.data as { id: string }[];
    const bad = await call("POST", "/alert-rules", tok.analyst, {
      topic_id: TOPIC,
      type: "negative_ratio",
      params: { threshold_pct: 500 },
    });
    expect(bad.status).toBe(400);
    const r = await call("POST", "/alert-rules", tok.analyst, {
      topic_id: TOPIC,
      type: "negative_ratio",
      params: { threshold_pct: 60 },
      channels: [ch[0]!.id],
    });
    expect(r.status).toBe(201);
    expect((await call("POST", "/alert-rules", tok.adminB, { topic_id: TOPIC, type: "volume_spike" })).status).toBe(400); // topik kantor lain
    expect(
      (await call("POST", "/alert-rules", tok.adminB, { topic_id: TOPIC_B, type: "volume_spike", channels: [ch[0]!.id] })).status,
    ).toBe(400);
    expect((await call("POST", "/alert-rules", tok.viewer, { topic_id: TOPIC, type: "new_issue" })).status).toBe(403);
    const list = await call("GET", "/alert-rules", tok.viewer);
    expect(list.json.data).toHaveLength(1);
    expect(list.json.data[0]).toMatchObject({
      topic_name: "BPIP",
      type: "negative_ratio",
      params: { window_hours: 3, threshold_pct: 60, min_posts: 20 },
    });
    expect((await call("PATCH", `/alert-rules/${r.json.data.id}`, tok.analyst, { enabled: false })).status).toBe(200);
    expect((await call("PATCH", `/alert-rules/${r.json.data.id}`, tok.adminB, { enabled: true })).status).toBe(404);
  });

  test("event: daftar + jumlah open, ack lalu resolve; kantor lain 404", async () => {
    const [rule] = await h.sql`select id from alert_rules where tenant_id = ${A}`;
    const E = tid(500);
    await h.sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE smip_system`;
      await tx`insert into alert_events (id, tenant_id, rule_id, payload) values (${E}, ${A}, ${rule!.id}, ${tx.json({ title: "Sentimen negatif 70%" })})`;
    });
    const ev = await call("GET", "/alert-events?status=open", tok.viewer);
    expect(ev.json.data.open).toBe(1);
    expect(ev.json.data.items[0]).toMatchObject({ id: E, topic_name: "BPIP", payload: { title: "Sentimen negatif 70%" } });
    expect((await call("POST", `/alert-events/${E}/ack`, tok.adminB)).status).toBe(404);
    expect((await call("POST", `/alert-events/${E}/ack`, tok.viewer)).status).toBe(403);
    expect((await call("POST", `/alert-events/${E}/ack`, tok.analyst)).json.data.status).toBe("acked");
    expect((await call("POST", `/alert-events/${E}/resolve`, tok.analyst)).json.data.status).toBe("resolved");
    expect((await call("GET", "/alert-events", tok.viewer)).json.data.open).toBe(0);
  });

  test("hapus saluran: dicabut dari aturan + credential dihapus kriptografis", async () => {
    const ch = (await call("GET", "/notification-channels", tok.admin)).json.data as { id: string; name: string }[];
    const tg = ch.find((c) => c.name === "Grup humas")!;
    expect((await call("DELETE", `/notification-channels/${tg.id}`, tok.admin)).status).toBe(204);
    const [rule] = await h.sql`select channels from alert_rules where tenant_id = ${A}`;
    expect(rule!.channels).toEqual([]);
    expect((await h.sql`select count(*)::int as n from credentials where tenant_id = ${A} and wrapped_dek is not null`)[0]!.n).toBe(0);
  });
});
