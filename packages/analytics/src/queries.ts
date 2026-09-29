// D-01/D-02 (API_SPEC §5): query analitik atas agg_* / topic_matches. TENANT-SAFE: setiap query WAJIB memfilter
// tenant_id + topic_id dari konteks auth (topik sudah diverifikasi milik tenant di Postgres oleh pemanggil — SEC-01).
import type { ClickHouseClient } from "@clickhouse/client";

export interface AnalyticsFilter {
  tenantId: string;
  topicId: string;
  from: Date;
  to: Date;
  platforms?: string[];
}
export type Granularity = "1h" | "1d";

const chTs = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);
/** ≤ 3 hari → per jam, selebihnya per hari. */
export const autoGranularity = (f: AnalyticsFilter): Granularity => (f.to.getTime() - f.from.getTime() <= 3 * 86_400_000 ? "1h" : "1d");

function base(f: AnalyticsFilter, dateCol = "bucket", isDate = false) {
  const from = isDate ? "toDate({from:DateTime})" : "{from:DateTime}";
  const to = isDate ? "toDate({to:DateTime})" : "{to:DateTime}";
  return {
    where: `tenant_id = {t:UUID} AND topic_id = {topic:UUID} AND ${dateCol} >= ${from} AND ${dateCol} <= ${to}${f.platforms?.length ? " AND platform IN {pl:Array(String)}" : ""}`,
    params: { t: f.tenantId, topic: f.topicId, from: chTs(f.from), to: chTs(f.to), pl: f.platforms ?? [] },
  };
}

async function q<T>(ch: ClickHouseClient, query: string, params: Record<string, unknown>): Promise<T[]> {
  return (await ch.query({ query, query_params: params, format: "JSONEachRow" })).json<T>();
}

/** Deret waktu lengkap (bucket kosong = 0) untuk chart. */
function buckets(f: AnalyticsFilter, g: Granularity): string[] {
  const step = g === "1h" ? 3_600_000 : 86_400_000;
  const start =
    g === "1h" ? Math.floor(f.from.getTime() / step) * step : Date.UTC(f.from.getUTCFullYear(), f.from.getUTCMonth(), f.from.getUTCDate());
  const out: string[] = [];
  for (let t = start; t <= f.to.getTime() && out.length < 2000; t += step)
    out.push(g === "1h" ? new Date(t).toISOString().slice(0, 13) + ":00:00Z" : new Date(t).toISOString().slice(0, 10));
  return out;
}
const keyOf = (b: string, g: Granularity) => (g === "1h" ? `${b.replace(" ", "T").slice(0, 13)}:00:00Z` : b.slice(0, 10));

function series<K extends string>(rows: { k: K; b: string; n: number | string }[], g: Granularity, f: AnalyticsFilter, keys?: K[]) {
  const bs = buckets(f, g);
  const idx = new Map(bs.map((b, i) => [b, i]));
  const map = new Map<K, number[]>();
  for (const k of keys ?? [])
    map.set(
      k,
      bs.map(() => 0),
    );
  for (const r of rows) {
    const i = idx.get(keyOf(String(r.b), g));
    if (i === undefined) continue;
    if (!map.has(r.k))
      map.set(
        r.k,
        bs.map(() => 0),
      );
    map.get(r.k)![i]! += Number(r.n);
  }
  return { granularity: g, buckets: bs, series: [...map].map(([key, values]) => ({ key, values })) };
}

const topicTable = (g: Granularity) => (g === "1h" ? "agg_topic_1h" : "agg_topic_1d");

export async function exposure(ch: ClickHouseClient, f: AnalyticsFilter, g = autoGranularity(f)) {
  const w = base(f, "bucket", g === "1d");
  const rows = await q<{ k: string; b: string; n: string }>(
    ch,
    `SELECT platform AS k, toString(bucket) AS b, sum(posts) AS n FROM ${topicTable(g)} WHERE ${w.where} GROUP BY k, b HAVING n != 0`,
    w.params,
  );
  return { ...series(rows, g, f), definition: "Jumlah post yang match topik per bucket (bukan reach)." };
}

