// I-14 integrasi (Postgres + Redis-cache compose): P-01, P-02, P-04, P-12 + iklan, geo, retry aman, batching,
// penutupan run (succeeded → watermark maju; partial → celah, watermark diam).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fakeItem } from "@smip/connector-fake";
import { AiEnrichPayload, type CanonicalItem, type PostRecord, SinkAnalyticsPayload } from "@smip/contracts";
import { createDb, loadGeoRegions, up } from "@smip/db";
import { Gazetteer } from "@smip/geo";
import { astHash, compileQuery } from "@smip/query";
import { MemoryBlobStore } from "@smip/storage";
import postgres from "postgres";
import { cachedGazetteer, Deduper, handlePipelineItems, type PipelineDeps } from "../src";

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
const T = id(1);
let seq = 0x1000;

describe.skipIf(!infraUp)("I-14 worker-pipeline (integrasi)", () => {
  const name = `smip_pipe_${Date.now()}`;
  const prefix = `pipe${Date.now()}:`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  let created: ReturnType<typeof createDb>;
  let redis: Bun.RedisClient;
  const blobs = new MemoryBlobStore();
  let deps: PipelineDeps;

  /** Topik + query + plan + run(processing, pending 1) → kembalikan id. */
  async function setup(q: Parameters<typeof compileQuery>[0], o: { filterAds?: boolean; errorCode?: string; hw?: Date } = {}) {
    const [topic, query, plan, run] = [++seq, ++seq, ++seq, ++seq].map(id) as [string, string, string, string];
    const c = compileQuery(q);
    await sql`insert into topics (id, tenant_id, name, filter_ads) values (${topic}, ${T}, ${`t${seq}`}, ${o.filterAds ?? false})`;
    await sql`insert into topic_queries (id, tenant_id, topic_id, kind, query_text, query_ast, ast_hash, languages, media_tags, not_media_tags)
      values (${query}, ${T}, ${topic}, 'main', 'q', ${sql.json(c.ast as never)}, ${Buffer.from(await astHash(c))}, ${c.languages}, ${c.mediaTags}, ${c.notMediaTags})`;
    await sql`insert into crawl_plans (id, tenant_id, topic_id, topic_query_id, platform_code, operation, interval_sec, next_run_at, high_watermark, inflight_run_id)
      values (${plan}, ${T}, ${topic}, ${query}, 'x', 'search_keyword', 900, now(), ${o.hw ?? null}, ${run})`;
    await sql`insert into crawl_runs (id, tenant_id, crawl_plan_id, scheduled_for, kind, status, window_from, window_to, pending_batches, error_code)
      values (${run}, ${T}, ${plan}, now(), 'incremental', 'processing', now() - interval '2 hours', now(), 1, ${o.errorCode ?? null})`;
    return { topic, query, plan, run };
  }
  /** Run seolah dikerjakan connector dengan urutan hasil tertentu (declared.result_order) — menentukan sisi celah. */
  async function withConnector(runId: string, order: "desc" | "asc" | null) {
    const prov = Bun.randomUUIDv7();
    const conn = Bun.randomUUIDv7();
    await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE smip_system`;
      await tx`insert into providers (id, key, name, kind, risk_level) values (${prov}, ${`p${prov.slice(-8)}`}, 'p', 'third_party', 'low')`;
      await tx`insert into connectors (id, key, provider_id, platform_code, runtime, version) values (${conn}, ${`p${prov.slice(-8)}.x`}, ${prov}, 'x', 'bun', '1')`;
      await tx`insert into connector_capabilities (connector_id, operation, declared) values (${conn}, 'search_keyword', ${tx.json({ result_order: order } as never)})`;
      await tx`update crawl_runs set routing = ${tx.json({ connector_id: conn } as never)} where id = ${runId}`;
    });
  }
  async function send(ids: { topic: string; query: string; run: string }, items: CanonicalItem[], attempt = 1) {
    const ref = await blobs.putJsonl(`batches/${ids.run}/${attempt}.jsonl.gz`, items);
    return handlePipelineItems(deps, {
      crawl_run_id: ids.run,
      attempt_no: attempt,
      tenant_id: T,
      topic_id: ids.topic,
      topic_query_id: ids.query,
      query_ast_version: 1,
      items_ref: ref,
      items_count: items.length,
    });
  }
  const jobs = async (runId: string, queue: string) =>
    (
      await sql`select payload from outbox where aggregate = 'job' and aggregate_id = ${runId} and event_type = ${`enqueue.${queue}`} order by id`
    ).map((r) => r.payload as { idempotencyKey: string; payload: unknown });
  const post = (n: number, text: string, o: Partial<CanonicalItem> = {}) =>
    fakeItem("x", n, { text, published_at: new Date(Date.UTC(2026, 8, 28, 1, 0, 0) + n * 60_000).toISOString(), ...o });

  beforeAll(async () => {
    admin = postgres(PG, { onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const url = PG.replace(/\/[^/]*$/, `/${name}`);
    sql = postgres(url, { onnotice: () => {} });
    await up(sql);
    await sql`insert into platforms (code, name, icon, content_types, enabled) values ('x', 'X', 'x', '{post}', true)`;
    await sql`insert into tenants (id, slug, name) values (${T}, 'a', 'A')`;
    created = createDb(url, { max: 4 });
    redis = new Bun.RedisClient(REDIS);
    deps = {
      db: created.db,
      blobs,
      dedupe: new Deduper(redis, prefix),
      gazetteer: cachedGazetteer(async () => new Gazetteer(await loadGeoRegions(created.db))),
    };
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

  test("P-04: A AND NOT B — item berisi B tidak match (walau connector hanya term); tak-match baru → sink langsung", async () => {
    const ids = await setup({ query_text: 'koperasi AND NOT "2025"' });
    const r = await send(ids, [post(1, "koperasi desa diresmikan"), post(2, "koperasi target 2025 gagal"), post(3, "berita lain")]);
    expect(r).toMatchObject({ received: 3, matched: 1, newPosts: 3, aiBatches: 1, unmatchedBatch: true });
    const [ai] = await jobs(ids.run, "ai.enrich");
    const p = AiEnrichPayload.parse(ai!.payload);
    expect(p.items.map((i) => [i.post_id, i.is_new_post, i.match.topic_query_id])).toEqual([
      [post(1, "").platform_post_id, true, ids.query],
    ]);
    expect(p.priority_class).toBe("realtime");
    const posts = await blobs.getJsonl<PostRecord>(p.items_ref!);
    expect(posts.map((x) => [x.text, x.matched])).toEqual([["koperasi desa diresmikan", true]]);
    const [sink] = await jobs(ids.run, "sink.analytics");
    const s = SinkAnalyticsPayload.parse(sink!.payload);
    expect([s.tenant_id, s.matches, s.run_update]).toEqual([null, [], null]);
    expect((await blobs.getJsonl<PostRecord>(s.posts_ref)).map((x) => [x.text, x.matched])).toEqual([
      ["koperasi target 2025 gagal", false],
      ["berita lain", false],
    ]);
    const [run] = await sql`select pending_batches, items_matched, items_new, status from crawl_runs where id = ${ids.run}`;
    expect(run).toEqual({ pending_batches: 2, items_matched: 1, items_new: 3, status: "processing" }); // 1 − 1 + 2 anak
  });

  test("P-12: keywords + languages (alias 'in'→id) + media_tags / not_media_tags diterapkan semua", async () => {
    const ids = await setup({
      query_text: "banjir",
      keywords: ["genangan"],
      languages: ["id"],
      media_tags: ["jakarta"],
      not_media_tags: ["hoax"],
    });
    const r = await send(ids, [
      post(11, "banjir lagi #jakarta", { lang_hint: "in" }), // cocok (alias in→id, hashtag = media tag)
      post(12, "genangan di jalan", { lang_hint: "id", hashtags: ["jakarta"] }), // cocok via keyword
      post(13, "flood again in the city #jakarta banjir", { lang_hint: "en" }), // bahasa salah
      post(14, "banjir besar", { lang_hint: "id" }), // tanpa media tag
      post(15, "banjir #jakarta #hoax", { lang_hint: "id" }), // not_media_tags
      post(16, "banjir #jakarta", { lang_hint: null }), // bahasa tak diketahui → lolos (ADR-008)
    ]);
    expect(r.matched).toBe(3);
    const p = AiEnrichPayload.parse((await jobs(ids.run, "ai.enrich"))[0]!.payload);
    expect(p.items.map((i) => i.text)).toEqual(["banjir lagi #jakarta", "genangan di jalan", "banjir #jakarta"]);
  });

  test("run komentar: komentar ditautkan ke topik pemilik run walau tidak menyebut keyword (bahasa apa pun)", async () => {
    const ids = await setup({ query_text: "banjir", languages: ["id"] });
    await sql`update crawl_runs set kind = 'comments' where id = ${ids.run}`;
    const r = await send(ids, [
      post(41, "setuju banget pak", { content_type: "comment" }),
      post(42, "so sad to hear this news today", { content_type: "comment", lang_hint: "en" }),
    ]);
    expect(r.matched).toBe(2);
    const p = AiEnrichPayload.parse((await jobs(ids.run, "ai.enrich"))[0]!.payload);
    expect(p.items.map((i) => i.text)).toEqual(["setuju banget pak", "so sad to hear this news today"]);
  });

  test("filter_ads: is_ad=true disaring bila topik filter_ads; is_ad=null tidak (FR-I07)", async () => {
    const ids = await setup({ query_text: "promo" }, { filterAds: true });
    const r = await send(ids, [
      post(21, "promo kopi", { is_ad: true }),
      post(22, "promo kopi enak", { is_ad: null }),
      post(23, "promo teh", { is_ad: false }),
    ]);
    expect([r.matched, r.ads]).toEqual([2, 1]);
  });

  test("P-01/P-02: post sama dari provider lain / window overlap → konten & match hanya sekali", async () => {
    const ids = await setup({ query_text: "sembako" });
    const a = await send(ids, [post(31, "harga sembako naik"), post(32, "sembako murah")], 1);
    const ids2 = await setup({ query_text: "sembako" }); // topik lain → match baru, konten tidak baru
    const b = await send(
      { ...ids, run: ids2.run },
      [post(31, "harga sembako naik", { provenance: { ...post(31, "").provenance, connector_key: "fake.x.b" } })],
      1,
    );
    const c = await send(ids2, [post(31, "harga sembako naik")], 2);
    expect([a.matched, a.newPosts]).toEqual([2, 2]);
    expect([b.matched, b.duplicateMatches, b.newPosts]).toEqual([0, 1, 0]); // topik sama, run berikutnya (overlap)
    expect([c.matched, c.newPosts]).toEqual([1, 0]); // topik lain: match baru, konten sudah ada → is_new_post=false
    const ai = AiEnrichPayload.parse((await jobs(ids2.run, "ai.enrich")).at(-1)!.payload);
    expect(ai.items[0]!.is_new_post).toBe(false);
  });

  test("retry pesan yang sama (crash sebelum commit) tidak menghilangkan match: pemilik kunci sama", async () => {
    const ids = await setup({ query_text: "pemilu" });
    const items = [post(41, "pemilu damai"), post(42, "pemilu serentak")];
    const first = await send(ids, items, 3);
    // simulasi crash SEBELUM commit: seluruh efek DB (counter, ledger, outbox) tergulung balik, kunci Redis tetap
    await sql`update crawl_runs set pending_batches = 1 where id = ${ids.run}`;
    await sql`delete from processed_messages where key = ${`pipe.${ids.run}.3`}`;
    const again = await send(ids, items, 3);
    expect([first.matched, again.matched, again.duplicateMatches]).toEqual([2, 2, 0]);
    const keys = (await jobs(ids.run, "ai.enrich")).map((j) => j.idempotencyKey);
    expect(new Set(keys).size).toBe(1); // jobId sama → BullMQ mengabaikan duplikat
    // terkirim ulang SETELAH commit (ack gagal) → dilewati seluruhnya, counter tidak berubah lagi
    const before = (await sql`select pending_batches from crawl_runs where id = ${ids.run}`)[0]!.pending_batches;
    const dup = await send(ids, items, 3);
    expect(dup.duplicateMessage).toBe(true);
    expect((await sql`select pending_batches from crawl_runs where id = ${ids.run}`)[0]!.pending_batches).toBe(before);
  });

  test("geo gazetteer: place_name 0,8, lokasi profil 0,5 / terkandung 0,3, tak dikenal null", async () => {
    const ids = await setup({ query_text: "macet" });
    await send(ids, [
      post(51, "macet parah", { geo: { lat: null, lng: null, place_name: "Jakarta" } }),
      post(52, "macet lagi", { author: { ...post(52, "").author, location_raw: "Bandung" } }),
      post(53, "macet total", { author: { ...post(53, "").author, location_raw: "Kota Surabaya, Indonesia" } }),
      post(54, "macet dimana-mana", { author: { ...post(54, "").author, location_raw: "di hatimu" } }),
    ]);
    const p = AiEnrichPayload.parse((await jobs(ids.run, "ai.enrich"))[0]!.payload);
    const posts = await blobs.getJsonl<PostRecord>(p.items_ref!);
    expect(posts.map((x) => [x.geo_region_code, x.geo_confidence])).toEqual([
      ["31", 0.8],
      ["32", 0.5],
      ["35", 0.3],
      [null, null],
    ]);
  });

  test("batch ai.enrich ≤ 64 item; pending_batches = jumlah batch anak", async () => {
    const ids = await setup({ query_text: "banjir" });
    const r = await send(
      ids,
      Array.from({ length: 130 }, (_, k) => post(1000 + k, `banjir ${k}`)),
    );
    expect(r.aiBatches).toBe(3);
    const sizes = (await jobs(ids.run, "ai.enrich")).map((j) => AiEnrichPayload.parse(j.payload).items.length);
    expect(sizes).toEqual([64, 64, 2]);
    expect((await sql`select pending_batches from crawl_runs where id = ${ids.run}`)[0]!.pending_batches).toBe(3);
  });

  test("tanpa batch anak (konten lama, tak cocok) → run succeeded, watermark maju ke max(published_at), plan bebas", async () => {
    const ids = await setup({ query_text: "zzzunik" }, { hw: new Date("2026-09-01T00:00:00Z") });
    const r = await send(ids, [post(31, "harga sembako naik")]); // konten sudah dilihat tes P-01 → tidak disimpan ulang
    expect(r.finalized).toBe("succeeded");
    const [p] = await sql`select high_watermark, inflight_run_id, gap_windows from crawl_plans where id = ${ids.plan}`;
    expect(p!.high_watermark.toISOString()).toBe(post(31, "").published_at);
    expect([p!.inflight_run_id, p!.gap_windows]).toEqual([null, []]);
  });

  test("P-18 (bagian pipeline): run partial → celah [window_from, min(published_at)], watermark TIDAK maju", async () => {
    const hw = new Date("2026-09-01T00:00:00Z");
    const ids = await setup({ query_text: "zzzunik" }, { errorCode: "UPSTREAM_5XX", hw });
    await withConnector(ids.run, "desc"); // hasil terbaru dulu → yang hilang bagian LAMA
    const r = await send(ids, [post(32, "sembako murah"), post(31, "harga sembako naik")]); // konten lama & tak cocok → tanpa batch anak
    expect(r.finalized).toBe("partial");
    const [run] = await sql`select status, window_from from crawl_runs where id = ${ids.run}`;
    expect(run!.status).toBe("partial");
    const [p] = await sql`select high_watermark, gap_windows from crawl_plans where id = ${ids.plan}`;
    expect(p!.high_watermark.getTime()).toBe(hw.getTime());
    expect(p!.gap_windows).toHaveLength(1);
    expect(p!.gap_windows[0]).toMatchObject({ since: run!.window_from.toISOString(), until: post(31, "").published_at });
  });

  test("I-24: sisi celah mengikuti urutan hasil connector — asc → [max(published), until]; tak terurut → seluruh window", async () => {
    for (const [order, expectSide] of [
      ["asc", "atas"],
      [null, "penuh"],
    ] as const) {
      const ids = await setup({ query_text: "zzzunik" }, { errorCode: "TIMEOUT" });
      await withConnector(ids.run, order);
      await send(ids, [post(32, "a"), post(31, "b")]); // konten lama       await send(ids, [post(33, "a"), post(31, "b")]); tak cocok → tanpa batch anak → langsung ditutup
      const [run] = await sql`select window_from, window_to from crawl_runs where id = ${ids.run}`;
      const [p] = await sql`select gap_windows from crawl_plans where id = ${ids.plan}`;
      const g = p!.gap_windows[0];
      if (expectSide === "atas") expect([g.since, g.until]).toEqual([post(32, "").published_at, run!.window_to.toISOString()]);
      else expect([g.since, g.until]).toEqual([run!.window_from.toISOString(), run!.window_to.toISOString()]);
    }
  });
});
