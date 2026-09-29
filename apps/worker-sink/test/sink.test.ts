// I-15 integrasi (Postgres + ClickHouse + Redis-cache compose): pipeline → stub AI → sink.
// P-03 (pesan 2× tidak dobel), P-09 (seenm hilang → guard ClickHouse), P-17 (post tak-match tersimpan tanpa AI),
// penutupan run baru setelah batch TERAKHIR, metrik null → engagement tidak diketahui (P-05).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ClickHouseClient, createClient } from "@clickhouse/client";
import { chUp } from "@smip/analytics";
import { fakeItem } from "@smip/connector-fake";
import { AiEnrichPayload, type CanonicalItem, type PostRecord, SinkAnalyticsPayload } from "@smip/contracts";
import { createDb, loadGeoRegions, up } from "@smip/db";
import { Gazetteer } from "@smip/geo";
import { astHash, compileQuery } from "@smip/query";
import { MemoryBlobStore } from "@smip/storage";
import { stubEnrich } from "@smip/worker-ai-stub";
import { cachedGazetteer, Deduper, handlePipelineItems } from "@smip/worker-pipeline";
import postgres from "postgres";
import { handleSink, planEngagementRefresh, type SinkDeps } from "../src";

const PG = process.env.TEST_PG_URL ?? "postgres://smip_owner:smip_owner_dev@127.0.0.1:55432/postgres";
const REDIS = process.env.TEST_REDIS_CACHE_URL ?? "redis://127.0.0.1:56380";
const CH_URL = process.env.TEST_CLICKHOUSE_URL ?? "http://smip:smip_dev@127.0.0.1:58123";
const infraUp = await (async () => {
  try {
    const s = postgres(PG, { connect_timeout: 2, onnotice: () => {} });
    await s`select 1`;
    await s.end();
    const r = new Bun.RedisClient(REDIS, { connectionTimeout: 2000, autoReconnect: false });
    await r.ping();
    r.close();
    return (await fetch(`${new URL(CH_URL).origin}/ping`)).ok;
  } catch {
    return false;
  }
})();

