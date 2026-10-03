// I-15 integrasi (Postgres + ClickHouse + Redis-cache compose): pipeline → stub AI → sink.
// P-03 (pesan 2× tidak dobel), P-09 (seenm hilang → guard ClickHouse), P-17 (post tak-match tersimpan tanpa AI),
// penutupan run baru setelah batch TERAKHIR, metrik null → engagement tidak diketahui (P-05).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ClickHouseClient, createClient } from "@clickhouse/client";
import { chUp, overrideSentiment } from "@smip/analytics";
import { fakeItem } from "@smip/connector-fake";
import { AiEnrichPayload, type CanonicalItem, type PostRecord, SinkAnalyticsPayload } from "@smip/contracts";
import { createDb, loadGeoRegions, up } from "@smip/db";
import { Gazetteer } from "@smip/geo";
import { astHash, compileQuery } from "@smip/query";
import { MemoryBlobStore } from "@smip/storage";
import { stubEnrich } from "@smip/worker-ai-stub";
import { cachedGazetteer, Deduper, handlePipelineItems } from "@smip/worker-pipeline";
import postgres from "postgres";
import { evaluateAlerts, handleSink, planComments, planEngagementRefresh, purgeTenant, runRetention, type SinkDeps } from "../src";

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

  test("A-06 relabel: label stub diganti label model baru lewat pasangan −1/+1; jumlah post tetap; ulang = idempoten", async () => {
    const ids = await setup("sawit");
    const msgs = await throughPipeline(ids, [post(60, "sawit a"), post(61, "sawit b")]);
    for (const m of msgs) await handleSink(sinkDeps, m);
    const dist = () =>
      ch
        .query({
          query:
            "SELECT sentiment, sum(posts) AS n FROM agg_topic_5m WHERE topic_id = {t:UUID} GROUP BY sentiment HAVING n != 0 ORDER BY sentiment",
          query_params: { t: ids.topic },
          format: "JSONEachRow",
        })
        .then((r) => r.json<{ sentiment: string; n: string }>())
        .then((r) => r.map((x) => [x.sentiment, Number(x.n)]));
    expect(await dist()).toEqual([["neutral", 2]]);
    const base = msgs.find((m) => m.matches.length)!;
    const relabel = {
      ...base,
      batch_id: Bun.randomUUIDv7(),
      mode: "relabel" as const,
      matches: base.matches.map((x, k) => ({
        ...x,
        sentiment: (k === 0 ? "negative" : "positive") as "negative" | "positive",
        sentiment_score: 0.9,
        emotion: "anger" as const,
        emotion_score: 0.8,
        model_version: "llm:test:v1",
      })),
    };
    const r = await handleSink(sinkDeps, relabel);
    expect([r.events, r.skippedByGuard]).toEqual([2, 0]);
    expect(await dist()).toEqual([
      ["negative", 1],
      ["positive", 1],
    ]); // total post tetap 2
    const again = await handleSink(sinkDeps, { ...relabel, batch_id: Bun.randomUUIDv7() });
    expect([again.events, again.skippedByGuard]).toEqual([0, 2]);
    expect(await dist()).toEqual([
      ["negative", 1],
      ["positive", 1],
    ]);
    const tm = await q1<{ v: string }>("SELECT any(model_version) AS v FROM topic_matches FINAL WHERE topic_id = {t:UUID}", {
      t: ids.topic,
    });
    expect(tm.v).toBe("llm:test:v1");

    // A-05: koreksi manusia pada post pertama → reprocess model berikutnya TIDAK menimpanya (AI_SPEC §8)
    const [first] = relabel.matches;
    const ov = await overrideSentiment(ch, {
      tenantId: base.tenant_id!,
      topicId: ids.topic,
      platform: first!.platform,
      postId: first!.post_id,
      label: "neutral",
      batchId: Bun.randomUUIDv7(),
    });
    expect(ov).toMatchObject({ previous: "negative", changed: true });
    const model2 = {
      ...relabel,
      batch_id: Bun.randomUUIDv7(),
      matches: relabel.matches.map((x) => ({ ...x, sentiment: "negative" as const, model_version: "llm:test:v2" })),
    };
    const r2 = await handleSink(sinkDeps, model2);
    expect([r2.events, r2.skippedByGuard]).toEqual([1, 1]); // hanya post kedua dilabel ulang
    expect(await dist()).toEqual([
      ["negative", 1],
      ["neutral", 1],
    ]);
  });

  test("planner komentar: post engagement tertinggi per topik/platform, anggaran harian & jeda ambil ulang dari Pengaturan", async () => {
    const ids = await setup("sawit");
    const fresh = (n: number, likes: number) =>
      post(n, `sawit ${n}`, {
        published_at: new Date(Date.now() - n * 60_000).toISOString(),
        metrics: { likes, comments: 0, shares: null, views: null, quotes: null, saves: null, captured_at: new Date().toISOString() },
      });
    for (const m of await throughPipeline(ids, [fresh(1, 5), fresh(2, 50), fresh(3, 20), fresh(4, 1)])) await handleSink(sinkDeps, m);
    const pid = (n: number) => fresh(n, 0).platform_post_id;
    // tanpa policy post_comments → tidak ada run
    expect((await planComments(created.db, ch)).runs).toBe(0);
    await sql`insert into routing_policies (id, tenant_id, platform_code, operation, strategy, enabled, version)
      values (${id(0x9101)}, null, 'x', 'post_comments', 'priority_weighted', true, 1)`;
    // policy tanpa connector komentar terverifikasi → tetap tidak ada run
    expect((await planComments(created.db, ch)).runs).toBe(0);
    await sql`insert into providers (id, key, name, kind, risk_level, enabled) values (${id(0x9102)}, 'pc', 'PC', 'official', 'low', true)`;
    await sql`insert into connectors (id, key, provider_id, platform_code, runtime, version, enabled) values (${id(0x9103)}, 'pc.x', ${id(0x9102)}, 'x', 'bun', '1', true)`;
    await sql`insert into connector_capabilities (connector_id, operation, declared, status, verified_at, evidence_ref)
      values (${id(0x9103)}, 'post_comments', '{}', 'verified', now(), 'test')`;
    await sql`insert into routing_rules (id, policy_id, connector_id, priority, weight, enabled) values (${id(0x9104)}, ${id(0x9101)}, ${id(0x9103)}, 1, 100, true)`;
    await sql`insert into system_settings (key, value) values ('comments.top_posts_per_day', '2'), ('comments.max_pages_per_post', '3')
      on conflict (key) do update set value = excluded.value`;
    const r1 = await planComments(created.db, ch);
    expect([r1.runs, r1.posts]).toEqual([1, 2]);
    const [run] = await sql`select id, tenant_id, crawl_plan_id, status, refresh_target from crawl_runs where kind = 'comments'`;
    expect(run).toMatchObject({ tenant_id: T, crawl_plan_id: ids.plan, status: "queued" });
    expect(run!.refresh_target).toEqual({ platform: "x", post_ids: [pid(2), pid(3)], max_pages: 3 }); // engagement tertinggi
    const [job] = await sql`select payload->'payload' as p, payload->>'priority' as pr from outbox where aggregate_id = ${run!.id}`;
    expect([job!.p.operation, job!.p.run_kind, job!.p.topic_query_id, job!.pr]).toEqual(["post_comments", "comments", ids.query, "10"]);
    // masih berjalan → tidak menumpuk
    expect((await planComments(created.db, ch)).runs).toBe(0);
    await sql`update crawl_runs set status = 'succeeded' where id = ${run!.id}`;
    // anggaran harian (2) habis
    expect((await planComments(created.db, ch)).runs).toBe(0);
    // anggaran naik → hanya post yang BELUM diambil dalam jendela ambil ulang
    await sql`update system_settings set value = '3' where key = 'comments.top_posts_per_day'`;
    const r3 = await planComments(created.db, ch);
    expect(r3.posts).toBe(1);
    const last = await sql`select refresh_target from crawl_runs where kind = 'comments' and status = 'queued'`;
    expect(last[0]!.refresh_target.post_ids).toEqual([pid(1)]);
    await sql`insert into system_settings (key, value) values ('comments.enabled', 'false') on conflict (key) do update set value = 'false'`;
    await sql`update crawl_runs set status = 'succeeded' where kind = 'comments'`;
    expect((await planComments(created.db, ch)).runs).toBe(0); // dimatikan di Pengaturan
  });

  test("O-05 evaluateAlerts: agregat 1 jam negatif tinggi → event + webhook (aturan nonaktif / topik dijeda dilewati), cooldown", async () => {
    const [topic, rule, off, chan] = [++seq, ++seq, ++seq, ++seq].map(id) as [string, string, string, string];
    await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE smip_system`;
      await tx`insert into topics (id, tenant_id, name) values (${topic}, ${T}, 'Alert uji')`;
      await tx`insert into notification_channels (id, tenant_id, kind, config) values (${chan}, ${T}, 'webhook', ${tx.json({ name: "Hook", url: "https://hook.example/x" })})`;
      await tx`insert into alert_rules (id, tenant_id, topic_id, type, params, channels, cooldown_sec) values
        (${rule}, ${T}, ${topic}, 'negative_ratio', ${tx.json({ window_hours: 3, threshold_pct: 60, min_posts: 10 })}, ${`{${chan}}`}::uuid[], 3600),
        (${off}, ${T}, ${topic}, 'volume_spike', ${tx.json({ window_hours: 1, factor: 1.5, min_posts: 1 })}, '{}', 3600)`;
      await tx`update alert_rules set enabled = false where id = ${off}`;
    });
    const hour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString().replace("T", " ").slice(0, 19);
    await ch.insert({
      table: "agg_topic_1h",
      values: [
        {
          tenant_id: T,
          topic_id: topic,
          platform: "x",
          sentiment: "negative",
          content_type: "post",
          bucket: hour,
          posts: 16,
          engagement: 0,
          engagement_known_posts: 0,
        },
        {
          tenant_id: T,
          topic_id: topic,
          platform: "x",
          sentiment: "neutral",
          content_type: "post",
          bucket: hour,
          posts: 4,
          engagement: 0,
          engagement_known_posts: 0,
        },
      ],
      format: "JSONEachRow",
    });
    const posts: { url: string; body: string }[] = [];
    const deps = {
      db: created.db,
      ch,
      kms: null,
      post: async (url: string, init: { body: string }) => {
        posts.push({ url, body: init.body });
        return { status: 204 };
      },
    };
    const r = await evaluateAlerts(deps);
    expect(r.fired).toBe(1);
    expect(r.deliveries.sent).toBe(1);
    expect(posts[0]!.url).toBe("https://hook.example/x");
    expect(JSON.parse(posts[0]!.body)).toMatchObject({
      event: "alert.fired",
      title: "Sentimen negatif 80% (3 jam terakhir)",
      topic: { name: "Alert uji" },
    });
    const [ev] = await sql`select status, payload from alert_events where rule_id = ${rule}`;
    expect(ev!.status).toBe("open");
    expect(ev!.payload.deliveries[0]).toMatchObject({ channel_id: chan, status: "sent" });
    expect((await evaluateAlerts(deps)).fired).toBe(0); // cooldown 1 jam
  });

  test("H-04 retensi: data kantor > retention_days, post tak-match > 30 hari, post tak terpakai > 400 hari, outbox lama; purge kantor tertutup", async () => {
    const now = Date.now();
    const ts = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 23);
    const old = now - 500 * 86_400_000;
    const T2 = id(++seq);
    await sql`insert into tenants (id, slug, name, status) values (${T2}, ${`purge${seq}`}, 'Tutup', 'closed')`;
    const tm = (tenant: string, post: string, at: number) => ({
      tenant_id: tenant,
      topic_id: id(0x9999),
      topic_query_id: id(0x9998),
      platform: "x",
      post_id: post,
      content_type: "post",
      published_at: ts(at),
      author_id: "a",
      author_handle: "a",
      sentiment: "neutral",
      sentiment_score: 0,
      emotion: "unknown",
      model_version: "t",
      issues: [],
      hashtags: [],
      geo_region_code: null,
      engagement: 0,
      engagement_known: 0,
      event_at: ts(now),
    });
    await ch.insert({
      table: "topic_matches",
      format: "JSONEachRow",
      values: [tm(T, "ret-old", old), tm(T, "ret-new", now - 3_600_000), tm(T2, "ret-t2", now)],
    });
    await ch.insert({
      table: "agg_topic_1h",
      format: "JSONEachRow",
      values: [
        {
          tenant_id: T,
          topic_id: id(0x9999),
          platform: "x",
          sentiment: "neutral",
          content_type: "post",
          bucket: `${ts(old).slice(0, 13)}:00:00`,
          posts: 1,
          engagement: 0,
          engagement_known_posts: 0,
        },
        {
          tenant_id: T2,
          topic_id: id(0x9999),
          platform: "x",
          sentiment: "neutral",
          content_type: "post",
          bucket: `${ts(now).slice(0, 13)}:00:00`,
          posts: 1,
          engagement: 0,
          engagement_known_posts: 0,
        },
      ],
    });
    const post = (pid: string, at: number, matched: number) => ({
      platform: "x",
      post_id: pid,
      text: "t",
      published_at: ts(at),
      author_id: "a",
      author_handle: "a",
      hashtags: [],
      mentions: [],
      media: "[]",
      matched,
      source_connector: "fake.x",
      raw_ref: "",
      ingested_at: ts(now),
      version: 1,
      content_type: "post",
      lang: "id",
    });
    await ch.insert({
      table: "posts",
      format: "JSONEachRow",
      values: [
        post("ret-unm-old", now - 40 * 86_400_000, 0),
        post("ret-unm-new", now - 86_400_000, 0),
        post("ret-glob-old", old, 1),
        post("ret-new", now - 3_600_000, 1),
      ],
    });
    await sql`insert into outbox (aggregate, aggregate_id, event_type, payload, created_at, published_at) values ('x', ${id(0x9997)}, 'old', '{}', now() - interval '60 days', now() - interval '60 days')`;
    const r = await runRetention(created.db, ch, { sync: true });
    expect(r.tenants.find((t) => t.tenant_id === T)?.days).toBe(365);
    expect(r.outbox_deleted).toBeGreaterThanOrEqual(1);
    const ids = async (q: string) =>
      (await (await ch.query({ query: q, format: "JSONEachRow" })).json<{ post_id: string }>()).map((x) => x.post_id).sort();
    expect(await ids(`SELECT post_id FROM topic_matches WHERE post_id LIKE 'ret-%'`)).toEqual(["ret-new", "ret-t2"]);
    expect(await ids(`SELECT post_id FROM posts WHERE post_id LIKE 'ret-%'`)).toEqual(["ret-new", "ret-unm-new"]);
    const aggT = await (
      await ch.query({
        query: `SELECT count() AS n FROM agg_topic_1h WHERE tenant_id = '${T}' AND bucket < now() - INTERVAL 400 DAY`,
        format: "JSONEachRow",
      })
    ).json<{ n: string }>();
    expect(Number(aggT[0]!.n)).toBe(0);

    // purge kantor: hanya yang closed; semua data CH tenant itu + baris tenant hilang
    await expect(purgeTenant(created.db, ch, T)).rejects.toThrow("tutup kantor dulu");
    await purgeTenant(created.db, ch, T2);
    expect(await ids(`SELECT post_id FROM topic_matches WHERE tenant_id = '${T2}'`)).toEqual([]);
    expect((await sql`select count(*)::int as n from tenants where id = ${T2}`)[0]!.n).toBe(0);
  }, 120_000);
});
