// D-03 integrasi: tiket SSE (cookie HttpOnly, Path=/v1/stream, terikat tenant+topik — SEC-10/SEC-11), stream event per topik.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Realtime } from "../src/realtime";
import { type ApiHarness, apiHarness, infraUp, tid } from "./helpers";

const up = await infraUp();
const A = tid(1);
const B = tid(2);
const TA = tid(30);
const TA2 = tid(31);
const TB = tid(32);

/** Redis palsu (SET/GET + EX) — cukup untuk tiket. */
function memCache() {
  const m = new Map<string, string>();
  return {
    m,
    send: async (cmd: string, args: string[]) => {
      if (cmd === "SET") m.set(args[0]!, args[1]!);
      if (cmd === "GET") return m.get(args[0]!) ?? null;
      return "OK";
    },
  };
}

describe.skipIf(!up)("D-03 realtime SSE", () => {
  let h: ApiHarness;
  const cache = memCache();
  const rt = new Realtime(cache, { heartbeatMs: 50 });
  const tok = { viewerA: "", adminB: "" };

  beforeAll(async () => {
    h = await apiHarness("stream", undefined, (db) => ({ analytics: { db, ch: null as never }, realtime: rt }));
    await h.sql`insert into tenants (id, slug, name) values (${A}, 'a', 'A'), (${B}, 'b', 'B')`;
    await h.sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE smip_system`;
      await tx`insert into topics (id, tenant_id, name) values (${TA}, ${A}, 'T1'), (${TA2}, ${A}, 'T2'), (${TB}, ${B}, 'TB')`;
    });
    tok.viewerA = await h.token({ sub: tid(11), tid: A, role: "viewer" });
    tok.adminB = await h.token({ sub: tid(20), tid: B, role: "admin" });
  });
  afterAll(async () => h?.close());

  const ticket = async (token: string, topic: string) => {
    const r = await h.call("POST", "/stream/ticket", { token, body: { topic_id: topic } });
    return { status: r.status, cookie: r.headers.get("set-cookie") ?? "", body: await r.text() };
  };

  test("SEC-11: tiket = cookie HttpOnly/Secure/SameSite=Strict/Path=/v1/stream, 15 menit; token tidak di body/URL; viewer boleh", async () => {
    const t = await ticket(tok.viewerA, TA);
    expect(t.status).toBe(204);
    expect(t.body).toBe("");
    expect(t.cookie).toMatch(/^sse_ticket=[A-Za-z0-9_-]{43}; Max-Age=900; Path=\/v1\/stream; HttpOnly; Secure; SameSite=Strict$/);
    // yang disimpan hanya hash tiket
    const raw = /sse_ticket=([^;]+)/.exec(t.cookie)![1]!;
    expect([...cache.m.keys()].some((k) => k.includes(raw))).toBe(false);
    expect((await ticket(tok.adminB, TA)).status).toBe(404); // topik kantor lain
  });

  test("SEC-10: tanpa tiket 401; tiket topik lain 403; Bearer saja tidak cukup", async () => {
    expect((await h.call("GET", `/stream?topic_id=${TA}`)).status).toBe(401);
    expect((await h.call("GET", `/stream?topic_id=${TA}`, { token: tok.viewerA })).status).toBe(401);
    const t = await ticket(tok.viewerA, TA);
    const cookie = t.cookie.split(";")[0]!;
    expect((await h.call("GET", `/stream?topic_id=${TA2}`, { headers: { cookie } })).status).toBe(403);
  });

  test("stream: ready → event topik sendiri & alert tenant diteruskan; topik/tenant lain tidak; heartbeat", async () => {
    const t = await ticket(tok.viewerA, TA);
    const ctl = new AbortController();
    const r = await h.call("GET", `/stream?topic_id=${TA}`, { headers: { cookie: t.cookie.split(";")[0]! }, signal: ctl.signal });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const reader = r.body!.getReader();
    let text = "";
    const until = async (re: RegExp) => {
      const end = Date.now() + 2000;
      while (!re.test(text) && Date.now() < end) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
    };
    await until(/event: ready/);
    expect(rt.connections).toBe(1);
    rt.onMessage(JSON.stringify({ tenant_id: B, topic_id: TB, event: "aggregates.updated", data: { secret: "B" } }));
    rt.onMessage(JSON.stringify({ tenant_id: A, topic_id: TA2, event: "aggregates.updated", data: { other: 1 } }));
    rt.onMessage(JSON.stringify({ tenant_id: A, topic_id: TA, event: "aggregates.updated", data: { platforms: ["x"] } }));
    rt.onMessage(JSON.stringify({ tenant_id: A, topic_id: null, event: "alert.fired", data: { title: "Lonjakan" } }));
    rt.onMessage("bukan json");
    await until(/event: alert\.fired[\s\S]*event: heartbeat/);
    expect(text).toContain(`event: aggregates.updated\nid: `);
    expect(text).toContain(`"platforms":["x"],"topic_id":"${TA}"`);
    expect(text).toContain('"title":"Lonjakan"');
    expect(text).not.toContain("secret");
    expect(text).not.toContain('"other"');
    ctl.abort();
    await reader.cancel().catch(() => {});
    await Bun.sleep(50);
    expect(rt.connections).toBe(0);
  });
});