const id = (n: number) => `0192f000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const T = id(1);
let seq = 0x2000;

describe.skipIf(!infraUp)("I-15 worker-sink (integrasi)", () => {
  const stamp = Date.now();
  const pgName = `smip_sink_${stamp}`;
  const chName = `smip_sink_${stamp}`;
  const prefix = `sink${stamp}:`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  let created: ReturnType<typeof createDb>;
  let chAdmin: ClickHouseClient;
  let ch: ClickHouseClient;
  let redis: Bun.RedisClient;
  const blobs = new MemoryBlobStore();
  let sinkDeps: SinkDeps;
  let pipe: Parameters<typeof handlePipelineItems>[0];

  async function setup(queryText: string) {
    const [topic, query, plan, run] = [++seq, ++seq, ++seq, ++seq].map(id) as [string, string, string, string];
    const c = compileQuery({ query_text: queryText });
    await sql`insert into topics (id, tenant_id, name) values (${topic}, ${T}, ${`t${seq}`})`;
    await sql`insert into topic_queries (id, tenant_id, topic_id, kind, query_text, query_ast, ast_hash)
      values (${query}, ${T}, ${topic}, 'main', ${queryText}, ${sql.json(c.ast as never)}, ${Buffer.from(await astHash(c))})`;
    await sql`insert into crawl_plans (id, tenant_id, topic_id, topic_query_id, platform_code, operation, interval_sec, next_run_at, inflight_run_id)
      values (${plan}, ${T}, ${topic}, ${query}, 'x', 'search_keyword', 900, now(), ${run})`;
    await sql`insert into crawl_runs (id, tenant_id, crawl_plan_id, scheduled_for, kind, status, window_from, window_to, pending_batches)
      values (${run}, ${T}, ${plan}, now(), 'incremental', 'processing', now() - interval '1 hour', now(), 1)`;
    return { topic, query, plan, run };
  }
  /** pipeline → (ai.enrich → stub) + sink tak-match; kembalikan pesan sink yang dihasilkan (belum diproses). */
  async function throughPipeline(ids: { topic: string; query: string; run: string }, items: CanonicalItem[], attempt = 1) {
    const ref = await blobs.putJsonl(`batches/${ids.run}/${attempt}.jsonl.gz`, items);
    await handlePipelineItems(pipe, {
      crawl_run_id: ids.run,
      attempt_no: attempt,
      tenant_id: T,
      topic_id: ids.topic,
      topic_query_id: ids.query,
      query_ast_version: 1,
      items_ref: ref,
      items_count: items.length,
    });
    const jobs =
      await sql`select event_type, payload->'payload' as p from outbox where aggregate = 'job' and aggregate_id = ${ids.run} and published_at is null order by id`;
    await sql`update outbox set published_at = now() where aggregate_id = ${ids.run}`;
    const out: SinkAnalyticsPayload[] = [];
    for (const j of jobs) {
      if (j.event_type === "enqueue.ai.enrich") {
        const ai = AiEnrichPayload.parse(j.p);
        out.push(stubEnrich(ai, await blobs.getJsonl<PostRecord>(ai.items_ref!)));
      } else if (j.event_type === "enqueue.sink.analytics") out.push(SinkAnalyticsPayload.parse(j.p));
    }
    return out;
  }
  /** Baris pertama; angka dinormalisasi ke string (format JSON integer 64-bit berbeda antar versi ClickHouse). */
  const q1 = async <T>(query: string, params: Record<string, unknown> = {}) =>
    Object.fromEntries(
      Object.entries(
        (await (await ch.query({ query, query_params: params, format: "JSONEachRow" })).json<Record<string, unknown>>())[0]!,
      ).map(([k, v]) => [k, String(v)]),
    ) as T;
  const events = (topic: string) =>
    q1<{ n: string; s: string }>("SELECT count() AS n, sum(sign) AS s FROM topic_match_events WHERE topic_id = {t:UUID}", { t: topic });
  const agg = (topic: string) => q1<{ n: string }>("SELECT sum(posts) AS n FROM agg_topic_5m WHERE topic_id = {t:UUID}", { t: topic });
  const post = (n: number, text: string, o: Partial<CanonicalItem> = {}) =>
    fakeItem("x", n, { text, published_at: new Date(Date.UTC(2026, 8, 28, 2, 0, 0) + n * 60_000).toISOString(), ...o });

  beforeAll(async () => {
    admin = postgres(PG, { onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${pgName}`);
    const url = PG.replace(/\/[^/]*$/, `/${pgName}`);
    sql = postgres(url, { onnotice: () => {} });
    await up(sql);
    await sql`insert into platforms (code, name, icon, content_types, enabled) values ('x', 'X', 'x', '{post}', true)`;
    await sql`insert into tenants (id, slug, name) values (${T}, 'a', 'A')`;
    created = createDb(url, { max: 4 });
    chAdmin = createClient({ url: CH_URL });
    await chAdmin.command({ query: `CREATE DATABASE ${chName}` });
    ch = createClient({ url: CH_URL, database: chName });
    await chUp(ch);
    redis = new Bun.RedisClient(REDIS);
    sinkDeps = { db: created.db, ch, blobs };
    pipe = {
      db: created.db,
      blobs,
      dedupe: new Deduper(redis, prefix),
      gazetteer: cachedGazetteer(async () => new Gazetteer(await loadGeoRegions(created.db))),
      aiBatchSize: 2,
    };
  });
  afterAll(async () => {
    const keys = (await redis.send("KEYS", [`${prefix}*`])) as string[];
    if (keys.length) await redis.send("DEL", keys);
    redis?.close();
    await ch?.close();
    await chAdmin?.command({ query: `DROP DATABASE IF EXISTS ${chName}` });
    await chAdmin?.close();
    await created?.close();
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${pgName} WITH (FORCE)`);
    await admin?.end();
  });

  test("alur penuh: 3 match (2 batch AI) + 1 tak-match → run ditutup HANYA setelah batch terakhir; watermark & realtime.notify", async () => {
    const ids = await setup("kopdes");
    const msgs = await throughPipeline(ids, [post(1, "kopdes a"), post(2, "kopdes b #desa"), post(3, "kopdes c"), post(4, "lain hal")]);
    expect(msgs.map((m) => m.matches.length)).toEqual([2, 1, 0]);
    expect((await sql`select pending_batches from crawl_runs where id = ${ids.run}`)[0]!.pending_batches).toBe(3);
    const r1 = await handleSink(sinkDeps, msgs[0]!);
    const r2 = await handleSink(sinkDeps, msgs[1]!);
    expect([r1.finalized, r2.finalized]).toEqual([null, null]);
    const r3 = await handleSink(sinkDeps, msgs[2]!);
    expect(r3).toMatchObject({ posts: 1, events: 0, finalized: "succeeded" });
    expect(await events(ids.topic)).toEqual({ n: "3", s: "3" });
    expect(await agg(ids.topic)).toEqual({ n: "3" });
    const [run] = await sql`select status, items_matched, items_new from crawl_runs where id = ${ids.run}`;
    expect(run).toEqual({ status: "succeeded", items_matched: 3, items_new: 4 });
    const [plan] = await sql`select high_watermark, inflight_run_id from crawl_plans where id = ${ids.plan}`;
    expect([plan!.high_watermark.toISOString(), plan!.inflight_run_id]).toEqual([post(4, "").published_at, null]);
    const rt =
      await sql`select payload->'payload' as p from outbox where event_type = 'enqueue.realtime.notify' and aggregate_id = ${ids.run}`;
    expect(rt.map((x) => x.p.platforms)).toEqual([["x"], ["x"]]);
    expect(rt[0]!.p.buckets).toEqual(["2026-09-28T02:00:00.000Z"]);
  });

  test("P-17: post tak-match tersimpan di posts (matched=0) tanpa event/AI; post match matched=1 + geo & metrik", async () => {
    const rows = await (
      await ch.query({ query: "SELECT post_id, matched FROM posts FINAL ORDER BY post_id", format: "JSONEachRow" })
    ).json<{ post_id: string; matched: number }>();
    const snaps = await q1<{ n: string }>("SELECT count() AS n FROM engagement_snapshots");
    expect(snaps.n).toBe("4");
    expect(rows.map((r) => [r.post_id.slice(-1), r.matched])).toEqual([
      ["1", 1],
      ["2", 1],
      ["3", 1],
      ["4", 0],
    ]);
  });

  test("P-03: pesan sink sama dikirim 2× → event, agregat, dan counter run tidak dobel", async () => {
    const ids = await setup("sembako");
    const msgs = await throughPipeline(ids, [post(10, "sembako naik"), post(11, "sembako turun")]);
    expect(msgs).toHaveLength(1);
    await sql`update crawl_runs set pending_batches = 2 where id = ${ids.run}`; // anggap masih ada batch lain tertunda
    await handleSink(sinkDeps, msgs[0]!);
    const again = await handleSink(sinkDeps, msgs[0]!);
    expect(again.duplicateMessage).toBe(true);
    expect(await events(ids.topic)).toEqual({ n: "2", s: "2" });
    expect(await agg(ids.topic)).toEqual({ n: "2" });
    expect((await sql`select pending_batches from crawl_runs where id = ${ids.run}`)[0]!.pending_batches).toBe(1);
  });

  test("P-09: kunci Redis seenm di-flush lalu item sama datang lagi (batch baru) → guard ClickHouse mencegah dobel", async () => {
    const ids = await setup("banjir");
    const first = await throughPipeline(ids, [post(20, "banjir rob")]);
    await handleSink(sinkDeps, first[0]!);
    const keys = (await redis.send("KEYS", [`${prefix}seenm:*`])) as string[];
    await redis.send("DEL", keys); // Redis kehilangan kunci dedupe match
    await sql`update crawl_runs set status = 'processing', pending_batches = 1 where id = ${ids.run}`;
    const second = await throughPipeline(ids, [post(20, "banjir rob")], 2);
    expect(second[0]!.matches).toHaveLength(1); // Redis menganggap baru
    const r = await handleSink(sinkDeps, second[0]!);
    expect([r.events, r.skippedByGuard]).toEqual([0, 1]);
    expect(await events(ids.topic)).toEqual({ n: "1", s: "1" });
    expect(await agg(ids.topic)).toEqual({ n: "1" });
  });

  test("P-05: metrik null semua → engagement_known = 0 (bukan 0 yang diketahui); metrik ada → dijumlah", async () => {
    const ids = await setup("macet");
    const nullMetrics = {
      likes: null,
      comments: null,
      shares: null,
      views: null,
      quotes: null,
      saves: null,
      captured_at: "2026-09-28T02:00:00.000Z",
    };
    const msgs = await throughPipeline(ids, [
      post(30, "macet a", { metrics: nullMetrics }),
      post(31, "macet b", { metrics: { ...nullMetrics, likes: 5, comments: 2 } }),
    ]);
    await handleSink(sinkDeps, msgs[0]!);
    const rows = await (
      await ch.query({
        query: "SELECT post_id, engagement, engagement_known FROM topic_match_events WHERE topic_id = {t:UUID} ORDER BY post_id",
        query_params: { t: ids.topic },
        format: "JSONEachRow",
      })
    ).json<{ engagement: string; engagement_known: number }>();
    expect(rows.map((r) => [String(r.engagement), Number(r.engagement_known)])).toEqual([
      ["0", 0],
      ["7", 1],
    ]);
  });

  test("P-08/P-21 engagement refresh: planner → run+job; sink koreksi sign −1/+1 tanpa dobel hitung; followers = terbaru", async () => {
    const ids = await setup("kopi");
    const old = (n: number, likes: number) => {
      const it = post(n, `kopi ${n}`, {
        metrics: { likes, comments: 1, shares: null, views: 10, quotes: null, saves: null, captured_at: "2026-09-28T03:00:00.000Z" },
      });
      it.author = { ...it.author, platform_user_id: `au${n}`, followers: 100 };
      return it;
    };
    const msgs = await throughPipeline(ids, [old(40, 5), old(41, 2)]);
    for (const m of msgs) await handleSink(sinkDeps, m);
    const aggEng = () =>
      q1<{ n: string; e: string }>("SELECT sum(posts) AS n, sum(engagement) AS e FROM agg_topic_5m WHERE topic_id = {t:UUID}", {
        t: ids.topic,
      });
    expect(await aggEng()).toEqual({ n: "2", e: "9" }); // (5+1) + (2+1)

    // planner: hanya platform dgn policy post_detail aktif; post dgn snapshot lama → run engagement_refresh + job
    expect((await planEngagementRefresh(created.db, ch, { maxAgeHours: 24 * 3650, refreshEverySec: 1 })).runs).toBe(0);
    await sql`insert into routing_policies (id, tenant_id, platform_code, operation, strategy, enabled, version)
      values (${id(0x9001)}, null, 'x', 'post_detail', 'priority_weighted', true, 1)`;
    const plan = await planEngagementRefresh(created.db, ch, { maxAgeHours: 24 * 3650, refreshEverySec: 1, batchSize: 50 });
    expect(plan.runs).toBeGreaterThanOrEqual(1);
    const runs = await sql`select id, status, tenant_id, refresh_target from crawl_runs where kind = 'engagement_refresh'`;
    const target = runs.find((r) => r.refresh_target.post_ids.includes(post(40, "").platform_post_id))!;
    expect([target.status, target.tenant_id, target.refresh_target.platform]).toEqual(["queued", null, "x"]);
    const [job] =
      await sql`select payload->'payload' as p from outbox where event_type = 'enqueue.engagement.refresh' and aggregate_id = ${target.id}`;
    expect(job!.p.post_ids).toEqual(target.refresh_target.post_ids);
    // run refresh masih berjalan → siklus berikutnya tidak menumpuk
    expect((await planEngagementRefresh(created.db, ch, { maxAgeHours: 24 * 3650, refreshEverySec: 1 })).skippedPlatforms).toEqual(["x"]);

    // hasil post_detail (seperti dari dispatch/fetch): post 40 likes 5→12 & followers 100→150; post 41 tak berubah
    const fresh40 = old(40, 12);
    fresh40.metrics.captured_at = new Date().toISOString();
    fresh40.author = { ...fresh40.author, followers: 150 };
    const fresh41 = old(41, 2);
    const ref = await blobs.putJsonl(`refresh/${target.id}.jsonl.gz`, [fresh40, fresh41]);
    await sql`update crawl_runs set status = 'processing', pending_batches = 1 where id = ${target.id}`;
    const msg = SinkAnalyticsPayload.parse({
      batch_id: Bun.randomUUIDv7(),
      crawl_run_id: target.id,
      tenant_id: null,
      topic_id: null,
      posts_ref: ref,
      matches: [],
      mode: "engagement_refresh",
      run_update: null,
    });
    const r = await handleSink(sinkDeps, msg);
    expect(r).toMatchObject({ posts: 2, events: 1, skippedByGuard: 1, finalized: "succeeded" });
    expect(await events(ids.topic)).toEqual({ n: "4", s: "2" }); // 2 asli + pasangan (−1,+1)
    expect(await aggEng()).toEqual({ n: "2", e: "16" }); // posts tetap 2; engagement +7 (12+1 menggantikan 5+1)
    const tm = await q1<{ e: string }>(
      "SELECT engagement AS e FROM topic_matches FINAL WHERE topic_id = {t:UUID} AND post_id = {p:String}",
      { t: ids.topic, p: fresh40.platform_post_id },
    );
    expect(tm.e).toBe("13");
    const pf = await q1<{ f: string }>("SELECT author_followers AS f FROM posts FINAL WHERE post_id = {p:String}", {
      p: fresh40.platform_post_id,
    });
    expect(pf.f).toBe("150");
    await ch.command({ query: "OPTIMIZE TABLE agg_author_1d FINAL" });
    const au = await q1<{ f: string; e: string; n: string }>(
      "SELECT anyLast(author_followers) AS f, sum(engagement) AS e, sum(posts) AS n FROM agg_author_1d WHERE topic_id = {t:UUID} AND author_id = 'au40'",
      { t: ids.topic },
    );
    expect(au).toEqual({ f: "150", e: "13", n: "1" }); // P-21: followers = nilai terakhir, bukan jumlah

    // P-08: pesan diulang → ledger; hasil sama lewat batch baru → tak ada pasangan baru (tidak dobel)
    expect((await handleSink(sinkDeps, msg)).duplicateMessage).toBe(true);
    const again = await handleSink(sinkDeps, { ...msg, batch_id: Bun.randomUUIDv7() });
    expect([again.events, again.skippedByGuard]).toEqual([0, 2]);
    expect(await aggEng()).toEqual({ n: "2", e: "16" });

    // review: post yang sudah dicoba di jendela refresh (termasuk yang tidak dikembalikan provider) tidak dijadwalkan ulang
    await sql`update crawl_runs set status = 'succeeded' where kind = 'engagement_refresh'`;
    expect((await planEngagementRefresh(created.db, ch, { maxAgeHours: 24 * 3650, refreshEverySec: 3600 })).posts).toBe(0);
    await sql`update crawl_runs set scheduled_for = scheduled_for - interval '2 hours' where kind = 'engagement_refresh'`;
    expect((await planEngagementRefresh(created.db, ch, { maxAgeHours: 24 * 3650, refreshEverySec: 3600 })).posts).toBeGreaterThan(0);
  });
});
