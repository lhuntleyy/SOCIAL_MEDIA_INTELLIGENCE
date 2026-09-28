// I-13 end-to-end (Postgres + Redis-queue + Redis-cache compose): scheduler tick → relay outbox → BullMQ →
// worker-dispatch → worker-fetch-bun (FakeConnector) → fetch.result → pipeline.items. Tanpa provider eksternal.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { CanonicalItem } from "@smip/contracts";
import { CrawlDispatchPayload, FetchRequestPayload, FetchResultPayload, PipelineItemsPayload } from "@smip/contracts";
import { FakeConnector, fakeItem } from "@smip/connector-fake";
import { credentialAad, LocalDevKms, seal } from "@smip/crypto";
import {
  createDb,
  finalizeRunIfDone,
  withSystem,
  loadRoutingSnapshot,
  markAccountAttention,
  markCapabilityFailed,
  publishOutbox,
  setAccountCooldown,
  up,
} from "@smip/db";
import { astHash, compileQuery } from "@smip/query";
import { BullMqQueue } from "@smip/queue";
import { HealthCache, HealthMonitor, RedisReserver, Router, SnapshotStore } from "@smip/router";
import { jobRelay, schedulerTick } from "@smip/scheduler";
import { MemoryBlobStore } from "@smip/storage";
import { dbAccountLoader, fetchAndReport } from "@smip/worker-fetch-bun";
import postgres from "postgres";
import { type DispatchDeps, handleDispatch, handleFetchResult } from "../src";

const PG = process.env.TEST_PG_URL ?? "postgres://smip_owner:smip_owner_dev@127.0.0.1:55432/postgres";
const REDIS_CACHE = process.env.TEST_REDIS_CACHE_URL ?? "redis://127.0.0.1:56380";
const REDIS_QUEUE = process.env.TEST_REDIS_QUEUE_URL ?? "redis://127.0.0.1:56379";
const infraUp = await (async () => {
  try {
    const s = postgres(PG, { connect_timeout: 2, onnotice: () => {} });
    await s`select 1`;
    await s.end();
    for (const u of [REDIS_CACHE, REDIS_QUEUE]) {
      const r = new Bun.RedisClient(u, { connectionTimeout: 2000, autoReconnect: false });
      await r.ping();
      r.close();
    }
    return true;
  } catch {
    return false;
  }
})();

