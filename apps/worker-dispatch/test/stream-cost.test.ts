// I-25 integrasi (Postgres + Redis-cache): P-20 atribusi biaya run collection stream ke tenant.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { scopeKey } from "@smip/core";
import { applyCostAllocations, createDb, finalizeRunIfDone, up, withSystem } from "@smip/db";
import { periodInfo, RedisReserver, type Snapshot } from "@smip/router";
import postgres from "postgres";

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
const [A, B] = [id(1), id(2)];

describe.skipIf(!infraUp)("I-25 atribusi biaya collection stream", () => {
  const name = `smip_cost_${Date.now()}`;
  const prefix = `cost${Date.now()}:`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  let created: ReturnType<typeof createDb>;
  let redis: Bun.RedisClient;
  let seq = 0x100;

  /** Stream beranggota query tenant A & B + run processing dgn attempt ber-usage. */
  async function streamRun(
    tenantMatches: Record<string, number>,
    attempts: { requests: number; results: number; costUnits: number | null }[],
  ) {
    const stream = id(++seq);
    const run = id(++seq);
    await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE smip_system`;
      await tx`insert into collection_streams (id, platform_code, operation, stream_key, interval_class, terms, interval_sec, next_run_at, inflight_run_id)
        values (${stream}, 'x', 'search_keyword', ${Buffer.from(stream)}, 900, '{kopdes}', 900, now(), ${run})`;
      for (const [t, q] of [
        [A, id(0x10)],
        [B, id(0x20)],
      ] as const) {
        await tx`insert into stream_topic_links (stream_id, tenant_id, topic_query_id) values (${stream}, ${t}, ${q})`;
      }
      await tx`insert into crawl_runs (id, collection_stream_id, scheduled_for, kind, status, pending_batches, tenant_matches, window_from, window_to)
        values (${run}, ${stream}, date_trunc('milliseconds', now()), 'incremental', 'processing', 0, ${tx.json(tenantMatches)}, now() - interval '1 hour', now())`;
      const [r] = await tx`select scheduled_for from crawl_runs where id = ${run}`;
      for (const [k, u] of attempts.entries()) {
        await tx`insert into provider_attempts (id, crawl_run_id, crawl_run_scheduled_for, connector_id, attempt_no, started_at, outcome, usage)
          values (${Bun.randomUUIDv7()}, ${run}, ${r!.scheduled_for}, ${id(0x99)}, ${k + 1}, now(), 'success', ${tx.json(u as never)})`;
      }
    });
    return { stream, run };
  }
  const allocs = (run: string) =>
    sql`select tenant_id, cost_units::float8 as cost, requests::float8 as req, results::float8 as res, matches, basis from cost_allocations where run_id = ${run} order by tenant_id`;

  beforeAll(async () => {
    admin = postgres(PG, { onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const url = PG.replace(/\/[^/]*$/, `/${name}`);
    sql = postgres(url, { onnotice: () => {} });
    await up(sql);
    await sql`insert into platforms (code, name, icon, content_types, enabled) values ('x', 'X', 'x', '{post}', true)`;
    await sql`insert into tenants (id, slug, name) values (${A}, 'a', 'A'), (${B}, 'b', 'B')`;
    for (const [t, topic, q] of [
      [A, id(0x11), id(0x10)],
      [B, id(0x21), id(0x20)],
    ] as const) {
      await sql`insert into topics (id, tenant_id, name) values (${topic}, ${t}, ${`t${topic.slice(-2)}`})`;
      await sql`insert into topic_queries (id, tenant_id, topic_id, kind, query_text, query_ast, ast_hash) values (${q}, ${t}, ${topic}, 'main', 'kopdes', '{}', '\\x00')`;
    }
    created = createDb(url, { max: 4 });
    redis = new Bun.RedisClient(REDIS);
  });
  afterAll(async () => {
    const keys = (await redis.send("KEYS", [`${prefix}*`])) as string[];
    if (keys.length) await redis.send("DEL", keys);
    redis?.close();
    await created?.close();
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin?.end();
  });

  test("P-20: 30 match tenant A, 10 match tenant B → biaya run teralokasi 75/25; total = biaya run (persis)", async () => {
    const { stream, run } = await streamRun({ [A]: 30, [B]: 10 }, [
      { requests: 3, results: 30, costUnits: 0.3 },
      { requests: 1, results: 12, costUnits: 0.1 },
    ]);
    expect((await withSystem(created.db, (tx) => finalizeRunIfDone(tx, run)))?.outcome).toBe("succeeded");
    const rows = await allocs(run);
    expect(rows.map((r) => [r.tenant_id, r.cost, r.req, r.res, r.matches, r.basis])).toEqual([
      [A, 0.3, 3, 31.5, 30, "matches"],
      [B, 0.1, 1, 10.5, 10, "matches"],
    ]);
    expect(rows.reduce((a, r) => a + r.cost, 0)).toBeCloseTo(0.4, 12);
    const [s] = await sql`select inflight_run_id from collection_streams where id = ${stream}`;
    expect(s!.inflight_run_id).toBeNull();
    // idempoten: finalize ulang tidak menggandakan alokasi
    await withSystem(created.db, (tx) => finalizeRunIfDone(tx, run));
    expect(await allocs(run)).toHaveLength(2);
  });

  test("tanpa match → dibagi rata ke tenant anggota stream (even_split); pembulatan: Σ = total", async () => {
    const { run } = await streamRun({}, [{ requests: 1, results: 0, costUnits: 0.1 }]);
    await withSystem(created.db, (tx) => finalizeRunIfDone(tx, run));
    const rows = await allocs(run);
    expect(rows.map((r) => [r.basis, r.matches])).toEqual([
      ["even_split", 0],
      ["even_split", 0],
    ]);
    expect(rows.reduce((a, r) => a + r.cost, 0)).toBeCloseTo(0.1, 12);
  });

  test("alokasi diterapkan ke counter quota tenant di Redis (hard quota ikut menghitung biaya stream); ulang = idempoten", async () => {
    const reserver = new RedisReserver(redis, { prefix });
    const snap = {
      version: 1,
      loadedAt: new Date(),
      policies: new Map(),
      connectors: new Map(),
      accountsByProvider: new Map(),
      rateLimits: new Map(),
      quotas: new Map([
        [
          scopeKey("tenant", A),
          [
            {
              id: "qa",
              scopeType: "tenant",
              scopeId: A,
              period: "month",
              unit: "cost_units",
              limit: 5,
              hard: true,
              alertThresholds: [],
              resetTz: "UTC",
            },
            {
              id: "qb",
              scopeType: "tenant",
              scopeId: A,
              period: "day",
              unit: "results",
              limit: 1000,
              hard: false,
              alertThresholds: [],
              resetTz: "UTC",
            },
          ],
        ],
      ]),
    } as unknown as Snapshot;
    const apply = (a: Parameters<RedisReserver["applyTenantUsage"]>[1]) => reserver.applyTenantUsage(snap, a).then(() => {});
    expect(await applyCostAllocations(created.db, apply)).toBe(4); // 2 run × 2 tenant
    const month = periodInfo("month", "UTC", new Date()).start;
    const day = periodInfo("day", "UTC", new Date()).start;
    expect(Number(await redis.send("HGET", [`${prefix}quota:tenant:${A}:${month}:cost_units`, "used"]))).toBeCloseTo(0.35, 9); // 0,3 + 0,05
    expect(Number(await redis.send("HGET", [`${prefix}quota:tenant:${A}:${day}:results`, "used"]))).toBeCloseTo(31.5, 9);
    await sql`update cost_allocations set applied_at = null`; // simulasi crash sebelum penanda PG ter-commit
    await applyCostAllocations(created.db, apply);
    expect(Number(await redis.send("HGET", [`${prefix}quota:tenant:${A}:${month}:cost_units`, "used"]))).toBeCloseTo(0.35, 9);
    expect(await applyCostAllocations(created.db, apply)).toBe(0);
  });
});
