// F-05 integrasi: migrasi ClickHouse up/down + golden agregat (TESTING §4.5). Butuh ClickHouse :8123.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ClickHouseClient, createClient } from "@clickhouse/client";
import { chDown, chStatus, chUp, loadChMigrations, sinkInsertSettings, splitStatements } from "../src";

// default: ClickHouse compose; override TEST_CLICKHOUSE_URL (spike: http://127.0.0.1:8123)
const CH_URL = process.env.TEST_CLICKHOUSE_URL ?? "http://smip:smip_dev@127.0.0.1:58123";
const DB = `smip_test_${Date.now()}`;
const chUpNow = await fetch(`${new URL(CH_URL).origin}/ping`).then(
  (r) => r.ok,
  () => false,
);
const T = "0192f000-0000-7000-8000-00000000000a";
const TOPIC = "0192f000-0000-7000-8000-0000000000aa";

function ev(post: string, over: Record<string, unknown> = {}) {
  return {
    tenant_id: T,
    topic_id: TOPIC,
    topic_query_id: TOPIC,
    platform: "x",
    post_id: post,
    content_type: "post",
    published_at: "2026-09-27 10:15:00.000",
    author_id: "a1",
    author_handle: "budi",
    author_created_year: null,
    author_followers: 100,
    sentiment: "negative",
    sentiment_score: 0.9,
    emotion: "anger",
    emotion_score: 0.8,
    author_gender: "male",
    author_gender_conf: 0.9,
    author_age_range: "22_30",
    author_age_conf: 0.7,
    model_version: "sent-v1",
    issues: ["gedung dpr"],
    hashtags: ["DemoDPR"],
    parent_author_id: null,
    parent_author_handle: null,
    geo_region_code: null,
    media: [],
    engagement: 10,
    engagement_known: 1,
    sign: 1,
    event_at: "2026-09-27 10:16:00.000",
    ...over,
  };
}

test("splitStatements: komentar dibuang, pisah di ';' akhir baris", () => {
  expect(splitStatements("-- c\nCREATE TABLE a (x String DEFAULT ';');\nSELECT 1;   -- komentar sebaris\nSELECT 2;")).toEqual([
    "CREATE TABLE a (x String DEFAULT ';')",
    "SELECT 1",
    "SELECT 2",
  ]);
});