export async function sentimentTimeline(
  ch: ClickHouseClient,
  f: AnalyticsFilter,
  mode: "count" | "engagement" = "count",
  g = autoGranularity(f),
) {
  const w = base(f, "bucket", g === "1d");
  const rows = await q<{ k: "negative" | "neutral" | "positive"; b: string; n: string }>(
    ch,
    `SELECT toString(sentiment) AS k, toString(bucket) AS b, sum(${mode === "engagement" ? "engagement" : "posts"}) AS n FROM ${topicTable(g)} WHERE ${w.where} GROUP BY k, b HAVING n != 0`,
    w.params,
  );
  return series(rows, g, f, ["negative", "neutral", "positive"]);
}

export async function sentimentProportion(ch: ClickHouseClient, f: AnalyticsFilter, mode: "count" | "engagement" = "count") {
  const w = base(f, "bucket", true);
  const rows = await q<{ sentiment: string; n: string }>(
    ch,
    `SELECT toString(sentiment) AS sentiment, sum(${mode === "engagement" ? "engagement" : "posts"}) AS n FROM agg_topic_1d WHERE ${w.where} GROUP BY sentiment HAVING n != 0`,
    w.params,
  );
  const total = rows.reduce((a, r) => a + Number(r.n), 0);
  const versions = await q<{ v: string }>(
    ch,
    `SELECT DISTINCT model_version AS v FROM topic_matches FINAL WHERE tenant_id = {t:UUID} AND topic_id = {topic:UUID} AND published_at >= {from:DateTime} AND published_at <= {to:DateTime} LIMIT 10`,
    w.params,
  );
  return {
    total,
    items: rows
      .map((r) => ({ sentiment: r.sentiment, count: Number(r.n), pct: total ? Math.round((Number(r.n) / total) * 10000) / 100 : 0 }))
      .sort((a, b) => b.count - a.count),
    model_versions: versions.map((v) => v.v),
  };
}

export async function emotionProportion(ch: ClickHouseClient, f: AnalyticsFilter, mode: "count" | "engagement" = "count") {
  const w = base(f, "bucket", true);
  const rows = await q<{ emotion: string; n: string }>(
    ch,
    `SELECT toString(emotion) AS emotion, sum(${mode === "engagement" ? "engagement" : "posts"}) AS n FROM agg_emotion_1d WHERE ${w.where} GROUP BY emotion HAVING n != 0`,
    w.params,
  );
  const total = rows.reduce((a, r) => a + Number(r.n), 0);
  return {
    total,
    items: rows
      .map((r) => ({ emotion: r.emotion, count: Number(r.n), pct: total ? Math.round((Number(r.n) / total) * 10000) / 100 : 0 }))
      .sort((a, b) => b.count - a.count),
  };
}

export async function hashtags(ch: ClickHouseClient, f: AnalyticsFilter, limit = 30, sentiment?: string) {
  const w = base(f, "bucket", true);
  const rows = await q<{ hashtag: string; n: string; e: string }>(
    ch,
    `SELECT hashtag, sum(mentions) AS n, sum(engagement) AS e FROM agg_hashtag_1d WHERE ${w.where}${sentiment ? " AND sentiment = {s:String}" : ""}
     GROUP BY hashtag HAVING n > 0 ORDER BY n DESC LIMIT {lim:UInt32}`,
    { ...w.params, lim: limit, s: sentiment ?? "" },
  );
  return { items: rows.map((r) => ({ hashtag: r.hashtag, count: Number(r.n), engagement: Number(r.e) })) };
}

export async function topAccounts(ch: ClickHouseClient, f: AnalyticsFilter, by: "posts" | "engagement" = "posts", limit = 10) {
  const w = base(f, "bucket", true);
  const rows = await q<{ platform: string; author_id: string; handle: string; value: string; followers: string | null }>(
    ch,
    `SELECT platform, author_id, anyLast(author_handle) AS handle, sum(${by}) AS value, anyLast(author_followers) AS followers
     FROM agg_author_1d WHERE ${w.where} GROUP BY platform, author_id HAVING value > 0 ORDER BY value DESC LIMIT {lim:UInt32}`,
    { ...w.params, lim: limit },
  );
  return {
    items: rows.map((r) => ({
      platform: r.platform,
      author_id: r.author_id,
      handle: r.handle,
      value: Number(r.value),
      followers: r.followers === null ? null : Number(r.followers),
    })),
  };
}

