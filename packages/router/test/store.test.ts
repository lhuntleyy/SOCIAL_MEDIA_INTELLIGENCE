// I-06 integrasi (R-12): ubah weight + outbox dalam satu transaksi → publisher INCR cfg:version → snapshot baru
// terlihat ≤ pollMs tanpa restart. Butuh Postgres + Redis-cache compose (`bun run dev:up`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, loadRoutingSnapshot, publishOutbox, up, withSystem, writeOutbox } from "@smip/db";
import { sql as dsql } from "drizzle-orm";
import postgres from "postgres";
import { SnapshotStore } from "../src";

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
const PROV = id(0x10);
const CONN = id(0x11);
const POL = id(0x12);
const RULE = id(0x13);
const PREFIX = `test:${Date.now()}:`; // kunci Redis terisolasi dari worker lain

describe.skipIf(!infraUp)("I-06 snapshot router + invalidasi outbox (integrasi)", () => {
  const name = `smip_router_${Date.now()}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  let created: ReturnType<typeof createDb>;
  let redis: Bun.RedisClient;
  const bus = {
    publish: (c: string, m: string) => redis.publish(PREFIX + c, m),
    incr: (k: string) => redis.incr(PREFIX + k),
  };
  const versions = { get: (k: string) => redis.get(PREFIX + k) };

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
      await tx`insert into providers (id, key, name, kind, risk_level, enabled) values (${PROV}, 'prov', 'Prov', 'third_party', 'medium', true)`;
      await tx`insert into connectors (id, key, provider_id, platform_code, runtime, version, enabled) values (${CONN}, 'prov.x', ${PROV}, 'x', 'bun', '1.0.0', true)`;
      await tx`insert into connector_capabilities (connector_id, operation, declared, measured, status, verified_at, evidence_ref)
        values (${CONN}, 'search_keyword', ${tx.json({ query_features: ["term", "phrase"] })}, ${tx.json({ min_interval_sec: 60, cost_per_1k_results: 0.25 })}, 'verified', now(), 'docs/evidence/test')`;
      for (const [cid, tenant] of [
        [id(0x20), null],
        [id(0x21), T_A],
      ] as const) {
        await tx`insert into credentials (id, tenant_id, kind, ciphertext, iv, wrapped_dek, kek_id, aad, fingerprint)
          values (${cid}, ${tenant}, 'api_key', '\\x00', ${Buffer.alloc(12)}, '\\x00', 'v1', 'aad', '\\x00')`;
        await tx`insert into provider_accounts (id, tenant_id, provider_id, label, credential_id) values (${id(Number.parseInt(cid.slice(-2), 16) + 0x10)}, ${tenant}, ${PROV}, ${tenant ? "byo" : "shared"}, ${cid})`;
      }
      await tx`insert into routing_policies (id, platform_code, operation) values (${POL}, 'x', 'search_keyword')`;
      await tx`insert into routing_rules (id, policy_id, connector_id, priority, weight, enabled) values (${RULE}, ${POL}, ${CONN}, 1, 100, true)`;
    });
    created = createDb(url, { max: 4 });
    redis = new Bun.RedisClient(REDIS);
  });
  afterAll(async () => {
    await redis?.del(`${PREFIX}cfg:version`);
    redis?.close();
    await created?.close();
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin?.end();
  });

  test("loadRoutingSnapshot memetakan policy/rule/capability/akun (shared + BYO)", async () => {
    const s = await loadRoutingSnapshot(created.db, 0);
    const pol = s.policies.get("*|x|search_keyword")!;
    expect(pol).toMatchObject({ id: POL, strategy: "priority_weighted", maxAttempts: 3, allowUnverified: false });
    expect(pol.rules).toEqual([
      { id: RULE, connectorId: CONN, priority: 1, weight: 100, enabled: true, maxSharePct: null, runKinds: null },
    ]);
    const c = s.connectors.get(CONN)!;
    expect(c).toMatchObject({ key: "prov.x", providerEnabled: true, runtime: "bun" });
    expect(c.capabilities.get("search_keyword")).toEqual({
      status: "verified",
      queryFeatures: ["term", "phrase"],
      measured: { minIntervalSec: 60, p95LatencyMs: undefined, costPer1kResults: 0.25 },
    });
    expect((s.accountsByProvider.get(PROV) ?? []).map((a) => [a.label, a.tenantId]).sort()).toEqual([
      ["byo", T_A],
      ["shared", null],
    ]);
  });

  test("R-12: ubah weight + outbox (1 transaksi) → publish → snapshot baru ≤ pollMs tanpa restart", async () => {
    const pollMs = 300;
    const store = new SnapshotStore((v) => loadRoutingSnapshot(created.db, v), versions, { pollMs });
    const first = await store.get();
    expect(first.policies.get("*|x|search_keyword")!.rules[0]!.weight).toBe(100);

    await withSystem(created.db, async (tx) => {
      await tx.execute(dsql`update routing_rules set weight = 5 where id = ${RULE}`);
      await tx.execute(dsql`update routing_policies set version = version + 1 where id = ${POL}`);
      await writeOutbox(tx, { aggregate: "routing_policy", aggregateId: POL, eventType: "rules.updated", payload: { by: "test" } });
    });
    // belum dipublikasikan → cache lama tetap dipakai (tidak ada reload tiap plan)
    expect((await store.get()).version).toBe(first.version);

    const sub = new Bun.RedisClient(REDIS);
    const got: string[] = [];
    await sub.subscribe(`${PREFIX}config.changed`, (m) => got.push(m));
    const t0 = Date.now();
    expect(await publishOutbox(created.db, bus)).toBe(1);
    let snap = await store.get();
    while (snap.policies.get("*|x|search_keyword")!.rules[0]!.weight !== 5 && Date.now() - t0 < 5000) {
      await Bun.sleep(25);
      snap = await store.get();
    }
    const visibleMs = Date.now() - t0;
    expect(snap.policies.get("*|x|search_keyword")!.rules[0]!.weight).toBe(5);
    expect(snap.policies.get("*|x|search_keyword")!.version).toBe(2);
    expect(visibleMs).toBeLessThanOrEqual(pollMs + 200);
    console.info(`R-12: perubahan weight terlihat ${visibleMs} ms setelah publish (pollMs=${pollMs})`);

    await Bun.sleep(50);
    expect(got.map((m) => JSON.parse(m))).toEqual([{ aggregate: "routing_policy", id: POL, event: "rules.updated" }]);
    sub.close();

    // idempoten: tidak ada event tersisa; baris ditandai published; payload jsonb tidak ter-encode ganda
    expect(await publishOutbox(created.db, bus)).toBe(0);
    const [row] = await sql`select published_at is not null as pub, jsonb_typeof(payload) as t, payload->>'by' as by from outbox`;
    expect(row).toEqual({ pub: true, t: "object", by: "test" });
    expect(await redis.get(`${PREFIX}cfg:version`)).toBe("1");
  });

  test("event non-config tidak menaikkan cfg:version", async () => {
    await withSystem(created.db, (tx) => writeOutbox(tx, { aggregate: "topic", aggregateId: id(0x99), eventType: "topic.created" }));
    expect(await publishOutbox(created.db, bus)).toBe(1);
    expect(await redis.get(`${PREFIX}cfg:version`)).toBe("1");
  });
});
