// S-07: ClickHouse — DDL DATA_MODEL §6 (subset), MV sign-based, override -1/+1, insert dedup token,
// FINAL feed, bug SummingMergeTree vs AggregatingMergeTree (v0.4 C5), media_items MV (C4), kunci Nullable (C16).
// Juga menguji @clickhouse/client di Bun.
import { createClient } from "@clickhouse/client";
import { assert, type Check, INFRA, reachable, Untested } from "./types";

const DB = "compat_s07";
const T1 = "0192f000-0000-7000-8000-000000000001";
const TOPIC = "0192f000-0000-7000-8000-0000000000aa";

const DDL = [
  `DROP DATABASE IF EXISTS ${DB}`,
  `CREATE DATABASE ${DB}`,
  `CREATE TABLE ${DB}.topic_match_events (
     tenant_id UUID, topic_id UUID, topic_query_id UUID,
     platform LowCardinality(String), post_id String, content_type LowCardinality(String),
     published_at DateTime64(3,'UTC'), author_id String, author_handle String,
     author_followers Nullable(UInt64),
     sentiment Enum8('negative'=-1,'neutral'=0,'positive'=1), sentiment_score Float32,
     issues Array(String),
     geo_region_code Nullable(String),
     media Array(Tuple(type LowCardinality(String), url String, thumb Nullable(String))),
     engagement UInt64, engagement_known UInt8,
     sign Int8, event_at DateTime64(3,'UTC')
   ) ENGINE = MergeTree PARTITION BY toYYYYMM(published_at)
     ORDER BY (tenant_id, topic_id, published_at, platform, post_id)
     SETTINGS non_replicated_deduplication_window = 1000`,
  `CREATE TABLE ${DB}.agg_topic_1h (
     tenant_id UUID, topic_id UUID, platform LowCardinality(String),
     sentiment Enum8('negative'=-1,'neutral'=0,'positive'=1), content_type LowCardinality(String),
     bucket DateTime('UTC'), posts Int64, engagement Int64, engagement_known_posts Int64
   ) ENGINE = SummingMergeTree ORDER BY (tenant_id, topic_id, platform, sentiment, content_type, bucket)`,
  `CREATE MATERIALIZED VIEW ${DB}.mv_agg_topic_1h TO ${DB}.agg_topic_1h AS
   SELECT tenant_id, topic_id, platform, sentiment, content_type, toStartOfHour(published_at) AS bucket,
          sum(sign) AS posts, sum(sign * toInt64(engagement)) AS engagement,
          sum(sign * toInt64(engagement_known)) AS engagement_known_posts
   FROM ${DB}.topic_match_events GROUP BY tenant_id, topic_id, platform, sentiment, content_type, bucket`,
  `CREATE TABLE ${DB}.topic_matches (
     tenant_id UUID, topic_id UUID, platform LowCardinality(String), post_id String,
     sentiment Enum8('negative'=-1,'neutral'=0,'positive'=1), published_at DateTime64(3,'UTC'), event_at DateTime64(3,'UTC')
   ) ENGINE = ReplacingMergeTree(event_at) ORDER BY (tenant_id, topic_id, platform, post_id)`,
  `CREATE MATERIALIZED VIEW ${DB}.mv_topic_matches TO ${DB}.topic_matches AS
   SELECT tenant_id, topic_id, platform, post_id, sentiment, published_at, event_at
   FROM ${DB}.topic_match_events WHERE sign = 1`,
  // v0.3 (bug): SummingMergeTree dengan kolom followers non-key
  `CREATE TABLE ${DB}.agg_author_1d_v03 (
     tenant_id UUID, topic_id UUID, platform LowCardinality(String), author_id String, day Date,
     posts Int64, author_followers UInt64
   ) ENGINE = SummingMergeTree ORDER BY (tenant_id, topic_id, platform, author_id, day)`,
  `CREATE MATERIALIZED VIEW ${DB}.mv_author_v03 TO ${DB}.agg_author_1d_v03 AS
   SELECT tenant_id, topic_id, platform, author_id, toDate(published_at) AS day,
          sum(sign) AS posts, max(ifNull(author_followers, 0)) AS author_followers
   FROM ${DB}.topic_match_events GROUP BY tenant_id, topic_id, platform, author_id, day`,
  // v0.4 (fix): AggregatingMergeTree + SimpleAggregateFunction
  `CREATE TABLE ${DB}.agg_author_1d (
     tenant_id UUID, topic_id UUID, platform LowCardinality(String),
     sentiment Enum8('negative'=-1,'neutral'=0,'positive'=1), author_id String, day Date,
     posts SimpleAggregateFunction(sum, Int64),
     engagement SimpleAggregateFunction(sum, Int64),
     author_handle SimpleAggregateFunction(anyLast, String),
     author_followers SimpleAggregateFunction(anyLast, Nullable(UInt64))
   ) ENGINE = AggregatingMergeTree ORDER BY (tenant_id, topic_id, platform, sentiment, author_id, day)`,
  `CREATE MATERIALIZED VIEW ${DB}.mv_author TO ${DB}.agg_author_1d AS
   SELECT tenant_id, topic_id, platform, sentiment, author_id, toDate(published_at) AS day,
          sum(sign) AS posts, sum(sign * toInt64(engagement)) AS engagement,
          anyLast(author_handle) AS author_handle, anyLast(author_followers) AS author_followers
   FROM ${DB}.topic_match_events GROUP BY tenant_id, topic_id, platform, sentiment, author_id, day`,
  `CREATE TABLE ${DB}.media_items (
     tenant_id UUID, topic_id UUID, platform LowCardinality(String), post_id String, media_idx UInt16,
     media_type LowCardinality(String), media_url String, thumb_url Nullable(String),
     published_at DateTime64(3,'UTC'), sentiment Enum8('negative'=-1,'neutral'=0,'positive'=1), sign Int8
   ) ENGINE = MergeTree ORDER BY (tenant_id, topic_id, published_at, platform, post_id, media_idx)`,
  `CREATE MATERIALIZED VIEW ${DB}.mv_media TO ${DB}.media_items AS
   SELECT tenant_id, topic_id, platform, post_id, toUInt16(idx - 1) AS media_idx,
          m.1 AS media_type, m.2 AS media_url, m.3 AS thumb_url, published_at, sentiment, sign
   FROM ${DB}.topic_match_events ARRAY JOIN media AS m, arrayEnumerate(media) AS idx`,
];

