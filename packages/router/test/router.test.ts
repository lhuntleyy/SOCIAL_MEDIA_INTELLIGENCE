// I-10/I-11 integrasi (Postgres + Redis compose): Router nyata (snapshot PG, reservasi Redis, health, efek ke PG)
// dengan dua connector palsu yang diskenariokan — R-06, R-07, R-08 (TESTING.md).
// Loop run di bawah ini = versi minimal worker-dispatch (I-13 akan memakai pola yang sama).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ConnectorError } from "@smip/connector-sdk";
import type { AttemptContext, RouteInput } from "@smip/core";
import {
  createDb,
  loadRoutingSnapshot,
  markAccountAttention,
  markCapabilityFailed,
  publishOutbox,
  reactivateCooledAccounts,
  setAccountCooldown,
  up,
  upsertProviderHealth,
} from "@smip/db";
import postgres from "postgres";
import { type Effect, failureBackoffSec, HealthCache, HealthMonitor, RedisReserver, Router, SnapshotStore } from "../src";

const PG = process.env.TEST_PG_URL ?? "postgres://smip_owner:smip_owner_dev@127.0.0.1:55432/postgres";
const REDIS = process.env.TEST_REDIS_CACHE_URL ?? "redis://127.0.0.1:56380";
const infraUp = await (async () => {
  try {
    const s = postgres(PG, { connect_timeout: 2, onnotice: () => {} });
    await s`select 1`;
    await s.end();
    const r = new Bun.RedisClient(REDIS, { connectionTimeout: 2000, autoReconnect: false });
    await r.ping();
    r.close();
    return true;
  } catch {
    return false;
  }
})();

