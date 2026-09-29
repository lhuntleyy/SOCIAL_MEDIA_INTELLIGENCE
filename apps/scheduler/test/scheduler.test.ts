// I-12 integrasi (Postgres + Redis compose): tick, coalescing (P-07), reaper (P-10), SKIP LOCKED paralel,
// relay outbox → BullMQ (idempoten), backpressure, run celah, leader lock.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CrawlDispatchPayload } from "@smip/contracts";
import { createDb, EMPTY_COST_GUARD, isThrottled, publishOutbox, up } from "@smip/db";
import { compileQuery } from "@smip/query";
import { BullMqQueue } from "@smip/queue";
import postgres from "postgres";
import { jobRelay, LeaderLock, overlapSec, planStreams, reapStuckRuns, schedulerTick } from "../src";

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
let qn = 0x100;

describe.skipIf(!infraUp)("scheduler (integrasi)", () => {
  const name = `smip_sched_${Date.now()}`;
  const prefix = `test${Date.now()}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  let created: ReturnType<typeof createDb>;
  let cache: Bun.RedisClient;
  let queue: BullMqQueue;
  const bus = { publish: async () => 0, incr: async () => 0 };

  /** Buat topic_query + plan; kembalikan id plan. */
  async function plan(
    o: {
      dueInSec?: number;
      status?: string;
      priority?: number;
      interval?: number;
      hw?: Date;
      gaps?: unknown[];
      inflight?: string;
      query?: string;
    } = {},
  ) {
    const q = id(++qn);
    const p = id(++qn + 0x10000);
    const ast = o.query ? compileQuery({ query_text: o.query }).ast : {};
    await sql`insert into topic_queries (id, tenant_id, topic_id, kind, query_text, query_ast, ast_hash) values (${q}, ${T}, ${TOPIC}, 'sub', 'x', ${sql.json(ast as never)}, '\\x00')`;
    await sql`insert into crawl_plans (id, tenant_id, topic_id, topic_query_id, platform_code, operation, interval_sec, status, next_run_at, priority, high_watermark, gap_windows, inflight_run_id)
      values (${p}, ${T}, ${TOPIC}, ${q}, 'x', 'search_keyword', ${o.interval ?? 900}, ${o.status ?? "active"}, ${new Date(Date.now() + (o.dueInSec ?? -1) * 1000)},
              ${o.priority ?? 0}, ${o.hw ?? null}, ${sql.json((o.gaps ?? []) as never)}, ${o.inflight ?? null})`;
    return p;
  }
  async function run(status: string, agoSec = 0, planId?: string) {
    const r = id(++qn + 0x20000);
    await sql`insert into crawl_runs (id, tenant_id, crawl_plan_id, scheduled_for, kind, status) values (${r}, ${T}, ${planId ?? null}, ${new Date(Date.now() - agoSec * 1000)}, 'incremental', ${status})`;
    return r;
  }
  const runsOf = (p: string) =>
    sql`select id, kind, status, window_from, window_to from crawl_runs where crawl_plan_id = ${p} order by scheduled_for, kind desc`;

  beforeAll(async () => {
    admin = postgres(PG, { onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const url = PG.replace(/\/[^/]*$/, `/${name}`);
    sql = postgres(url, { onnotice: () => {} });
    await up(sql);
    await sql`insert into platforms (code, name, icon, content_types, enabled) values ('x', 'X', 'x', '{post}', true)`;
    await sql`insert into tenants (id, slug, name) values (${T}, 'a', 'A')`;
    await sql`insert into topics (id, tenant_id, name) values (${TOPIC}, ${T}, 'Topik')`;
    created = createDb(url, { max: 6 });
    cache = new Bun.RedisClient(REDIS_CACHE);
    queue = new BullMqQueue({ connection: { url: REDIS_QUEUE }, prefix });
  });
  afterAll(async () => {
    await queue?.close();
    const keys = [
      ...((await cache.send("KEYS", [`${prefix}:*`])) as string[]),
      ...((await cache.send("KEYS", ["test:lock:*"])) as string[]),
    ];
    if (keys.length) await cache.send("DEL", keys);
    const q = new Bun.RedisClient(REDIS_QUEUE);
    const qk = (await q.send("KEYS", [`${prefix}:*`])) as string[];
    if (qk.length) await q.send("DEL", qk);
    q.close();
    cache?.close();
    await created?.close();
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin?.end();
  });

  test("tick: hanya plan aktif jatuh tempo; run queued + inflight + next_run_at ±5%; outbox → BullMQ idempoten", async () => {
    const due = await plan();
    const paused = await plan({ status: "paused" });
    const later = await plan({ dueInSec: 600 });
    const now = new Date();
    const r = await schedulerTick(created.db, { now: () => now, initialLookbackSec: 3600 });
    expect(r).toEqual({
      scheduled: 1,
      coalesced: 0,
      deferred: 0,
      gapRuns: 0,
      gapsAbandoned: {},
      streamsScheduled: 0,
      streamsCoalesced: 0,
      throttled: 0,
      costGuard: { breached: [], throttledNow: [], released: [] },
    });
    const [run1] = await runsOf(due);
    expect(run1).toMatchObject({ kind: "incremental", status: "queued" });
    expect(run1!.window_to.getTime()).toBe(now.getTime());
    expect(run1!.window_from.getTime()).toBe(now.getTime() - 3600_000);
    expect(await runsOf(paused)).toHaveLength(0);
    expect(await runsOf(later)).toHaveLength(0);
    const [p] = await sql`select inflight_run_id, next_run_at, last_run_at from crawl_plans where id = ${due}`;
    expect(p!.inflight_run_id).toBe(run1!.id);
    const delta = (p!.next_run_at.getTime() - now.getTime()) / 1000;
    expect(delta).toBeGreaterThanOrEqual(900 * 0.95);
    expect(delta).toBeLessThanOrEqual(900 * 1.05);

    expect(await publishOutbox(created.db, bus, { enqueue: jobRelay(queue) })).toBe(1);
    const bq = (await import("bullmq")).Queue;
    const q = new bq("crawl.dispatch", { connection: { url: REDIS_QUEUE }, prefix });
    const job = await q.getJob(`run.${run1!.id}.attempt.1`);
    expect(job?.name).toBe("crawl.dispatch");
    const payload = CrawlDispatchPayload.parse(job!.data.payload);
    expect(payload).toMatchObject({
      crawl_run_id: run1!.id,
      crawl_plan_id: due,
      platform: "x",
      run_kind: "incremental",
      attempt_no: 1,
      interval_sec: 900,
    });
    expect(job!.opts.priority).toBe(1);
    // crash sebelum penanda published ter-commit → publish ulang → tetap 1 job
    await sql`update outbox set published_at = null`;
    expect(await publishOutbox(created.db, bus, { enqueue: jobRelay(queue) })).toBe(1);
    expect(await q.getJobCountByTypes("waiting", "prioritized")).toBe(1);
    // relay tanpa enqueuer tidak boleh menelan baris job
    await sql`update outbox set published_at = null`;
    expect(await publishOutbox(created.db, bus)).toBe(0);
    expect((await sql`select count(*)::int as n from outbox where published_at is null`)[0]!.n).toBe(1);
    await sql`update outbox set published_at = now()`;
    await q.close();
    await sql`update crawl_plans set status = 'paused' where id = ${due}`;
  });

  test("window inkremental = high_watermark − overlap (max(60 s, 0,2 × interval))", async () => {
    const hw = new Date(Date.now() - 3_600_000);
    const p = await plan({ hw, interval: 900 });
    await schedulerTick(created.db);
    const [r] = await runsOf(p);
    expect(r!.window_from.getTime()).toBe(hw.getTime() - overlapSec(900) * 1000);
    expect(overlapSec(300)).toBe(60);
    await sql`update crawl_plans set status = 'paused' where id = ${p}`;
  });

  test("P-07 coalescing: run lama belum final → tidak ada run baru; setelah final → run baru", async () => {
    const p = await plan();
    const old = await run("fetching", 30, p);
    await sql`update crawl_plans set inflight_run_id = ${old} where id = ${p}`;
    const r = await schedulerTick(created.db);
    expect(r.coalesced).toBe(1);
    expect(r.scheduled).toBe(0);
    expect(await runsOf(p)).toHaveLength(1);
    const [pl] = await sql`select next_run_at from crawl_plans where id = ${p}`;
    expect(pl!.next_run_at.getTime()).toBeGreaterThan(Date.now());
    await sql`update crawl_runs set status = 'succeeded' where id = ${old}`;
    await sql`update crawl_plans set next_run_at = now() - interval '1 second' where id = ${p}`;
    expect((await schedulerTick(created.db)).scheduled).toBe(1);
    expect(await runsOf(p)).toHaveLength(2);
    await sql`update crawl_plans set status = 'paused' where id = ${p}`;
  });

  test("SKIP LOCKED: dua tick paralel atas 20 plan → tiap plan tepat satu run", async () => {
    const ps = await Promise.all(Array.from({ length: 20 }, () => plan()));
    const [a, b] = await Promise.all([schedulerTick(created.db), schedulerTick(created.db)]);
    expect(a.scheduled + b.scheduled).toBe(20);
    const counts = await sql`select crawl_plan_id, count(*)::int as n from crawl_runs where crawl_plan_id in ${sql(ps)} group by 1`;
    expect(counts.length).toBe(20);
    expect(counts.every((c) => c.n === 1)).toBe(true);
    await sql`update crawl_plans set status = 'paused' where id in ${sql(ps)}`;
  });

  test("backpressure: plan prioritas rendah ditunda, realtime (priority 0) tetap jalan", async () => {
    const low = await plan({ priority: 5, interval: 3600 });
    const rt = await plan({ priority: 0 });
    const r = await schedulerTick(created.db, { backpressure: () => true });
    expect(r).toMatchObject({ scheduled: 1, deferred: 1 });
    expect(await runsOf(low)).toHaveLength(0);
    expect(await runsOf(rt)).toHaveLength(1);
    await sql`update crawl_plans set status = 'paused' where id in ${sql([low, rt])}`;
  });

  test("celah run partial → satu run backfill berprioritas rendah, tidak digandakan tick berikutnya", async () => {
    const gap = { since: "2026-09-27T01:00:00.000Z", until: "2026-09-27T02:00:00.000Z", created_at: new Date().toISOString() };
    const p = await plan({ gaps: [gap] });
    expect((await schedulerTick(created.db)).gapRuns).toBe(1);
    const runs = await runsOf(p);
    expect(runs.map((r) => r.kind).sort()).toEqual(["backfill", "incremental"]);
    const bf = runs.find((r) => r.kind === "backfill")!;
    expect([bf.window_from.toISOString(), bf.window_to.toISOString()]).toEqual([gap.since, gap.until]);
    const [pl] = await sql`select gap_windows from crawl_plans where id = ${p}`;
    expect(pl!.gap_windows).toEqual([{ ...gap, run_id: bf.id }]);
    await sql`update crawl_runs set status = 'succeeded' where crawl_plan_id = ${p}`;
    await sql`update crawl_plans set next_run_at = now() - interval '1 second' where id = ${p}`;
    expect((await schedulerTick(created.db)).gapRuns).toBe(0);
    await sql`update crawl_plans set status = 'paused' where id = ${p}`;
  });

  test("P-10 reaper: run macet → failed/STUCK_RUN, plan dibebaskan dan dijadwalkan lagi; run final tidak disentuh", async () => {
    const p = await plan();
    const stuck = await run("fetching", 20 * 60, p);
    const done = await run("succeeded", 20 * 60, p);
    await sql`update crawl_plans set inflight_run_id = ${stuck} where id = ${p}`;
    expect((await schedulerTick(created.db)).coalesced).toBe(1); // tanpa reaper plan beku
    expect(await reapStuckRuns(created.db, { graceSec: 900 })).toEqual([stuck]);
    const rows = await sql`select id, status, error_code from crawl_runs where id in ${sql([stuck, done])} order by id`;
    expect(rows.map((r) => [r.id, r.status, r.error_code])).toEqual([
      [stuck, "failed", "STUCK_RUN"],
      [done, "succeeded", null],
    ]);
    expect((await sql`select inflight_run_id from crawl_plans where id = ${p}`)[0]!.inflight_run_id).toBeNull();
    await sql`update crawl_plans set next_run_at = now() - interval '1 second' where id = ${p}`;
    expect((await schedulerTick(created.db)).scheduled).toBe(1);
    expect(await reapStuckRuns(created.db, { graceSec: 900 })).toEqual([]); // idempoten

    // review: run celah (backfill) macet → run_id celah dilepas agar dicoba ulang
    const gap = { since: "2026-09-20T01:00:00.000Z", until: "2026-09-20T02:00:00.000Z", created_at: new Date().toISOString() };
    const gp = await plan({ dueInSec: 600 });
    const gr = id(++qn + 0x30000);
    await sql`insert into crawl_runs (id, tenant_id, crawl_plan_id, scheduled_for, kind, status) values (${gr}, ${T}, ${gp}, ${new Date(Date.now() - 2000_000)}, 'backfill', 'fetching')`;
    await sql`update crawl_plans set gap_windows = ${sql.json([{ ...gap, run_id: gr }] as never)} where id = ${gp}`;
    expect(await reapStuckRuns(created.db, { graceSec: 900 })).toEqual([gr]);
    expect((await sql`select gap_windows from crawl_plans where id = ${gp}`)[0]!.gap_windows).toEqual([gap]);
    await sql`update crawl_plans set status = 'paused' where id = ${gp}`;
  });

  test("reaper: run queued yang job dispatch-nya hilang diantrekan ulang (maks. 4×), baru digagalkan setelahnya", async () => {
    const p = await plan({ dueInSec: 600 });
    const lost = id(++qn + 0x40000);
    await sql`insert into crawl_runs (id, tenant_id, crawl_plan_id, scheduled_for, kind, status, window_from, window_to)
      values (${lost}, ${T}, ${p}, ${new Date(Date.now() - 2000_000)}, 'backfill', 'queued', now() - interval '2 days', now() - interval '1 day')`;
    const jobs = async () =>
      (await sql`select payload from outbox where aggregate = 'job' and aggregate_id = ${lost} order by id`).map(
        (r) => r.payload as { idempotencyKey: string; priority: number; payload: { run_kind: string; attempt_no: number } },
      );
    expect(await reapStuckRuns(created.db, { graceSec: 900 })).toEqual([]); // diantrekan ulang, bukan gagal
    let j = await jobs();
    expect(j.map((x) => [x.idempotencyKey, x.priority, x.payload.run_kind, x.payload.attempt_no])).toEqual([
      [`run.${lost}.attempt.1.requeue.1`, 10, "backfill", 1],
    ]);
    expect(await reapStuckRuns(created.db, { graceSec: 900 })).toEqual([]); // baru diantrekan → belum lewat grace lagi
    expect(await jobs()).toHaveLength(1);
    // setelah 4 kali (masing-masing lewat grace) → STUCK_RUN
    for (let i = 2; i <= 4; i++) {
      await sql`update crawl_runs set routing = routing || jsonb_build_object('requeued_at', (now() - interval '1 hour')::text) where id = ${lost}`;
      expect(await reapStuckRuns(created.db, { graceSec: 900 })).toEqual([]);
    }
    j = await jobs();
    expect(j.map((x) => x.idempotencyKey.split(".").at(-1))).toEqual(["1", "2", "3", "4"]);
    await sql`update crawl_runs set routing = routing || jsonb_build_object('requeued_at', (now() - interval '1 hour')::text) where id = ${lost}`;
    expect(await reapStuckRuns(created.db, { graceSec: 900 })).toEqual([lost]);
    // run yang sudah pernah di-dispatch (attempts > 0) tidak diantrekan ulang
    const tried = id(++qn + 0x40000);
    await sql`insert into crawl_runs (id, tenant_id, crawl_plan_id, scheduled_for, kind, status, attempts) values (${tried}, ${T}, ${p}, ${new Date(Date.now() - 2000_000)}, 'incremental', 'queued', 1)`;
    expect(await reapStuckRuns(created.db, { graceSec: 900 })).toEqual([tried]);
    await sql`update crawl_plans set status = 'paused' where id = ${p}`;
  });

  test("leader lock: satu pemimpin; pemilik memperpanjang; lock kedaluwarsa diambil replika lain", async () => {
    const key = `test:lock:${Date.now()}`;
    const a = new LeaderLock(cache, { key, ttlMs: 300 });
    const b = new LeaderLock(cache, { key, ttlMs: 300 });
    expect([await a.ensure(), await b.ensure()]).toEqual([true, false]);
    expect(await a.ensure()).toBe(true); // perpanjang
    await Bun.sleep(400); // a "macet" melewati ttl
    expect(await b.ensure()).toBe(true);
    expect(await a.ensure()).toBe(false); // a tidak boleh memperpanjang lock milik b
    await b.release();
    expect(await a.ensure()).toBe(true);
    await a.release();
  });

  test("I-24: celah melewati max_gap_age dibuang & dihitung per platform; celah muda / sedang diambil dipertahankan", async () => {
    const now = new Date();
    const old = {
      since: "2026-09-20T01:00:00.000Z",
      until: "2026-09-20T02:00:00.000Z",
      created_at: new Date(now.getTime() - 30 * 3600_000).toISOString(),
    };
    const oldRunning = { ...old, run_id: id(0xeeee) };
    const young = { ...old, created_at: new Date(now.getTime() - 3600_000).toISOString() };
    const p = await plan({ gaps: [old, oldRunning, young], dueInSec: 600 });
    const r = await schedulerTick(created.db, { now: () => now, maxGapAgeSec: 86_400 });
    expect(r.gapsAbandoned).toEqual({ x: 1 });
    const [pl] = await sql`select gap_windows from crawl_plans where id = ${p}`;
    expect(pl!.gap_windows).toEqual([oldRunning, young]);
    expect((await schedulerTick(created.db, { now: () => now, maxGapAgeSec: 86_400 })).gapsAbandoned).toEqual({});
    await sql`update crawl_plans set status = 'paused' where id = ${p}`;
  });

  test("I-22: stream mengambil alih plan anggota; query dinonaktifkan → stream dilepas, plan mewarisi watermark stream & jalan lagi", async () => {
    await sql`update crawl_plans set status = 'paused' where status = 'active'`; // isolasi dari tes sebelumnya
    const a = await plan({ query: "banjir OR bencana" });
    const b = await plan({ query: "bencana OR gempa" });
    expect(await planStreams(created.db)).toMatchObject({ created: 1, links: 2 });
    const tick = await schedulerTick(created.db);
    expect([tick.scheduled, tick.streamsScheduled]).toEqual([0, 1]);
    const [s1] = await sql`select id from collection_streams where enabled`;
    const hw = new Date(Date.now() - 600_000);
    await sql`update collection_streams set high_watermark = ${hw} where id = ${s1!.id}`;
    const [qb] = await sql`select topic_query_id from crawl_plans where id = ${b}`;
    await sql`update topic_queries set enabled = false where id = ${qb!.topic_query_id}`;
    await sql`update crawl_plans set status = 'disabled' where id = ${b}`; // seperti SyncCrawlPlans (API) saat query dimatikan
    expect(await planStreams(created.db)).toMatchObject({ active: 0, retired: 1 });
    const [pa] = await sql`select high_watermark from crawl_plans where id = ${a}`;
    expect(pa!.high_watermark.getTime()).toBe(hw.getTime()); // mewarisi watermark stream → tidak fetch ulang dari awal
    expect((await sql`select count(*)::int as n from stream_topic_links`)[0]!.n).toBe(0);
    await sql`update crawl_plans set next_run_at = now() - interval '1 second' where id = ${a}`;
    expect((await schedulerTick(created.db)).scheduled).toBe(1); // kembali jadi plan biasa
    await sql`update crawl_plans set status = 'paused' where id in ${sql([a, b])}`;
  });

  test("P-16 cost guard: soft cap tercapai → interval di-throttle ke 1 jam, run TETAP dibuat; alert sekali; override admin → normal", async () => {
    await sql`update crawl_plans set status = 'paused' where status = 'active'`;
    const a = await plan({ interval: 900 });
    const Q = id(0x7001);
    await sql`insert into quota_policies (id, scope_type, scope_id, period, unit, limit_value, hard, reset_tz)
      values (${Q}, 'tenant', ${T}, 'month', 'cost_units', 1, false, 'Asia/Jakarta')`;
    await sql`insert into quota_usage (scope_type, scope_id, period, period_start, unit, used, reserved)
      values ('tenant', ${T}, 'month', date_trunc('month', now() at time zone 'Asia/Jakarta')::date, 'cost_units', 1.5, 0)`;
    const now = new Date();
    const r = await schedulerTick(created.db, { now: () => now, costGuard: { throttleIntervalSec: 3600 } });
    expect(r.scheduled).toBe(1); // ingestion tidak berhenti
    expect(r.throttled).toBe(1);
    expect(r.costGuard.throttledNow.map((x) => [x.id, x.scope_type, x.used, x.limit])).toEqual([[Q, "tenant", 1.5, 1]]);
    const next = async () => {
      const [p] = await sql`select next_run_at from crawl_plans where id = ${a}`;
      return (p!.next_run_at.getTime() - now.getTime()) / 1000;
    };
    expect(await next()).toBeGreaterThanOrEqual(3600 * 0.95);
    const [qp] = await sql`select throttled_since from quota_policies where id = ${Q}`;
    expect(qp!.throttled_since).not.toBeNull();
    const ev = async (t: string) =>
      (await sql`select count(*)::int as n from outbox where aggregate = 'cost_guard' and event_type = ${t}`)[0]!.n;
    expect(await ev("cost_guard.throttled")).toBe(1);

    // tick berikutnya: masih throttle, tapi alert tidak diulang
    await sql`update crawl_runs set status = 'succeeded' where crawl_plan_id = ${a}`;
    await sql`update crawl_plans set next_run_at = now() - interval '1 second' where id = ${a}`;
    const r2 = await schedulerTick(created.db, { now: () => now });
    expect([r2.scheduled, r2.throttled, r2.costGuard.throttledNow.length, r2.costGuard.breached.length]).toEqual([1, 1, 0, 1]);
    expect(await ev("cost_guard.throttled")).toBe(1);

    // override admin: naikkan cap → dilepas + event released, interval kembali normal
    await sql`update quota_policies set limit_value = 10 where id = ${Q}`;
    await sql`update crawl_runs set status = 'succeeded' where crawl_plan_id = ${a}`;
    await sql`update crawl_plans set next_run_at = now() - interval '1 second' where id = ${a}`;
    const r3 = await schedulerTick(created.db, { now: () => now });
    expect([r3.throttled, r3.costGuard.released]).toEqual([0, [Q]]);
    expect(await next()).toBeLessThanOrEqual(900 * 1.05);
    expect(await ev("cost_guard.released")).toBe(1);

    // soft cap di scope connector → semua plan platform connector itu ikut di-throttle; hard quota TIDAK disentuh cost guard
    const PROV = id(0x7100);
    const CONN = id(0x7101);
    await sql`insert into providers (id, key, name, kind, risk_level, enabled) values (${PROV}, 'pv', 'PV', 'third_party', 'low', true)`;
    await sql`insert into connectors (id, key, provider_id, platform_code, runtime, version) values (${CONN}, 'pv.x', ${PROV}, 'x', 'bun', '1')`;
    await sql`insert into quota_policies (id, scope_type, scope_id, period, unit, limit_value, hard) values
      (${id(0x7102)}, 'connector', ${CONN}, 'day', 'results', 0, false), (${id(0x7103)}, 'topic', ${TOPIC}, 'day', 'results', 0, true)`;
    await sql`update crawl_runs set status = 'succeeded' where crawl_plan_id = ${a}`;
    await sql`update crawl_plans set next_run_at = now() - interval '1 second' where id = ${a}`;
    const r4 = await schedulerTick(created.db, { now: () => now });
    expect(r4.costGuard.breached.map((x) => x.scope_type)).toEqual(["connector"]);
    expect([r4.scheduled, r4.throttled]).toEqual([1, 1]);
    // cost guard dimatikan → tidak ada evaluasi
    await sql`update crawl_runs set status = 'succeeded' where crawl_plan_id = ${a}`;
    await sql`update crawl_plans set next_run_at = now() - interval '1 second' where id = ${a}`;
    expect((await schedulerTick(created.db, { now: () => now, costGuard: false })).throttled).toBe(0);
    await sql`update quota_policies set enabled = false`;
    await sql`update crawl_plans set status = 'paused' where id = ${a}`;
  });
});

test("isThrottled: stream multi-tenant hanya di-throttle bila scope platform/global atau SEMUA anggota lewat soft cap", () => {
  const s = { ...EMPTY_COST_GUARD, tenants: new Set(["t1"]), topics: new Set(["k2"]), platforms: new Set(["ig"]) };
  expect(isThrottled(s, { platform_code: "x", member_tenants: ["t1", "t2"], member_topics: ["k1", "k3"] })).toBe(false);
  expect(isThrottled(s, { platform_code: "x", member_tenants: ["t1", "t2"], member_topics: ["k1", "k2"] })).toBe(true);
  expect(isThrottled(s, { platform_code: "ig", member_tenants: ["t9"], member_topics: ["k9"] })).toBe(true);
  expect(isThrottled({ ...s, global: true }, { platform_code: "x" })).toBe(true);
  expect(isThrottled(s, { platform_code: "x", tenant_id: "t2", topic_id: "k2" })).toBe(true);
  expect(isThrottled(s, { platform_code: "x", tenant_id: "t2", topic_id: "k1" })).toBe(false);
});