export async function locations(ch: ClickHouseClient, f: AnalyticsFilter) {
  const w = base(f, "bucket", true);
  const rows = await q<{ code: string; n: string }>(
    ch,
    `SELECT geo_region_code AS code, sum(posts) AS n FROM agg_geo_1d WHERE ${w.where} GROUP BY code HAVING n != 0 ORDER BY n DESC`,
    w.params,
  );
  const known = rows.filter((r) => r.code !== "").reduce((a, r) => a + Number(r.n), 0);
  const total = rows.reduce((a, r) => a + Number(r.n), 0);
  return {
    level: "province",
    coverage_pct: total ? Math.round((known / total) * 1000) / 10 : 0,
    items: rows.filter((r) => r.code !== "").map((r) => ({ code: r.code, count: Number(r.n) })),
  };
}

export async function summary(ch: ClickHouseClient, f: AnalyticsFilter) {
  const span = f.to.getTime() - f.from.getTime();
  const prev = { ...f, from: new Date(f.from.getTime() - span), to: new Date(f.from.getTime() - 1000) };
  const one = async (x: AnalyticsFilter) => {
    const w = base(x, "bucket", true);
    // alias TIDAK boleh sama dengan nama kolom (ClickHouse me-resolve alias di dalam agregat lain → ILLEGAL_AGGREGATION)
    const [r] = await q<{ n_posts: string; n_eng: string; neg: string; pos: string }>(
      ch,
      `SELECT sum(posts) AS n_posts, sum(engagement) AS n_eng, sumIf(posts, sentiment = 'negative') AS neg, sumIf(posts, sentiment = 'positive') AS pos
       FROM agg_topic_1d WHERE ${w.where}`,
      w.params,
    );
    const w2 = base(x, "bucket", true);
    const [a] = await q<{ authors: string }>(
      ch,
      `SELECT uniqExact(author_id) AS authors FROM agg_author_1d WHERE ${w2.where} AND posts != 0`,
      w2.params,
    );
    return {
      posts: Number(r?.n_posts ?? 0),
      engagement: Number(r?.n_eng ?? 0),
      negative: Number(r?.neg ?? 0),
      positive: Number(r?.pos ?? 0),
      authors: Number(a?.authors ?? 0),
    };
  };
  const [cur, before] = await Promise.all([one(f), one(prev)]);
  const delta = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 1000) / 10 : null);
  return {
    current: cur,
    previous: before,
    delta_pct: {
      posts: delta(cur.posts, before.posts),
      engagement: delta(cur.engagement, before.engagement),
      authors: delta(cur.authors, before.authors),
    },
  };
}

/** D-02 feed: post match topik (label terbaru via topic_matches FINAL), tanpa demografi individu (SEC-09). */
export async function feed(
  ch: ClickHouseClient,
  f: AnalyticsFilter,
  o: { sentiment?: string; emotion?: string; limit: number; offset: number },
) {
  const rows = await q<Record<string, unknown>>(
    ch,
    `SELECT m.platform AS platform, m.post_id AS post_id, toString(m.published_at) AS published_at, toString(m.sentiment) AS sentiment,
            m.sentiment_score AS sentiment_score, toString(m.emotion) AS emotion, m.engagement AS engagement, m.engagement_known AS engagement_known,
            m.hashtags AS hashtags, m.author_handle AS author_handle, m.model_version AS model_version, p.text AS text, p.url AS url
     FROM (SELECT * FROM topic_matches FINAL WHERE tenant_id = {t:UUID} AND topic_id = {topic:UUID}
             AND published_at >= {from:DateTime} AND published_at <= {to:DateTime}
             ${f.platforms?.length ? "AND platform IN {pl:Array(String)}" : ""}
             ${o.sentiment ? "AND sentiment = {s:String}" : ""} ${o.emotion ? "AND emotion = {e:String}" : ""}
           ORDER BY published_at DESC LIMIT {lim:UInt32} OFFSET {off:UInt32}) AS m
     LEFT JOIN (SELECT platform, post_id, text, url FROM posts FINAL) AS p ON p.platform = m.platform AND p.post_id = m.post_id
     ORDER BY m.published_at DESC`,
    {
      t: f.tenantId,
      topic: f.topicId,
      from: chTs(f.from),
      to: chTs(f.to),
      pl: f.platforms ?? [],
      s: o.sentiment ?? "",
      e: o.emotion ?? "",
      lim: o.limit,
      off: o.offset,
    },
  );
  return rows.map((r) => ({ ...r, engagement: r.engagement_known ? Number(r.engagement) : null, engagement_known: undefined }));
}