const id = (n: number) => `0192f000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const T = id(1);
const TOPIC = id(2);
const QUERY = id(3);
const PLAN = id(4);
const C = { a: id(0x11), b: id(0x21) };
const ACC = { a: id(0x13), b: id(0x23) };
const POL = id(0x30);

describe.skipIf(!infraUp)("I-13 alur run end-to-end dengan connector fake", () => {
  const name = `smip_e2e_${Date.now()}`;
  const prefix = `e2e${Date.now()}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  let created: ReturnType<typeof createDb>;
  let cache: Bun.RedisClient;
  let queue: BullMqQueue;
  const subs: { close(g?: number): Promise<void> }[] = [];
  const blobs = new MemoryBlobStore();
  const fakes = { a: new FakeConnector({ platform: "x", variant: "a" }), b: new FakeConnector({ platform: "x", variant: "b" }) };
  const pipelineJobs: PipelineItemsPayload[] = [];
  const kms = new LocalDevKms({ v1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64") });
  let deps: DispatchDeps;

  /** Pompa relay outbox sampai kondisi terpenuhi (worker berjalan di consumer BullMQ in-process). */
  async function pump(done: () => Promise<boolean>, timeoutMs = 10_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await publishOutbox(created.db, { publish: async () => 0, incr: async () => 0 }, { enqueue: jobRelay(queue) });
      if (await done()) return;
      await Bun.sleep(40);
    }
    throw new Error("timeout menunggu kondisi e2e");
  }
  const runRow = async () =>
    (
      await sql`select id, status, attempts, items_fetched, error_code, final_connector_id from crawl_runs order by scheduled_for desc limit 1`
    )[0]!;
  const attempts = async (runId: string) =>
    (
      await sql`select c.key, a.outcome, a.error_code, a.items from provider_attempts a join connectors c on c.id = a.connector_id where a.crawl_run_id = ${runId} order by a.attempt_no`
    ).map((r) => [r.key, r.outcome, r.error_code, r.items]);
  const items = (from: number, n: number): CanonicalItem[] =>
    Array.from({ length: n }, (_, i) => fakeItem("x", from + i, { published_at: new Date(Date.now() - (i + 1) * 60_000).toISOString() }));

  beforeAll(async () => {
    admin = postgres(PG, { onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const url = PG.replace(/\/[^/]*$/, `/${name}`);
    sql = postgres(url, { onnotice: () => {} });
    await up(sql);
    const compiled = compileQuery({ query_text: '"koperasi merah putih" OR kopdes' });
    await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE smip_system`;
      await tx`insert into platforms (code, name, icon, content_types, enabled) values ('x', 'X', 'x', '{post}', true)`;
      await tx`insert into tenants (id, slug, name) values (${T}, 'a', 'A')`;
      await tx`insert into topics (id, tenant_id, name) values (${TOPIC}, ${T}, 'KDMP')`;
      await tx`insert into topic_queries (id, tenant_id, topic_id, kind, query_text, query_ast, ast_hash)
        values (${QUERY}, ${T}, ${TOPIC}, 'main', 'x', ${tx.json(compiled.ast as never)}, ${Buffer.from(await astHash(compiled))})`;
      await tx`insert into crawl_plans (id, tenant_id, topic_id, topic_query_id, platform_code, operation, interval_sec, next_run_at, priority)
        values (${PLAN}, ${T}, ${TOPIC}, ${QUERY}, 'x', 'search_keyword', 900, now() + interval '1 day', 0)`;
      for (const [k, base] of [
        ["a", 0x10],
        ["b", 0x20],
      ] as const) {
        const prov = id(base);
        const credId = id(base + 2);
        await tx`insert into providers (id, key, name, kind, risk_level, enabled) values (${prov}, ${`fake_${k}`}, ${k}, 'third_party', 'low', true)`;
        await tx`insert into connectors (id, key, provider_id, platform_code, runtime, version, enabled) values (${C[k]}, ${`fake.x.${k}`}, ${prov}, 'x', 'bun', '0.1.0', true)`;
        // a: hanya "term" (tanpa OR) → dua sub-query; b: sintaks penuh → satu query eksak
        const features = k === "a" ? ["term", "phrase"] : ["term", "phrase", "or", "and", "not", "group"];
        await tx`insert into connector_capabilities (connector_id, operation, declared, status, verified_at, evidence_ref)
          values (${C[k]}, 'search_keyword', ${tx.json({ query_features: features, max_query_length: 512, result_order: "desc" })}, 'verified', now(), 'test')`;
        const s = await seal(kms, credentialAad(credId, null), { api_key: `rahasia-${k}` });
        await tx`insert into credentials (id, kind, ciphertext, iv, wrapped_dek, kek_id, aad, fingerprint)
          values (${credId}, 'api_key', ${Buffer.from(s.ciphertext)}, ${Buffer.from(s.iv)}, ${Buffer.from(s.wrapped_dek)}, ${s.kek_id}, ${s.aad}, '\\x00')`;
        await tx`insert into provider_accounts (id, provider_id, label, credential_id) values (${ACC[k]}, ${prov}, ${k}, ${credId})`;
      }
      await tx`insert into routing_policies (id, platform_code, operation, max_attempts) values (${POL}, 'x', 'search_keyword', 3)`;
      await tx`insert into routing_rules (id, policy_id, connector_id, priority, weight, enabled) values
        (${id(0x31)}, ${POL}, ${C.a}, 1, 100, true), (${id(0x32)}, ${POL}, ${C.b}, 2, 100, true)`;
    });
    created = createDb(url, { max: 8 });
    cache = new Bun.RedisClient(REDIS_CACHE);
    queue = new BullMqQueue({ connection: { url: REDIS_QUEUE }, prefix });
    const store = new SnapshotStore((v) => loadRoutingSnapshot(created.db, v), { get: async () => String(Date.now()) }, { pollMs: 0 });
    const monitor = new HealthMonitor(cache, { prefix: `${prefix}:` });
    const reserver = new RedisReserver(cache, { prefix: `${prefix}:` });
    const db = created.db;
    const router = new Router({
      snapshots: store,
      reserver,
      health: new HealthCache(monitor),
      monitor,
      effects: {
        accountAttention: (a, code) => markAccountAttention(db, a, code),
        accountCooldown: (a, until, code) => setAccountCooldown(db, a, new Date(until), code),
        capabilityFailed: (c, op) => markCapabilityFailed(db, c, op),
        alert: async () => {},
      },
    });
    deps = { db, router, snapshots: store, fetch: { pageLimit: 3, maxItems: 100, timeoutMs: 10_000 } };
    const connectors = new Map([
      [fakes.a.manifest.key, fakes.a],
      [fakes.b.manifest.key, fakes.b],
    ]);
    subs.push(
      await queue.consume("crawl.dispatch", async (m) => void (await handleDispatch(deps, m.payload)), {
        parse: CrawlDispatchPayload.parse,
      }),
    );
    const fdeps = { connectors, accounts: dbAccountLoader(db, kms), blobs };
    for (const q of ["fetch.bun", "fetch.resume"] as const) {
      subs.push(
        await queue.consume(q, async (m, ctx) => void (await fetchAndReport(fdeps, queue, m.payload, m.tenant_id, ctx.signal)), {
          parse: FetchRequestPayload.parse,
        }),
      );
    }
    subs.push(
      await queue.consume("fetch.result", async (m) => void (await handleFetchResult(deps, m.payload)), {
        parse: FetchResultPayload.parse,
      }),
    );
    subs.push(await queue.consume("pipeline.items", async (m) => void pipelineJobs.push(m.payload), { parse: PipelineItemsPayload.parse }));
  });
  afterAll(async () => {
    for (const s of subs) await s.close(1000);
    await queue?.close();
    for (const [u, pat] of [
      [REDIS_CACHE, `${prefix}:*`],
      [REDIS_QUEUE, `${prefix}:*`],
    ] as const) {
      const r = new Bun.RedisClient(u);
      const keys = (await r.send("KEYS", [pat])) as string[];
      if (keys.length) await r.send("DEL", keys);
      r.close();
    }
    cache?.close();
    await created?.close();
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin?.end();
  });
  beforeEach(async () => {
    fakes.a.reset();
    fakes.b.reset();
    pipelineJobs.length = 0;
    await sql`update crawl_plans set next_run_at = now() - interval '1 second', inflight_run_id = null`;
    await schedulerTick(created.db);
  });

  test("sukses: 2 sub-query (connector hanya term) × halaman ber-cursor → item unik ke pipeline.items; run processing", async () => {
    fakes.a.script([
      { respond: { items: items(1, 3), nextCursor: "c2" } },
      { respond: { items: items(4, 2), nextCursor: null } },
      { respond: { items: [...items(5, 1), ...items(10, 2)] } }, // sub-query kedua; item 5 duplikat
    ]);
    await pump(async () => pipelineJobs.length > 0 && (await runRow()).status === "processing");
    const run = await runRow();
    expect(run).toMatchObject({ status: "processing", attempts: 1, items_fetched: 7, final_connector_id: C.a });
    expect(fakes.a.calls.map((c) => [c.query?.native, c.cursor])).toEqual([
      ['"koperasi merah putih"', null],
      ['"koperasi merah putih"', "c2"],
      ["kopdes", null],
    ]);
    expect(await attempts(run.id)).toEqual([["fake.x.a", "success", null, 7]]);
    const job = pipelineJobs[0]!;
    expect(job).toMatchObject({ crawl_run_id: run.id, tenant_id: T, topic_id: TOPIC, topic_query_id: QUERY, items_count: 7 });
    expect((await blobs.getJsonl<CanonicalItem>(job.items_ref)).map((i) => i.platform_post_id).length).toBe(7);
    expect((await sql`select inflight_run_id from crawl_plans`)[0]!.inflight_run_id).toBe(run.id); // dibebaskan sink (I-15)
    await sql`update crawl_runs set status = 'succeeded' where id = ${run.id}`;
  });

  test("R-06 e2e: fake-a RATE_LIMITED → attempt ke fake-b dalam run yang sama (satu query eksak)", async () => {
    fakes.a.script([{ fail: { code: "RATE_LIMITED", retryAfterMs: 30_000 } }]);
    fakes.b.script([{ respond: { items: items(20, 2) } }]);
    await pump(async () => (await runRow()).status === "processing");
    const run = await runRow();
    expect(run).toMatchObject({ attempts: 2, items_fetched: 2, final_connector_id: C.b });
    expect(await attempts(run.id)).toEqual([
      ["fake.x.a", "failover_error", "RATE_LIMITED", 0],
      ["fake.x.b", "success", null, 2],
    ]);
    expect(fakes.b.calls.map((c) => c.query?.native)).toEqual(['"koperasi merah putih" OR kopdes']);
    await cache.del(`${prefix}:rl:dyn:${ACC.a}`);
    await sql`update crawl_runs set status = 'succeeded' where id = ${run.id}`;
  });

  test("R-08 e2e: semua gagal → run failed, plan consecutive_failures++ & backoff, inflight dibebaskan", async () => {
    fakes.a.script([{ fail: { code: "TIMEOUT" } }]);
    fakes.b.script([{ fail: { code: "TIMEOUT" } }]);
    await pump(async () => (await runRow()).status === "failed");
    const run = await runRow();
    expect(run).toMatchObject({ status: "failed", attempts: 2, error_code: "NO_CANDIDATE" });
    expect((await attempts(run.id)).map((a) => a[1])).toEqual(["failover_error", "failover_error"]);
    const [p] = await sql`select consecutive_failures, inflight_run_id, next_run_at from crawl_plans`;
    expect(p).toMatchObject({ consecutive_failures: 1, inflight_run_id: null });
    expect(p!.next_run_at.getTime() - Date.now()).toBeGreaterThan(800_000); // backoff ≥ interval
  });

  test("hasil kosong → run succeeded langsung, plan dibebaskan & consecutive_failures direset", async () => {
    await pump(async () => (await runRow()).status === "succeeded");
    expect(await runRow()).toMatchObject({ status: "succeeded", items_fetched: 0 });
    expect((await sql`select consecutive_failures, inflight_run_id from crawl_plans`)[0]).toEqual({
      consecutive_failures: 0,
      inflight_run_id: null,
    });
    expect(pipelineJobs).toHaveLength(0);
  });

  test("pesan fetch.result duplikat/terlambat diabaikan (CAS attempt)", async () => {
    fakes.a.script([{ respond: { items: items(30, 1) } }]);
    await pump(async () => (await runRow()).status === "processing");
    const run = await runRow();
    const dup = {
      crawl_run_id: run.id,
      attempt_no: 1,
      connector_id: C.a,
      provider_account_id: ACC.a,
      reservation_id: "x",
      outcome: "error",
      error: { code: "TIMEOUT", message: "late", retry_after_ms: null, scope: "connector", http_status: null },
      items_ref: null,
      items_count: 0,
      next_cursor: null,
      has_more: false,
      async_handle: null,
      usage: { requests: 1, results: 0, costUnits: null, costUnitLabel: null },
      duration_ms: 1,
      rate_limit_info: { remaining: null, resetAt: null },
    } as const;
    expect(await handleFetchResult(deps, FetchResultPayload.parse(dup))).toBe("ignored");
    expect(await attempts(run.id)).toHaveLength(1);
    await sql`update crawl_runs set status = 'succeeded' where id = ${run.id}`;
  });

  test("hard quota tenant habis → run skipped tanpa memanggil connector; plan tidak dihitung gagal", async () => {
    await sql`insert into quota_policies (id, scope_type, scope_id, period, unit, limit_value, hard) values (${Bun.randomUUIDv7()}, 'tenant', ${T}, 'day', 'requests', 0, true)`;
    await pump(async () => (await runRow()).status === "skipped");
    expect(await runRow()).toMatchObject({ status: "skipped", error_code: "QUOTA_EXHAUSTED" });
    expect(fakes.a.calls.length + fakes.b.calls.length).toBe(0);
    expect((await sql`select consecutive_failures, inflight_run_id from crawl_plans`)[0]).toEqual({
      consecutive_failures: 0,
      inflight_run_id: null,
    });
    await sql`delete from quota_policies`;
  });

  test("async (ASYNC_PENDING): item sebelum jeda diteruskan (part 0), fetch.resume ×2 melanjutkan sub-query → part 2; reservasi & attempt dicatat sekali", async () => {
    fakes.a.script([
      { respond: { items: items(40, 2) } }, // sub-query 0 selesai
      { pending: { pollAfterMs: 20 } }, // sub-query 1: run provider masih berjalan
      { pending: { pollAfterMs: 20 } },
      { respond: { items: items(50, 1) } },
    ]);
    await pump(async () => (await runRow()).status === "processing" && pipelineJobs.length >= 2);
    const run = await runRow();
    expect(run).toMatchObject({ attempts: 1, items_fetched: 3, final_connector_id: C.a });
    expect(fakes.a.resumes).toHaveLength(2);
    expect(pipelineJobs.map((p) => [p.part ?? 0, p.items_count]).sort()).toEqual([
      [0, 2],
      [2, 1], // part = nomor resume yang menghasilkan item (resume ke-1 masih pending)
    ]);
    const att = await sql`select outcome, items, usage from provider_attempts where crawl_run_id = ${run.id}`;
    expect(att.map((a) => [a.outcome, a.items])).toEqual([["success", 1]]);
    expect(att[0]!.usage).toMatchObject({ requests: 4, results: 3 }); // akumulasi semua bagian
    const [r] = await sql`select routing from crawl_runs where id = ${run.id}`;
    expect(r!.routing.resumes).toBe(2);
    await sql`update crawl_runs set status = 'succeeded' where id = ${run.id}`;
  });

  test("P-18: halaman 1–2 sukses, halaman 3 gagal & semua connector habis → partial; watermark diam; celah [since, min(published)] diambil run berikutnya", async () => {
    await sql`update crawl_plans set high_watermark = null, gap_windows = '[]'`;
    const newest = items(60, 2); // halaman 1 (terbaru)
    const older = items(62, 2).map((it, k) => ({ ...it, published_at: new Date(Date.now() - (10 + k) * 60_000).toISOString() })); // halaman 2 (lebih lama)
    fakes.a.script([
      { respond: { items: newest, nextCursor: "p2" } },
      { respond: { items: older, nextCursor: "p3" } },
      { fail: { code: "TIMEOUT" } }, // halaman 3 gagal
    ]);
    fakes.b.script([{ fail: { code: "TIMEOUT" } }]);
    await pump(async () => (await runRow()).status === "processing" && pipelineJobs.length >= 1);
    const run = await runRow();
    expect(run).toMatchObject({ status: "processing", items_fetched: 4, error_code: "NO_CANDIDATE" });
    // hilir (pipeline/sink) selesai → penutupan run
    const minP = older.map((i) => i.published_at).sort()[0]!;
    await sql`update crawl_runs set pending_batches = 0, min_published_at = ${minP}, max_published_at = ${newest[0]!.published_at} where id = ${run.id}`;
    expect((await withSystem(deps.db, (tx) => finalizeRunIfDone(tx, run.id)))?.outcome).toBe("partial");
    const [r] = await sql`select status, window_from from crawl_runs where id = ${run.id}`;
    const [p] = await sql`select high_watermark, gap_windows, inflight_run_id, consecutive_failures from crawl_plans`;
    expect(r!.status).toBe("partial");
    expect(p).toMatchObject({ high_watermark: null, inflight_run_id: null });
    expect(p!.gap_windows).toHaveLength(1);
    expect([p!.gap_windows[0].since, p!.gap_windows[0].until]).toEqual([r!.window_from.toISOString(), new Date(minP).toISOString()]);
    // run berikutnya: incremental + backfill untuk celah (window persis celah → tidak ada post hilang)
    await sql`update crawl_plans set next_run_at = now() - interval '1 second'`;
    expect((await schedulerTick(deps.db)).gapRuns).toBe(1);
    const [gapRun] = await sql`select window_from, window_to from crawl_runs where kind = 'backfill' order by scheduled_for desc limit 1`;
    expect([gapRun!.window_from.toISOString(), gapRun!.window_to.toISOString()]).toEqual([
      r!.window_from.toISOString(),
      new Date(minP).toISOString(),
    ]);
    await sql`update crawl_runs set status = 'succeeded' where status in ('queued', 'dispatching', 'fetching')`;
    await sql`update crawl_plans set gap_windows = '[]', inflight_run_id = null`;
  });
});
