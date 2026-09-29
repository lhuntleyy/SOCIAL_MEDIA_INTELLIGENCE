// I-21 integrasi: Admin API provider management (API_SPEC §9) — akses operator vs admin tenant (BYO), secret write-only (SEC-02),
// config divalidasi config_schema + SSRF guard, routing policy versioned (If-Match), simulate read-only, rate limit wajib bersumber, DLQ.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { credentialAad, LocalDevKms, open } from "@smip/crypto";
import { createDb, loadRoutingSnapshot } from "@smip/db";
import { ProviderAdminService } from "../src/admin/providers";
import { type ApiHarness, apiHarness, infraUp, tid } from "./helpers";

const up = await infraUp();
const SECRET = "apify_api_SANGATRAHASIA_1234567890abcd";
const T1 = tid(1);
const T2 = tid(2);
const OP = tid(0x100);
const ADM1 = tid(0x101);
const ADM2 = tid(0x102);
const PROV = tid(0x200);
const PROV_UNOFF = tid(0x201);
const CONN = tid(0x300);
const CONN2 = tid(0x301);
const CONN_IG = tid(0x302);
const POLICY = tid(0x400);

describe.skipIf(!up)("I-21 Admin API provider management", () => {
  let h: ApiHarness;
  const kms = new LocalDevKms({ v1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64") });
  const dlqCalls: string[] = [];
  let opTok: string;
  let adm1: string;
  let adm2: string;
  const bodies: string[] = []; // SEC-02: semua body respons dikumpulkan lalu dipindai

  const call = async (method: string, path: string, token: string, body?: unknown, headers?: Record<string, string>) => {
    const r = await h.call(method, path, { token, body, headers });
    const text = await r.text();
    bodies.push(text);
    return { status: r.status, json: text ? JSON.parse(text) : null, headers: r.headers };
  };

  beforeAll(async () => {
    h = await apiHarness("admprov", undefined, (db) => ({
      providers: new ProviderAdminService(db, {
        kms,
        fingerprintPepper: new Uint8Array(32).fill(9),
        dlq: {
          listDlq: async (q) => [{ queue: q, envelope: { idempotency_key: "k1" }, error_code: "X" }],
          redrive: async (q, id) => {
            if (id !== "k1") throw new Error(`DLQ ${q}/${id} tidak ditemukan`);
            dlqCalls.push(`redrive:${q}:${id}`);
            return `${id}.redrive.1`;
          },
          discard: async (q, id) => void dlqCalls.push(`discard:${q}:${id}`),
        },
      }),
    }));
    const s = h.sql;
    await s`insert into platforms (code, name, icon, content_types, enabled) values ('x', 'X', 'x', '{post}', true), ('instagram', 'IG', 'ig', '{post}', true)`;
    await s`insert into tenants (id, slug, name) values (${T1}, 't1', 'T1'), (${T2}, 't2', 'T2')`;
    await s`insert into users (id, email, name, password_hash, is_platform_operator) values
      (${OP}, 'op@x.id', 'Op', 'x', true), (${ADM1}, 'a1@x.id', 'A1', 'x', false), (${ADM2}, 'a2@x.id', 'A2', 'x', false)`;
    await s`insert into memberships (user_id, tenant_id, role) values (${ADM1}, ${T1}, 'admin'), (${ADM2}, ${T2}, 'admin'), (${OP}, ${T1}, 'owner')`;
    await s`insert into providers (id, key, name, kind, risk_level, enabled) values
      (${PROV}, 'prova', 'Prov A', 'third_party', 'medium', true), (${PROV_UNOFF}, 'provu', 'Prov U', 'unofficial', 'high', false)`;
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        actor: { type: "string", maxLength: 80 },
        max_items: { type: "integer", minimum: 1, maximum: 1000 },
        base_url: { type: "string" },
      },
    };
    await s`insert into connectors (id, key, provider_id, platform_code, runtime, version, enabled, config, config_schema) values
      (${CONN}, 'prova.x', ${PROV}, 'x', 'bun', '1.0.0', true, ${s.json({ actor: "a/b", health: { failures: 5 } })}, ${s.json(schema)}),
      (${CONN2}, 'prova.x.alt', ${PROV}, 'x', 'bun', '1.0.0', true, '{}', '{}'),
      (${CONN_IG}, 'prova.instagram', ${PROV}, 'instagram', 'bun', '1.0.0', true, '{}', '{}')`;
    for (const c of [CONN, CONN2])
      await s`insert into connector_capabilities (connector_id, operation, declared, measured, status, verified_at, evidence_ref) values
        (${c}, 'search_keyword', ${s.json({ query_features: ["term", "phrase", "or"] })}, ${s.json({ min_interval_sec: 300, p95_latency_ms: 20000 })}, 'verified', now(), 'docs/evidence/verify/test.json')`;
    await s`insert into routing_policies (id, tenant_id, platform_code, operation, strategy, failover_enabled, max_attempts, allow_unverified, enabled, version)
      values (${POLICY}, null, 'x', 'search_keyword', 'priority_weighted', true, 3, false, true, 1)`;
    await s`insert into routing_rules (id, policy_id, connector_id, priority, weight, enabled, conditions) values
      (${tid(0x500)}, ${POLICY}, ${CONN}, 1, 100, true, '{}'), (${tid(0x501)}, ${POLICY}, ${CONN2}, 2, 50, true, '{}')`;
    opTok = await h.token({ sub: OP, tid: T1, role: "owner", op: true });
    adm1 = await h.token({ sub: ADM1, tid: T1, role: "admin" });
    adm2 = await h.token({ sub: ADM2, tid: T2, role: "admin" });
  });
  afterAll(async () => {
    await h?.close();
  });

  test("hanya operator: admin tenant ditolak untuk providers/connectors/policies/usage/DLQ", async () => {
    for (const [m, p] of [
      ["GET", "/admin/providers"],
      ["GET", "/admin/connectors"],
      ["GET", "/admin/routing-policies"],
      ["GET", "/admin/rate-limits"],
      ["GET", "/admin/quotas"],
      ["GET", "/admin/usage?group_by=connector&from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z"],
      ["GET", "/admin/dlq/fetch.bun"],
      ["GET", "/admin/audit-logs"],
    ] as const)
      expect((await call(m, p, adm1)).status).toBe(403);
  });

  test("providers: list + agregat; PATCH diaudit; unofficial wajib risk high (400)", async () => {
    const l = await call("GET", "/admin/providers", opTok);
    expect(l.status).toBe(200);
    expect(l.json.data.find((p: { key: string }) => p.key === "prova").connectors).toBe(3);
    const bad = await call("PATCH", `/admin/providers/${PROV_UNOFF}`, opTok, { risk_level: "low" });
    expect(bad.status).toBe(400);
    const ok = await call("PATCH", `/admin/providers/${PROV}`, opTok, { notes: "catatan ops" });
    expect(ok.json.data.notes).toBe("catatan ops");
    const [o] = await h.sql`select count(*)::int as n from outbox where aggregate = 'provider' and aggregate_id = ${PROV}`;
    expect(o!.n).toBe(1);
  });

  test("connectors: list berisi capabilities/health/rate_limits/quota tanpa config_schema", async () => {
    const r = await call("GET", "/admin/connectors?platform=x", opTok);
    expect(r.json.data.map((c: { key: string }) => c.key).sort()).toEqual(["prova.x", "prova.x.alt"]);
    const c = r.json.data.find((x: { key: string }) => x.key === "prova.x");
    expect(c.provider.key).toBe("prova");
    expect(c.capabilities[0].operation).toBe("search_keyword");
    expect(c.config_schema).toBeUndefined();
    expect((await call("GET", `/admin/connectors/${tid(0x999)}`, opTok)).status).toBe(404);
  });

  test("PATCH connector: config divalidasi config_schema; URL privat ditolak (SSRF); health params dipertahankan", async () => {
    const bad = await call("PATCH", `/admin/connectors/${CONN}`, opTok, { config: { actor: "a/b", max_items: 0, extra: 1 } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.details.map((d: { path: string }) => d.path).sort()).toEqual(["config.extra", "config.max_items"]);
    const ssrf = await call("PATCH", `/admin/connectors/${CONN}`, opTok, { config: { base_url: "http://127.0.0.1:8080/x" } });
    expect(ssrf.status).toBe(400);
    const ok = await call("PATCH", `/admin/connectors/${CONN}`, opTok, {
      config: { actor: "c/d", max_items: 50 },
      health: { cooldownMs: 60000 },
    });
    expect(ok.status).toBe(200);
    expect(ok.json.data.config).toEqual({ actor: "c/d", max_items: 50, health: { failures: 5, cooldownMs: 60000 } });
  });

  test("health-check / verify → 202 + job via outbox (API tidak memanggil provider)", async () => {
    const r = await call("POST", `/admin/connectors/${CONN}/health-check`, opTok);
    expect(r.status).toBe(202);
    expect((await call("POST", `/admin/connectors/${CONN}/verify`, opTok)).status).toBe(400); // query wajib (panggilan berbayar)
    expect((await call("POST", `/admin/connectors/${CONN}/verify`, opTok, { query: "kopdes", samples: 50 })).status).toBe(400);
    const v = await call("POST", `/admin/connectors/${CONN}/verify`, opTok, { query: "kopdes", samples: 2 });
    expect(v.status).toBe(202);
    const [vj] =
      await h.sql`select payload->'payload' as p from outbox where event_type = 'enqueue.connector.verify' and aggregate_id = ${CONN}`;
    expect(vj!.p).toMatchObject({ query: "kopdes", samples: 2, max_items: 10, window_hours: 24, apply: false });
    const jobs = await h.sql`select event_type from outbox where aggregate_id = ${CONN} and event_type like 'enqueue.%' order by id`;
    expect(jobs.map((j) => j.event_type)).toEqual(["enqueue.health.probe", "enqueue.connector.verify"]);
  });

  let shared: string;
  let byo: string;
  test("accounts: secret write-only (respons/list/audit/outbox bersih), tersegel dan bisa dibuka dengan AAD yang benar", async () => {
    const r = await call("POST", "/admin/accounts", opTok, {
      provider_id: PROV,
      label: "pool-1",
      tenant_id: null,
      credential: { kind: "api_key", secret: { token: SECRET } },
    });
    expect(r.status).toBe(201);
    shared = r.json.data.id;
    expect(r.json.data.display_hint).toBe(`••••${SECRET.slice(-4)}`);
    const [cred] = await h.sql`select c.* from credentials c join provider_accounts pa on pa.credential_id = c.id where pa.id = ${shared}`;
    expect(Buffer.from(cred!.ciphertext).toString("latin1")).not.toContain("SANGATRAHASIA");
    const opened = await open<{ token: string }>(
      kms,
      { ciphertext: cred!.ciphertext, iv: cred!.iv, wrapped_dek: cred!.wrapped_dek, kek_id: cred!.kek_id, aad: cred!.aad },
      credentialAad(cred!.id, null),
    );
    expect(opened.token).toBe(SECRET);
    // duplikat credential yang sama → 409 (fingerprint HMAC, tanpa dekripsi)
    const dup = await call("POST", "/admin/accounts", opTok, {
      provider_id: PROV,
      label: "pool-2",
      credential: { kind: "api_key", secret: { token: SECRET } },
    });
    expect(dup.status).toBe(409);
    const l = await call("GET", "/admin/accounts", opTok);
    expect(l.json.data.map((a: { label: string }) => a.label)).toEqual(["pool-1"]);
  });

  test("admin tenant: hanya BYO tenant sendiri (R-13) — tak bisa lihat/ubah shared pool atau tenant lain", async () => {
    const r = await call("POST", "/admin/accounts", adm1, {
      provider_id: PROV,
      label: "byo-t1",
      credential: { kind: "api_key", secret: { token: `${SECRET}_t1` } },
    });
    expect(r.status).toBe(201);
    expect(r.json.data.tenant_id).toBe(T1);
    byo = r.json.data.id;
    // key yang sama di tenant lain BUKAN duplikat (tanpa oracle lintas tenant); di tenant sama → 409
    const other = await call("POST", "/admin/accounts", adm2, {
      provider_id: PROV,
      label: "byo-t2",
      credential: { kind: "api_key", secret: { token: `${SECRET}_t1` } },
    });
    expect(other.status).toBe(201);
    expect(
      (
        await call("POST", "/admin/accounts", adm1, {
          provider_id: PROV,
          label: "byo-t1-dup",
          credential: { kind: "api_key", secret: { token: `${SECRET}_t1` } },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call("POST", "/admin/accounts", adm1, {
          provider_id: PROV,
          label: "x",
          tenant_id: T2,
          credential: { kind: "api_key", secret: { t: "zzzzzzzz" } },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call("POST", "/admin/accounts", adm1, {
          provider_id: PROV,
          label: "x",
          tenant_id: null,
          credential: { kind: "api_key", secret: { t: "zzzzzzzz" } },
        })
      ).status,
    ).toBe(403);
    const l1 = await call("GET", "/admin/accounts", adm1);
    expect(l1.json.data.map((a: { id: string }) => a.id)).toEqual([byo]);
    expect((await call("GET", "/admin/accounts", adm2)).json.data.map((a: { label: string }) => a.label)).toEqual(["byo-t2"]);
    expect((await call("PATCH", `/admin/accounts/${shared}`, adm1, { status: "disabled" })).status).toBe(404);
    expect((await call("DELETE", `/admin/accounts/${byo}`, adm2)).status).toBe(404);
    expect((await call("PATCH", `/admin/accounts/${byo}`, adm1, { label: "byo-t1b" })).json.data.label).toBe("byo-t1b");
  });

  test("rotasi credential: credential lama di-crypto-shred; revoke: DEK dihapus + status revoked", async () => {
    const [before] = await h.sql`select credential_id from provider_accounts where id = ${shared}`;
    const r = await call("PUT", `/admin/accounts/${shared}/credential`, opTok, { kind: "api_key", secret: { token: `${SECRET}_v2` } });
    expect(r.status).toBe(200);
    const [old] = await h.sql`select wrapped_dek, rotated_at from credentials where id = ${before!.credential_id}`;
    expect(old!.wrapped_dek).toBeNull();
    expect(old!.rotated_at).not.toBeNull();
    expect((await call("DELETE", `/admin/accounts/${byo}`, adm1)).status).toBe(204);
    const [acc] =
      await h.sql`select pa.status, c.wrapped_dek from provider_accounts pa join credentials c on c.id = pa.credential_id where pa.id = ${byo}`;
    expect([acc!.status, acc!.wrapped_dek]).toEqual(["revoked", null]);
    expect((await call("PATCH", `/admin/accounts/${byo}`, adm1, { status: "active" })).status).toBe(409);
  });

  test("routing policy PUT: If-Match wajib, versi basi 409, replace rules atomik + version++; connector beda platform ditolak", async () => {
    const body = {
      strategy: "priority_weighted",
      failover_enabled: true,
      max_attempts: 2,
      allow_unverified: false,
      enabled: true,
      rules: [
        { connector_id: CONN2, priority: 1, weight: 100, enabled: true },
        { connector_id: CONN, priority: 2, weight: 10, enabled: true, run_kinds: ["backfill"] },
      ],
    };
    expect((await call("PUT", `/admin/routing-policies/${POLICY}`, opTok, body)).status).toBe(400);
    expect((await call("PUT", `/admin/routing-policies/${POLICY}`, opTok, body, { "if-match": '"7"' })).status).toBe(409);
    const bad = { ...body, rules: [{ connector_id: CONN_IG, priority: 1, weight: 1, enabled: true }] };
    expect((await call("PUT", `/admin/routing-policies/${POLICY}`, opTok, bad, { "if-match": '"1"' })).status).toBe(400);
    const ok = await call("PUT", `/admin/routing-policies/${POLICY}`, opTok, body, { "if-match": '"1"' });
    expect(ok.status).toBe(200);
    expect(ok.json.data.version).toBe(2);
    expect(ok.headers.get("etag")).toBe('"2"');
    expect(ok.json.data.rules.map((r: { connector_key: string }) => r.connector_key)).toEqual(["prova.x.alt", "prova.x"]);
    const l = await call("GET", "/admin/routing-policies?platform=x", opTok);
    expect(l.json.data[0].rules[1].conditions).toEqual({ run_kinds: ["backfill"] });
  });

  test("simulate: dry-run memilih connector + trace; tidak mengubah apa pun", async () => {
    const before = await h.sql`select count(*)::int as n from outbox`;
    const r = await call("POST", "/admin/routing-policies/simulate", opTok, {
      tenant_id: T1,
      platform: "x",
      operation: "search_keyword",
      run_kind: "incremental",
      interval_sec: 900,
    });
    expect(r.status).toBe(200);
    expect(r.json.data.decision).toMatchObject({ kind: "selected", connector_key: "prova.x.alt", account_label: "pool-1" });
    expect(r.json.data.trace.length).toBe(2);
    const ex = await call("POST", "/admin/routing-policies/simulate", opTok, {
      tenant_id: T1,
      platform: "x",
      operation: "search_keyword",
      run_kind: "incremental",
      interval_sec: 900,
      exclude_connector_ids: [CONN2],
    });
    // CONN hanya untuk backfill (run_kinds) → tidak ada kandidat
    expect(ex.json.data.decision.kind).toBe("none_available");
    const none = await call("POST", "/admin/routing-policies/simulate", opTok, {
      tenant_id: T1,
      platform: "instagram",
      operation: "search_hashtag",
      run_kind: "incremental",
      interval_sec: 900,
    });
    expect(none.json.data.decision).toEqual({ kind: "none_available", reason: "NO_POLICY" });
    expect((await h.sql`select count(*)::int as n from outbox`)[0]!.n).toBe(before[0]!.n);
  });

  test("rate limit wajib source + source_ref; ubah angka tanpa sumber ditolak", async () => {
    const base = {
      scope_type: "connector",
      scope_id: CONN,
      algorithm: "token_bucket",
      capacity: 10,
      refill_tokens: 10,
      refill_interval_ms: 60000,
    };
    expect((await call("POST", "/admin/rate-limits", opTok, base)).status).toBe(400);
    const r = await call("POST", "/admin/rate-limits", opTok, {
      ...base,
      source: "internal_safety",
      source_ref: "nilai konservatif operator",
    });
    expect(r.status).toBe(201);
    expect((await call("PATCH", `/admin/rate-limits/${r.json.data.id}`, opTok, { capacity: 20 })).status).toBe(400);
    const p = await call("PATCH", `/admin/rate-limits/${r.json.data.id}`, opTok, {
      capacity: 20,
      source: "observed",
      source_ref: "header x-ratelimit",
    });
    expect(p.json.data.capacity).toBe(20);
    expect((await call("PATCH", `/admin/rate-limits/${r.json.data.id}`, opTok, { enabled: false })).status).toBe(200);
  });

  test("quota: scope_id konsisten dengan scope_type; PATCH limit", async () => {
    expect(
      (
        await call("POST", "/admin/quotas", opTok, {
          scope_type: "global",
          scope_id: CONN,
          period: "month",
          unit: "cost_units",
          limit_value: 5,
        })
      ).status,
    ).toBe(400);
    const q = await call("POST", "/admin/quotas", opTok, {
      scope_type: "connector",
      scope_id: CONN,
      period: "month",
      unit: "results",
      limit_value: 1000,
    });
    expect(q.status).toBe(201);
    const p = await call("PATCH", `/admin/quotas/${q.json.data.id}`, opTok, { limit_value: 2000 });
    expect(p.json.data.limit_value).toBe(2000);
    const c = await call("GET", `/admin/connectors/${CONN}`, opTok);
    expect(c.json.data.quota).toMatchObject([{ scope: "connector", period: "month", unit: "results", limit: 2000 }]);
  });

  test("usage per connector/tenant dari ledger attempts", async () => {
    const run = tid(0x700);
    const stream = tid(0x701);
    await h.sql`insert into collection_streams (id, platform_code, operation, stream_key, interval_class, terms, interval_sec, next_run_at)
      values (${stream}, 'x', 'search_keyword', ${Buffer.from(stream)}, 900, '{kopdes}', 900, now())`;
    const [cr] = await h.sql`insert into crawl_runs (id, collection_stream_id, scheduled_for, kind, status, window_from, window_to)
      values (${run}, ${stream}, date_trunc('milliseconds', now()), 'incremental', 'succeeded', now() - interval '1 hour', now()) returning scheduled_for`;
    await h.sql`insert into provider_attempts (id, crawl_run_id, crawl_run_scheduled_for, tenant_id, connector_id, attempt_no, started_at, outcome, usage)
      values (${Bun.randomUUIDv7()}, ${run}, ${cr!.scheduled_for}, ${T1}, ${CONN}, 1, now(), 'success', ${h.sql.json({ requests: 2, results: 40, costUnits: 0.2 })}),
             (${Bun.randomUUIDv7()}, ${run}, ${cr!.scheduled_for}, ${T1}, ${CONN}, 2, now(), 'failover_error', ${h.sql.json({ requests: 1, results: 0 })})`;
    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 3600_000).toISOString();
    const c = await call("GET", `/admin/usage?group_by=connector&from=${from}&to=${to}`, opTok);
    expect(c.json.data).toEqual([{ connector: "prova.x", attempts: 2, requests: 3, results: 40, cost_units: 0.2, successes: 1 }]);
    const t = await call("GET", `/admin/usage?group_by=tenant&from=${from}&to=${to}`, opTok);
    expect(t.json.data).toEqual([{ tenant_id: T1, requests: 3, results: 40, cost_units: 0.2 }]);
    expect((await call("GET", `/admin/usage?group_by=connector&from=${to}&to=${from}`, opTok)).status).toBe(400);
  });

  test("DLQ: list/redrive/discard diaudit; queue tak dikenal 400; job hilang 404", async () => {
    expect((await call("GET", "/admin/dlq/fetch.bun", opTok)).json.data).toHaveLength(1);
    expect((await call("GET", "/admin/dlq/tidak.ada", opTok)).status).toBe(400);
    expect((await call("POST", "/admin/dlq/fetch.bun/k1/redrive", opTok)).json.data.job_id).toBe("k1.redrive.1");
    expect((await call("POST", "/admin/dlq/fetch.bun/zz/redrive", opTok)).status).toBe(404);
    expect((await call("DELETE", "/admin/dlq/fetch.bun/k2", opTok)).status).toBe(204);
    expect(dlqCalls).toEqual(["redrive:fetch.bun:k1", "discard:fetch.bun:k2"]);
  });

  test("I-19: operator set tenant deny_high_risk_providers → snapshot router memuat opt-out + connector provider unofficial ditandai", async () => {
    await h.sql`insert into connectors (id, key, provider_id, platform_code, runtime, version, enabled) values
      (${tid(0x303)}, 'provu.instagram', ${PROV_UNOFF}, 'instagram', 'python', '0.1.0', false)`;
    const r = await call("PATCH", `/admin/tenants/${T2}`, opTok, { deny_high_risk_providers: true });
    expect(r.status).toBe(200);
    expect((await call("PATCH", `/admin/tenants/${T2}`, adm2, { deny_high_risk_providers: false })).status).toBe(403); // operator saja
    const [t] = await h.sql`select settings from tenants where id = ${T2}`;
    expect(t!.settings).toMatchObject({ deny_high_risk_providers: true });
    const [ev] = await h.sql`select count(*)::int as n from outbox where aggregate = 'tenant' and aggregate_id = ${T2}`;
    expect(ev!.n).toBe(1);
    const url = (await h.sql`select current_database() as d`)[0]!.d as string;
    const db = createDb(
      `${process.env.TEST_PG_URL ?? "postgres://smip_owner:smip_owner_dev@127.0.0.1:55432/postgres"}`.replace(/\/[^/]*$/, `/${url}`),
      { max: 1 },
    );
    try {
      const snap = await loadRoutingSnapshot(db.db, 1);
      expect([...(snap.highRiskOptOut ?? [])]).toEqual([T2]);
      expect(snap.connectors.get(tid(0x303))?.providerHighRisk).toBe(true);
      expect(snap.connectors.get(CONN)?.providerHighRisk).toBe(false);
    } finally {
      await db.close();
    }
  });

  test("audit log mencatat semua mutasi; SEC-02: secret tidak muncul di respons, audit, maupun outbox", async () => {
    const a = await call("GET", "/admin/audit-logs?limit=200", opTok);
    const actions = new Set(a.json.data.map((x: { action: string }) => x.action));
    for (const x of [
      "provider.update",
      "connector.update",
      "connector.health_check",
      "connector.verify",
      "account.create",
      "account.rotate_credential",
      "account.revoke",
      "routing_policy.replace",
      "rate_limit.create",
      "quota.update",
      "dlq.redrive",
      "dlq.discard",
    ])
      expect(actions.has(x)).toBe(true);
    const dump = JSON.stringify([await h.sql`select * from audit_logs`, await h.sql`select * from outbox`]);
    for (const hay of [...bodies, dump]) expect(hay).not.toContain("SANGATRAHASIA");
  });
});