describe.skipIf(!chUpNow)("ClickHouse migrasi & golden agregat (integrasi)", () => {
  let admin: ClickHouseClient;
  let ch: ClickHouseClient;
  const q = async <R>(query: string) => (await (await ch.query({ query, format: "JSONEachRow" })).json()) as R[];
  const n = async (query: string) => Number(Object.values((await q<Record<string, unknown>>(query))[0] ?? { v: 0 })[0]);
  const insert = (values: unknown[], token?: string) =>
    ch.insert({
      table: "topic_match_events",
      values,
      format: "JSONEachRow",
      clickhouse_settings: token ? sinkInsertSettings(token) : { async_insert: 0 },
    });

  beforeAll(async () => {
    admin = createClient({ url: CH_URL });
    await admin.command({ query: `CREATE DATABASE ${DB}` });
    ch = createClient({ url: CH_URL, database: DB });
  });
  afterAll(async () => {
    await ch?.close();
    await admin?.command({ query: `DROP DATABASE IF EXISTS ${DB}` });
    await admin?.close();
  });

  test("up semua migrasi; down --to 0 bersih; up lagi; checksum dijaga", async () => {
    const all = await loadChMigrations();
    expect(await chUp(ch)).toEqual(all.map((m) => m.version));
    const tables = async () => n(`SELECT count() FROM system.tables WHERE database = '${DB}' AND name != 'smip_schema_migrations'`);
    expect(await tables()).toBeGreaterThanOrEqual(30);
    expect(await chDown(ch, { to: 0 })).toEqual(all.map((m) => m.version).reverse());
    expect(await tables()).toBe(0);
    expect(await chUp(ch)).toHaveLength(all.length);
    await expect(
      chStatus(
        ch,
        all.map((m) => ({ ...m, checksum: "x" })),
      ),
    ).rejects.toThrow(/checksum/);
  });

  test("penjaga: setiap tabel sumber & target MV punya non_replicated_deduplication_window (tanpa itu agregat dobel)", async () => {
    const rows = await q<{ name: string; ok: number }>(`
      SELECT t.name, positionCaseInsensitive(t.create_table_query, 'non_replicated_deduplication_window') > 0 AS ok
      FROM system.tables t
      WHERE t.database = '${DB}' AND t.engine LIKE '%MergeTree' AND (
        t.name IN (SELECT arrayJoin(dependencies_table) FROM system.tables WHERE database = '${DB}' AND name = 'topic_match_events')
        OR t.name IN (SELECT replaceRegexpOne(create_table_query, '.* TO [^.]+\\.(\\w+) .*', '\\1') FROM system.tables WHERE database = '${DB}' AND engine = 'MaterializedView')
        OR t.name IN ('topic_match_events', 'posts'))`);
    const missing = rows.filter((r) => !Number(r.ok)).map((r) => r.name);
    expect(rows.length).toBeGreaterThanOrEqual(17);
    expect(missing).toEqual([]);
  });

  test("golden: override, repost, engagement tak diketahui, dedup token → semua agregat benar", async () => {
    await insert(
      [
        ev("p1", { media: [{ type: "image", url: "https://m/1.jpg", thumb: null }] }),
        ev("p2", {
          content_type: "reply",
          sentiment: "neutral",
          engagement: 0,
          engagement_known: 0,
          author_gender: "unknown",
          author_age_range: "unknown",
        }),
        ev("p3", {
          content_type: "repost",
          sentiment: "positive",
          author_id: "a2",
          author_handle: "sari",
          author_followers: null,
          parent_author_id: "orig",
          parent_author_handle: "BBCIndonesia",
          issues: [],
          hashtags: [],
          geo_region_code: "31",
        }),
      ],
      "sink.batch.1",
    );
    await insert([ev("p1")], "sink.batch.1"); // batch ulang dengan token sama → diabaikan (P-03)
    // override p1 negative → positive (P-06)
    await insert(
      [
        ev("p1", { sign: -1, event_at: "2026-09-27 11:00:00.000", media: [{ type: "image", url: "https://m/1.jpg", thumb: null }] }),
        ev("p1", {
          sentiment: "positive",
          event_at: "2026-09-27 11:00:00.000",
          author_followers: 150,
          media: [{ type: "image", url: "https://m/1.jpg", thumb: null }],
        }),
      ],
      "sink.override.1",
    );

    const s = Object.fromEntries(
      (await q<{ s: string; p: string }>("SELECT sentiment s, sum(posts) p FROM agg_topic_1h GROUP BY s")).map((r) => [r.s, Number(r.p)]),
    );
    expect(s).toEqual({ negative: 0, neutral: 1, positive: 2 });
    expect(await n("SELECT sum(engagement_known_posts) FROM agg_topic_1d")).toBe(2);
    expect(await n("SELECT sum(engagement) FROM agg_topic_5m")).toBe(20);
    expect(await n("SELECT sum(mentions) FROM agg_issue_1h WHERE issue = 'gedung dpr' AND sentiment = 'positive'")).toBe(1);
    expect(await n("SELECT sum(mentions) FROM agg_issue_1h WHERE issue = 'gedung dpr' AND sentiment = 'negative'")).toBe(0);
    expect(await n("SELECT sum(mentions) FROM agg_hashtag_1d WHERE hashtag = 'demodpr'")).toBe(2);

    await ch.command({ query: "OPTIMIZE TABLE agg_author_1d FINAL" });
    const [a1] = await q<{ posts: string; replies: string; f: string }>(
      "SELECT sum(posts) posts, sum(replies) replies, anyLast(author_followers) f FROM agg_author_1d WHERE author_id = 'a1'",
    );
    expect({ posts: Number(a1!.posts), replies: Number(a1!.replies), f: Number(a1!.f) }).toEqual({ posts: 1, replies: 1, f: 150 }); // followers BUKAN 250
    const [rp] = await q<{ c: string; h: string }>(
      "SELECT sum(reposted_count) c, anyLast(parent_author_handle) h FROM agg_reposted_author_1d WHERE parent_author_id = 'orig'",
    );
    expect({ c: Number(rp!.c), h: rp!.h }).toEqual({ c: 1, h: "BBCIndonesia" });
    const geo = Object.fromEntries(
      (await q<{ g: string; p: string }>("SELECT geo_region_code g, sum(posts) p FROM agg_geo_1d GROUP BY g")).map((r) => [
        r.g,
        Number(r.p),
      ]),
    );
    expect(geo).toEqual({ "": 2, "31": 1 }); // '' = tidak diketahui, tetap terlihat
    expect(await n("SELECT uniqMerge(authors) FROM agg_author_age_1d WHERE author_created_year = 0")).toBe(2);
    expect(await n("SELECT uniqMerge(authors) FROM agg_topic_uniq_1h")).toBe(2);
    const g = Object.fromEntries(
      (
        await q<{ k: string; p: string }>(
          "SELECT concat(toString(author_gender), '/', toString(sentiment)) k, sum(posts) p FROM agg_psycho_gender_1d GROUP BY k HAVING p != 0",
        )
      ).map((r) => [r.k, Number(r.p)]),
    );
    expect(g).toEqual({ "male/positive": 2, "unknown/neutral": 1 });
    expect(await n("SELECT sum(posts) FROM agg_emotion_1h WHERE emotion = 'anger'")).toBe(3);
    expect(await n("SELECT sum(sign) FROM media_items WHERE post_id = 'p1'")).toBe(1);
    const [fin] = await q<{ s: string }>("SELECT sentiment s FROM topic_matches FINAL WHERE post_id = 'p1'");
    expect(fin!.s).toBe("positive");
  });

  test("posts: ReplacingMergeTree by version — FINAL memberi versi terbaru (dedup lintas provider P-01)", async () => {
    const post = (version: number, text: string) => ({
      platform: "x",
      post_id: "p9",
      content_type: "post",
      parent_post_id: null,
      root_post_id: null,
      parent_author_id: null,
      parent_author_handle: null,
      url: null,
      text,
      lang: "id",
      published_at: "2026-09-27 10:00:00.000",
      author_id: "a1",
      author_handle: "budi",
      author_name: null,
      author_created_at: null,
      author_followers: null,
      author_verified: null,
      author_location_raw: null,
      hashtags: [],
      mentions: [],
      media: "[]",
      geo_region_code: null,
      geo_confidence: null,
      is_ad: null,
      matched: 1,
      source_connector: version === 1 ? "apify.x.xquik" : "twitterapi_io.x",
      raw_ref: "s3://x",
      ingested_at: "2026-09-27 10:01:00.000",
      version,
    });
    await ch.insert({ table: "posts", values: [post(1, "v1")], format: "JSONEachRow" });
    await ch.insert({ table: "posts", values: [post(2, "v2")], format: "JSONEachRow" });
    const rows = await q<{ text: string }>("SELECT text FROM posts FINAL WHERE post_id = 'p9'");
    expect(rows).toEqual([{ text: "v2" }]);
  });
});