const id = (n: number) => `0192f000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const T_A = id(0xa);
const C = { a: id(0x11), b: id(0x21) };
const ACC = { a: id(0x13), b: id(0x23) };
const POL = id(0x30);
const PREFIX = `test:${Date.now()}:router:`;

type Script = (attempt: number) => Promise<{ items: number }>;

describe.skipIf(!infraUp)("Router end-to-end (R-06..R-08)", () => {
  const name = `smip_rtr_${Date.now()}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  let created: ReturnType<typeof createDb>;
  let redis: Bun.RedisClient;
  let router: Router;
  let store: SnapshotStore;
  const alerts: Extract<Effect, { kind: "alert" }>[] = [];
  const bus = { publish: (c: string, m: string) => redis.publish(PREFIX + c, m), incr: (k: string) => redis.incr(PREFIX + k) };

  beforeAll(async () => {
    admin = postgres(PG, { onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const url = PG.replace(/\/[^/]*$/, `/${name}`);
    sql = postgres(url, { onnotice: () => {} });
    await up(sql);
    await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE smip_system`;
      await tx`insert into platforms (code, name, icon, content_types, enabled, sort_order) values ('x', 'X', 'x', '{post}', true, 1)`;
      await tx`insert into tenants (id, name, slug) values (${T_A}, 'A', 'a')`;
      for (const [k, base] of [
        ["a", 0x10],
        ["b", 0x20],
      ] as const) {
        const prov = id(base);
        await tx`insert into providers (id, key, name, kind, risk_level, enabled) values (${prov}, ${`fake_${k}`}, ${k}, 'third_party', 'low', true)`;
        await tx`insert into connectors (id, key, provider_id, platform_code, runtime, version, enabled) values (${C[k]}, ${`fake_${k}.x`}, ${prov}, 'x', 'bun', '1', true)`;
        await tx`insert into connector_capabilities (connector_id, operation, declared, status, verified_at, evidence_ref)
          values (${C[k]}, 'search_keyword', ${tx.json({ query_features: ["term"] })}, 'verified', now(), 'test')`;
        await tx`insert into credentials (id, kind, ciphertext, iv, wrapped_dek, kek_id, aad, fingerprint)
          values (${id(base + 2)}, 'api_key', '\\x00', ${Buffer.alloc(12)}, '\\x00', 'v1', 'aad', '\\x00')`;
        await tx`insert into provider_accounts (id, provider_id, label, credential_id) values (${ACC[k]}, ${prov}, ${k}, ${id(base + 2)})`;
      }
      await tx`insert into routing_policies (id, platform_code, operation, max_attempts) values (${POL}, 'x', 'search_keyword', 3)`;
      await tx`insert into routing_rules (id, policy_id, connector_id, priority, weight, enabled) values (${id(0x31)}, ${POL}, ${C.a}, 1, 100, true), (${id(0x32)}, ${POL}, ${C.b}, 2, 100, true)`;
    });
    created = createDb(url, { max: 4 });
    redis = new Bun.RedisClient(REDIS);
    store = new SnapshotStore((v) => loadRoutingSnapshot(created.db, v), { get: (k) => redis.get(PREFIX + k) }, { pollMs: 0 });
    const monitor = new HealthMonitor(redis, { prefix: PREFIX });
    const health = new HealthCache(monitor);
    const db = created.db;
    router = new Router({
      snapshots: store,
      reserver: new RedisReserver(redis, { prefix: PREFIX }),
      health,
      monitor,
      effects: {
        accountAttention: (acc, code) => markAccountAttention(db, acc, code),
        accountCooldown: (acc, until, code) => setAccountCooldown(db, acc, new Date(until), code),
        capabilityFailed: (c, op) => markCapabilityFailed(db, c, op),
        alert: async (e) => void alerts.push(e),
      },
    });
  });
  afterAll(async () => {
    const keys = (await redis.send("KEYS", [`${PREFIX}*`])) as string[];
    if (keys.length) await redis.send("DEL", keys);
    redis?.close();
    await created?.close();
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin?.end();
  });

  const input = (o: Partial<RouteInput> = {}): RouteInput => ({
    tenantId: T_A,
    platform: "x",
    operation: "search_keyword",
    runKind: "incremental",
    requiredFeatures: ["term"],
    intervalSec: 300,
    excludeConnectorIds: [],
    excludeAccountIds: [],
    estimatedUnits: { requests: 1, results: 20 },
    ...o,
  });

  /** Loop run minimal: plan → panggil connector → reportOutcome → ikuti keputusan. */
  async function runOnce(scripts: Record<"a" | "b", Script>) {
    const inp = input();
    const attempts: string[] = [];
    let ctx: AttemptContext = { policyId: POL, operation: "search_keyword", attempt: 0, sameRetries: 0, recompiled: false };
    for (;;) {
      const d = await router.plan(inp);
      if (d.kind === "none_available") return { status: "failed" as const, reason: d.reason, attempts };
      const key = d.connectorKey === "fake_a.x" ? "a" : "b";
      ctx = { ...ctx, policyId: d.policyId, attempt: ctx.attempt + 1 };
      attempts.push(key);
      const t0 = performance.now();
      try {
        const r = await scripts[key](ctx.attempt);
        await router.reportOutcome(
          {
            reservationId: d.reservationId,
            connectorId: d.connectorId,
            accountId: d.accountId,
            ok: true,
            latencyMs: performance.now() - t0,
            usage: { requests: 1, results: r.items, costUnits: null },
          },
          ctx,
        );
        return { status: "succeeded" as const, attempts };
      } catch (e) {
        const ce = e as ConnectorError;
        const dec = await router.reportOutcome(
          {
            reservationId: d.reservationId,
            connectorId: d.connectorId,
            accountId: d.accountId,
            ok: false,
            errorCode: ce.code,
            errorScope: ce.scope,
            retryAfterMs: ce.retryAfterMs,
            latencyMs: performance.now() - t0,
          },
          ctx,
        );
        if (dec.action === "fail") return { status: "failed" as const, reason: dec.reason, attempts };
        if (dec.action === "failover") {
          ctx = { ...ctx, sameRetries: 0 };
          if (dec.excludeConnectorId) inp.excludeConnectorIds.push(dec.excludeConnectorId);
          if (dec.excludeAccountId) inp.excludeAccountIds.push(dec.excludeAccountId);
        }
        if (dec.action === "retry_same") ctx = { ...ctx, sameRetries: ctx.sameRetries + 1 };
      }
    }
  }
  const ok: Script = async () => ({ items: 5 });
  const err =
    (code: ConnectorError["code"], retryAfterMs?: number): Script =>
    async () => {
      throw new ConnectorError(code, `simulasi ${code}`, { retryAfterMs });
    };

  test("R-06 fake-a RATE_LIMITED → attempt ke fake-b dalam run yang sama; rl:dyn fake-a terset", async () => {
    const r = await runOnce({ a: err("RATE_LIMITED", 30_000), b: ok });
    expect(r).toEqual({ status: "succeeded", attempts: ["a", "b"] });
    const until = Number(await redis.get(`${PREFIX}rl:dyn:${ACC.a}`));
    expect(until - Date.now()).toBeGreaterThan(25_000);
    // run berikutnya langsung ke b (akun a masih di-throttle) — tanpa mencoba a
    expect(await runOnce({ a: err("UNKNOWN"), b: ok })).toEqual({ status: "succeeded", attempts: ["b"] });
    await redis.del(`${PREFIX}rl:dyn:${ACC.a}`);
  });

  test("R-08 semua connector gagal → run failed; backoff next_run_at dihitung", async () => {
    const r = await runOnce({ a: err("TIMEOUT"), b: err("TIMEOUT") });
    expect(r.status).toBe("failed");
    expect(r.attempts).toEqual(["a", "b"]);
    expect(r.reason).toBe("NO_CANDIDATE"); // semua connector sudah di-exclude
    // 5xx: retry sekali di connector sama, lalu failover, lalu max_attempts (3) habis
    const r2 = await runOnce({ a: err("UPSTREAM_5XX"), b: err("UPSTREAM_5XX") });
    expect(r2).toEqual({ status: "failed", reason: "UPSTREAM_5XX: max_attempts (3) habis", attempts: ["a", "a", "b"] });
    expect(failureBackoffSec(300, 2)).toBe(600);
  });

  test("R-07 fake-a AUTH_INVALID → akun needs_attention, failover, alert; snapshot berikutnya mengecualikan akun", async () => {
    const r = await runOnce({ a: err("AUTH_INVALID"), b: ok });
    expect(r).toEqual({ status: "succeeded", attempts: ["a", "b"] });
    const [acc] = await sql`select status, attention_reason from provider_accounts where id = ${ACC.a}`;
    expect(acc).toEqual({ status: "needs_attention", attention_reason: "AUTH_INVALID" });
    expect(alerts.map((a) => [a.event, a.accountId])).toEqual([["account_needs_attention", ACC.a]]);
    // outbox → cfg:version → snapshot baru: akun a tidak eligible lagi
    expect(await publishOutbox(created.db, bus)).toBeGreaterThanOrEqual(1);
    const sim = await router.simulate(input());
    expect(sim.trace.map((t) => [t.connectorKey, t.eliminatedBy ?? "ok"])).toEqual([
      ["fake_a.x", "NO_ELIGIBLE_ACCOUNT"],
      ["fake_b.x", "ok"],
    ]);
  });
  test("adapter efek: BLOCKED cooldown → aktif lagi setelah lewat; NOT_SUPPORTED → capability failed; provider_health + health_checks", async () => {
    const r = await runOnce({ a: ok, b: err("NOT_SUPPORTED") }); // a masih needs_attention (R-07) → langsung b
    expect(r).toMatchObject({ status: "failed", attempts: ["b"] });
    const [cap] = await sql`select status from connector_capabilities where connector_id = ${C.b}`;
    expect(cap!.status).toBe("failed");
    await setAccountCooldown(created.db, ACC.b, new Date(Date.now() - 1000), "BLOCKED");
    expect((await sql`select status from provider_accounts where id = ${ACC.b}`)[0]!.status).toBe("cooling_down");
    expect(await reactivateCooledAccounts(created.db)).toBe(1);
    expect((await sql`select status from provider_accounts where id = ${ACC.b}`)[0]!.status).toBe("active");
    await upsertProviderHealth(
      created.db,
      [
        {
          connectorId: C.a,
          accountId: ACC.a,
          state: "unhealthy",
          circuit: "open",
          score: 10,
          successRate5m: 0.1,
          p95LatencyMs: 900,
          lastErrorCode: "TIMEOUT",
          openedAt: new Date(),
          nextProbeAt: null,
        },
      ],
      [
        {
          connectorId: C.a,
          accountId: ACC.a,
          ok: false,
          kind: "passive_window",
          errorCode: "TIMEOUT",
          details: { from: "closed", to: "open" },
        },
      ],
    );
    const [h] = await sql`select state, circuit, score from provider_health where connector_id = ${C.a}`;
    expect(h).toEqual({ state: "unhealthy", circuit: "open", score: 10 });
    const [hc] = await sql`select ok, jsonb_typeof(details) as t, details->>'to' as to from health_checks`;
    expect(hc).toEqual({ ok: false, t: "object", to: "open" });
  });
});
