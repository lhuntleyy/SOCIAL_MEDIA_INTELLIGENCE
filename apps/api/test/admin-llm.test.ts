// Fase 3 A-03: pengaturan LLM di panel admin — provider + multi API key (write-only), katalog model dari API provider,
// tes model, tugas → model, rotasi/cooldown key. HTTP provider di-MOCK (CI tidak memanggil LLM sungguhan).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HttpClient } from "@smip/connector-sdk";
import { LocalDevKms } from "@smip/crypto";
import { LlmAdminService } from "../src/admin/llm";
import { type ApiHarness, apiHarness, infraUp, tid } from "./helpers";

const up = await infraUp();
const KEY1 = "AIzaTESTkeySATU_0123456789abcdefghijklmn";
const KEY2 = "AIzaTESTkeyDUA_0123456789abcdefghijklmno";
let mode: "ok" | "429" | "401" = "ok";
const seen: { url: string; key: string | null }[] = [];
const json = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
async function mockFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const u = new URL(String(input));
  const key = ((init?.headers ?? {}) as Record<string, string>)["x-goog-api-key"] ?? null;
  seen.push({ url: u.pathname, key });
  if (mode === "429") return json(429, { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota" } });
  if (mode === "401") return json(400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid" } });
  if (u.pathname.endsWith("/models"))
    return json(200, {
      models: [
        {
          name: "models/gemini-3.5-flash-lite",
          displayName: "Gemini 3.5 Flash-Lite",
          inputTokenLimit: 1048576,
          outputTokenLimit: 65536,
          supportedGenerationMethods: ["generateContent"],
        },
        { name: "models/text-embedding-x", supportedGenerationMethods: ["embedContent"] },
      ],
    });
  if (u.pathname.includes(":generateContent"))
    return json(200, {
      candidates: [{ content: { parts: [{ text: '{"label":"negative","confidence":0.93}' }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 60, candidatesTokenCount: 8 },
      modelVersion: "gemini-3.5-flash-lite",
    });
  return json(404, { error: { message: "?" } });
}

describe.skipIf(!up)("A-03 pengaturan LLM (admin)", () => {
  let h: ApiHarness;
  let op: string;
  let adm: string;
  const bodies: string[] = [];
  const call = async (m: string, p: string, token: string, body?: unknown) => {
    const r = await h.call(m, p, { token, body });
    const t = await r.text();
    bodies.push(t);
    return { status: r.status, json: t ? JSON.parse(t) : null };
  };
  beforeAll(async () => {
    h = await apiHarness("llm", undefined, (db) => ({
      llm: new LlmAdminService(db, {
        kms: new LocalDevKms({ v1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64") }),
        fingerprintPepper: new Uint8Array(32).fill(3),
        http: new HttpClient({ fetchImpl: mockFetch, resolver: async () => ["142.250.4.95"], timeoutMs: 2000 }),
      }),
    }));
    await h.sql`insert into tenants (id, slug, name) values (${tid(1)}, 't1', 'T1')`;
    await h.sql`insert into users (id, email, name, password_hash, is_platform_operator) values (${tid(9)}, 'op@x.id', 'Op', 'x', true), (${tid(8)}, 'a@x.id', 'A', 'x', false)`;
    await h.sql`insert into memberships (user_id, tenant_id, role) values (${tid(9)}, ${tid(1)}, 'owner'), (${tid(8)}, ${tid(1)}, 'admin')`;
    op = await h.token({ sub: tid(9), tid: tid(1), role: "owner", op: true });
    adm = await h.token({ sub: tid(8), tid: tid(1), role: "admin" });
  });
  afterAll(async () => h?.close());

  let pid: string;
  test("operator saja; buat provider + key (write-only); base_url privat ditolak", async () => {
    expect((await call("GET", "/admin/llm", adm)).status).toBe(403);
    const bad = await call("POST", "/admin/llm/providers", op, {
      key: "lokal",
      name: "Lokal",
      kind: "openai_compatible",
      base_url: "http://127.0.0.1:11434/v1",
    });
    expect(bad.status).toBe(400);
    expect((await call("POST", "/admin/llm/providers", op, { key: "tanpa_url", name: "X", kind: "openai_compatible" })).status).toBe(400);
    const r = await call("POST", "/admin/llm/providers", op, {
      key: "gemini",
      name: "Google Gemini",
      kind: "gemini",
      api_key: KEY1,
      key_label: "gratis-1",
    });
    expect(r.status).toBe(201);
    pid = r.json.data.id;
    const k2 = await call("POST", `/admin/llm/providers/${pid}/keys`, op, { label: "gratis-2", api_key: KEY2 });
    expect(k2.json.data).toMatchObject({ label: "gratis-2", display_hint: `••••${KEY2.slice(-4)}` });
    expect((await call("POST", `/admin/llm/providers/${pid}/keys`, op, { label: "dup", api_key: KEY2 })).status).toBe(409);
    const o = await call("GET", "/admin/llm", op);
    expect(o.json.data.providers[0].keys.map((k: { label: string }) => k.label)).toEqual(["gratis-1", "gratis-2"]);
    expect(o.json.data.tasks.map((t: { task: string }) => t.task)).toEqual(["default", "sentiment", "emotion", "keyphrase", "summary"]);
  });

  test("refresh model: hanya model generateContent; key dikirim di header (bukan URL); tugas → model tervalidasi katalog", async () => {
    expect(
      (await call("PUT", "/admin/llm/tasks/sentiment", op, { provider_id: pid, model_id: "gemini-3.5-flash-lite", enabled: true })).status,
    ).toBe(400);
    const r = await call("POST", `/admin/llm/providers/${pid}/models/refresh`, op);
    expect(r.json.data).toEqual({ count: 1 });
    expect(seen.every((s) => !s.url.includes("AIza") && s.key?.startsWith("AIzaTEST"))).toBe(true);
    const m = await call("GET", `/admin/llm/providers/${pid}/models`, op);
    expect(m.json.data[0]).toMatchObject({ model_id: "gemini-3.5-flash-lite", input_token_limit: 1048576 });
    expect(
      (
        await call("PUT", "/admin/llm/tasks/sentiment", op, {
          provider_id: pid,
          model_id: "gemini-3.5-flash-lite",
          enabled: true,
          params: { batch_size: 20 },
        })
      ).status,
    ).toBe(204);
    const o = await call("GET", "/admin/llm", op);
    expect(o.json.data.tasks.find((t: { task: string }) => t.task === "sentiment")).toMatchObject({
      model_id: "gemini-3.5-flash-lite",
      enabled: true,
      version: 1,
    });
  });

  test("tes model → JSON terstruktur; 429 → key cooldown & key lain dipakai; 401 → key invalid", async () => {
    const ok = await call("POST", "/admin/llm/test", op, { provider_id: pid, model_id: "gemini-3.5-flash-lite" });
    expect(ok.json.data).toMatchObject({ ok: true, result: { label: "negative" }, input_tokens: 60, output_tokens: 8 });
    mode = "429";
    seen.length = 0;
    const rl = await call("POST", "/admin/llm/test", op, { provider_id: pid, model_id: "gemini-3.5-flash-lite" });
    expect(rl.json.data).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
    const first = seen[0]!.key;
    seen.length = 0;
    mode = "ok";
    expect((await call("POST", "/admin/llm/test", op, { provider_id: pid, model_id: "gemini-3.5-flash-lite" })).json.data.ok).toBe(true);
    expect(seen[0]!.key).not.toBe(first); // key yang cooldown dilewati → key lain
    mode = "401";
    await call("POST", "/admin/llm/test", op, { provider_id: pid, model_id: "gemini-3.5-flash-lite" });
    const keys = await h.sql`select status, last_error_code, cooldown_until is not null as cd from llm_api_keys order by created_at`;
    expect(keys.map((k) => k.status).sort()).toEqual(["active", "invalid"]);
    mode = "ok";
  });

  test("revoke key → crypto-shred; hapus provider; SEC-02 key tak muncul di respons/audit", async () => {
    const o = await call("GET", "/admin/llm", op);
    const kid = o.json.data.providers[0].keys[0].id;
    expect((await call("DELETE", `/admin/llm/keys/${kid}`, op)).status).toBe(204);
    const [c] = await h.sql`select c.wrapped_dek from llm_api_keys k join credentials c on c.id = k.credential_id where k.id = ${kid}`;
    expect(c!.wrapped_dek).toBeNull();
    const dump = JSON.stringify([...bodies, await h.sql`select * from audit_logs`, await h.sql`select * from outbox`]);
    for (const k of [KEY1, KEY2]) expect(dump).not.toContain(k);
    expect((await call("DELETE", `/admin/llm/providers/${pid}`, op)).status).toBe(204);
    expect((await h.sql`select count(*)::int as n from llm_api_keys`)[0]!.n).toBe(0);
  });
});