function ev(post: string, sentiment: string, sign: number, extra: Record<string, unknown> = {}) {
  return {
    tenant_id: T1,
    topic_id: TOPIC,
    topic_query_id: TOPIC,
    platform: "x",
    post_id: post,
    content_type: "post",
    published_at: "2026-09-27 10:15:00.000",
    author_id: "a1",
    author_handle: "budi",
    author_followers: 1000,
    sentiment,
    sentiment_score: 0.9,
    issues: ["gedung dpr"],
    geo_region_code: null,
    media: [],
    engagement: 10,
    engagement_known: 1,
    sign,
    event_at: "2026-09-27 10:16:00.000",
    ...extra,
  };
}

export const clickhouse: Check = {
  id: "clickhouse",
  task: "S-07",
  packages: ["@clickhouse/client", "ClickHouse server"],
  async run() {
    if (!(await reachable(INFRA.clickhouse))) throw new Untested("ClickHouse tidak jalan");
    const ch = createClient({ url: INFRA.clickhouse });
    const notes: string[] = [];
    const q = async <T>(query: string) => (await (await ch.query({ query, format: "JSONEachRow" })).json()) as T[];
    try {
      const ver = (await q<{ v: string }>("SELECT version() AS v"))[0]!.v;
      notes.push(`ClickHouse ${ver}, @clickhouse/client di Bun: query/insert JSONEachRow OK`);
      for (const stmt of DDL) await ch.command({ query: stmt });
      notes.push(`DDL subset DATA_MODEL §6 (events, agg_topic_1h, topic_matches, agg_author_1d, media_items + MV) terbuat`);

      // 1) insert + override -1/+1
      await ch.insert({
        table: `${DB}.topic_match_events`,
        format: "JSONEachRow",
        values: [ev("p1", "negative", 1), ev("p2", "negative", 1), ev("p3", "neutral", 1, { engagement: 0, engagement_known: 0 })],
      });
      await ch.insert({
        table: `${DB}.topic_match_events`,
        format: "JSONEachRow",
        values: [
          ev("p1", "negative", -1, { event_at: "2026-09-27 11:00:00.000" }),
          ev("p1", "positive", 1, { event_at: "2026-09-27 11:00:00.000" }),
        ],
      });
      const agg = await q<{ sentiment: string; posts: string; ek: string }>(
        `SELECT sentiment, sum(posts) AS posts, sum(engagement_known_posts) AS ek FROM ${DB}.agg_topic_1h GROUP BY sentiment ORDER BY sentiment`,
      );
      const m = Object.fromEntries(agg.map((r) => [r.sentiment, Number(r.posts)]));
      assert(m.negative === 1 && m.positive === 1 && m.neutral === 1, `override sign: neg1/pos1/neu1, dapat ${JSON.stringify(m)}`);
      const ek = agg.reduce((a, r) => a + Number(r.ek), 0);
      assert(ek === 2, `engagement_known_posts = 2 (p3 tanpa metrik), dapat ${ek}`);
      notes.push(
        "override sentiment via pasangan sign -1/+1 → agregat benar tanpa UPDATE; engagement_known_posts memisahkan 'tidak diketahui' dari 0",
      );

      // 2) FINAL feed
      const fin = await q<{ sentiment: string }>(`SELECT sentiment FROM ${DB}.topic_matches FINAL WHERE post_id='p1'`);
      assert(fin.length === 1 && fin[0]!.sentiment === "positive", `topic_matches FINAL = label terbaru (dapat ${JSON.stringify(fin)})`);
      notes.push("topic_matches (ReplacingMergeTree, MV sign=1) + FINAL → 1 baris label terbaru");

      // 3) insert_deduplication_token pada MergeTree non-replicated — di bawah async_insert default server vs sync
      const countOf = async (post: string) =>
        Number((await q<{ c: string }>(`SELECT count() AS c FROM ${DB}.topic_match_events WHERE post_id='${post}'`))[0]!.c);
      const insertTwice = async (post: string, settings: Record<string, unknown>) => {
        for (let i = 0; i < 2; i++) {
          await ch.insert({
            table: `${DB}.topic_match_events`,
            format: "JSONEachRow",
            values: [ev(post, "neutral", 1, { event_at: `2026-09-27 10:0${i}:00.000` })],
            clickhouse_settings: { insert_deduplication_token: `sink.batch.${post}`, ...settings },
          });
        }
        return countOf(post);
      };
      const srv = Object.fromEntries(
        (
          await q<{ name: string; value: string }>(
            `SELECT name, value FROM system.settings WHERE name IN ('async_insert','async_insert_deduplicate')`,
          )
        ).map((r) => [r.name, r.value]),
      );
      const cDefault = await insertTwice("p9a", {});
      const cSync = await insertTwice("p9b", { async_insert: 0 });
      const cAsyncDedup = await insertTwice("p9c", { async_insert: 1, async_insert_deduplicate: 1, wait_for_async_insert: 1 });
      notes.push(`server default async_insert=${srv.async_insert}, async_insert_deduplicate=${srv.async_insert_deduplicate}`);
      notes.push(
        `insert_deduplication_token, batch berbeda isi tapi token sama 2×: default server → ${cDefault} baris; async_insert=0 → ${cSync} baris; async_insert=1+async_insert_deduplicate=1 → ${cAsyncDedup} baris`,
      );
      assert(cSync === 1, `mode sync + token harus dedup (dapat ${cSync})`);
      await ch.command({ query: `CREATE TABLE ${DB}.nowin (k String, v UInt8) ENGINE = MergeTree ORDER BY k` });
      for (let i = 0; i < 2; i++)
        await ch.insert({
          table: `${DB}.nowin`,
          format: "JSONEachRow",
          values: [{ k: "a", v: i }],
          clickhouse_settings: { insert_deduplication_token: "same", async_insert: 0 },
        });
      const cNoWin = Number((await q<{ c: string }>(`SELECT count() AS c FROM ${DB}.nowin`))[0]!.c);
      notes.push(
        `tanpa SETTING non_replicated_deduplication_window: token sama 2× → ${cNoWin} baris ${cNoWin === 2 ? "(token DIABAIKAN — setting tabel WAJIB untuk MergeTree non-replicated)" : ""}`,
      );
      if (cDefault !== 1)
        notes.push(
          "GOTCHA: dengan default server ini token dedup TIDAK berlaku → worker-sink WAJIB set async_insert=0 (sink sudah mem-batch) atau async_insert_deduplicate=1, dan tabel MergeTree non-replicated WAJIB non_replicated_deduplication_window > 0",
        );
      else notes.push("token dedup berlaku di default server; tetap set eksplisit di worker-sink agar tidak bergantung default versi");

      // 4) Bug SummingMergeTree (v0.3) vs AggregatingMergeTree (v0.4)
      await ch.insert({
        table: `${DB}.topic_match_events`,
        format: "JSONEachRow",
        values: [ev("p20", "neutral", 1, { author_id: "a2", author_followers: 1000, event_at: "2026-09-27 12:00:00.000" })],
      });
      await ch.insert({
        table: `${DB}.topic_match_events`,
        format: "JSONEachRow",
        values: [ev("p21", "neutral", 1, { author_id: "a2", author_followers: 1100, event_at: "2026-09-27 13:00:00.000" })],
      });
      await ch.command({ query: `OPTIMIZE TABLE ${DB}.agg_author_1d_v03 FINAL` });
      await ch.command({ query: `OPTIMIZE TABLE ${DB}.agg_author_1d FINAL` });
      const v03 = await q<{ f: string; p: string }>(
        `SELECT author_followers AS f, posts AS p FROM ${DB}.agg_author_1d_v03 WHERE author_id='a2'`,
      );
      const v04 = await q<{ f: string; p: string }>(
        `SELECT author_followers AS f, posts AS p FROM ${DB}.agg_author_1d WHERE author_id='a2'`,
      );
      assert(v03.length === 1 && Number(v03[0]!.f) === 2100, `v0.3: followers TERJUMLAH jadi 2100 (dapat ${JSON.stringify(v03)})`);
      assert(
        v04.length === 1 && Number(v04[0]!.f) === 1100 && Number(v04[0]!.p) === 2,
        `v0.4: followers anyLast=1100, posts=2 (dapat ${JSON.stringify(v04)})`,
      );
      notes.push(
        "BUKTI bug v0.3: SummingMergeTree menjumlahkan followers (1000+1100=2100) saat merge; fix v0.4 AggregatingMergeTree+SimpleAggregateFunction(anyLast) = 1100",
      );

      // 5) media_items MV dari kolom media di events
      await ch.insert({
        table: `${DB}.topic_match_events`,
        format: "JSONEachRow",
        values: [
          ev("p30", "negative", 1, {
            media: [
              { type: "image", url: "https://m/1.jpg", thumb: null },
              { type: "video", url: "https://m/2.mp4", thumb: "https://m/2.jpg" },
            ],
          }),
        ],
      });
      const media = await q<{ media_idx: number; media_type: string }>(
        `SELECT media_idx, media_type FROM ${DB}.media_items WHERE post_id='p30' ORDER BY media_idx`,
      );
      assert(
        media.length === 2 && media[0]!.media_type === "image" && media[1]!.media_idx === 1,
        `media_items 2 baris (dapat ${JSON.stringify(media)})`,
      );
      notes.push("media_items via MV ARRAY JOIN kolom media (kolom baru v0.4) → 2 baris/post; tanpa kolom ini MV tidak bisa dibuat");

      // 6) Kunci Nullable ditolak
      const nullableKey = await ch
        .command({
          query: `CREATE TABLE ${DB}.agg_geo_bad (tenant_id UUID, geo_region_code Nullable(String), posts Int64) ENGINE = SummingMergeTree ORDER BY (tenant_id, geo_region_code)`,
        })
        .then(
          () => "diterima",
          (e: Error) => e.message.split("\n")[0]!.slice(0, 120),
        );
      assert(nullableKey !== "diterima", "kunci Nullable harus ditolak tanpa allow_nullable_key");
      notes.push(`ORDER BY kolom Nullable ditolak: "${nullableKey}" → agregat geo memakai '' = unknown (C16)`);
    } finally {
      await ch.close();
    }
    const gotcha = notes.some((n) => n.startsWith("GOTCHA"));
    return { status: gotcha ? "WORKAROUND" : "COMPATIBLE", notes };
  },
};
