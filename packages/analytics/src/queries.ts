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
    out.push(g === "1h" ? `${new Date(t).toISOString().slice(0, 13)}:00:00Z` : new Date(t).toISOString().slice(0, 10));
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

export async function exposure(ch: ClickHouseClient, f: AnalyticsFilter, g = autoGranularity(f), mode: "count" | "engagement" = "count") {
  const w = base(f, "bucket", g === "1d");
  const rows = await q<{ k: string; b: string; n: string }>(
    ch,
    `SELECT platform AS k, toString(bucket) AS b, sum(${mode === "engagement" ? "engagement" : "posts"}) AS n FROM ${topicTable(g)} WHERE ${w.where} GROUP BY k, b HAVING n != 0`,
    w.params,
  );
  return {
    ...series(rows, g, f),
    definition:
      mode === "engagement"
        ? "Jumlah engagement (like+komentar+share+view sesuai platform) per bucket."
        : "Jumlah post yang match topik per bucket (bukan reach).",
  };
}

const EMOTIONS = ["anticipation", "anger", "disgust", "trust", "joy", "fear", "surprise", "sadness"] as const;

/** Deret waktu 8 emosi (Perception stream). */
export async function emotionTimeline(ch: ClickHouseClient, f: AnalyticsFilter, g = autoGranularity(f)) {
  const w = base(f, "bucket", g === "1d");
  const rows = await q<{ k: string; b: string; n: string }>(
    ch,
    `SELECT toString(emotion) AS k, toString(bucket) AS b, sum(posts) AS n FROM ${g === "1h" ? "agg_emotion_1h" : "agg_emotion_1d"}
     WHERE ${w.where} AND emotion != 'unknown' GROUP BY k, b HAVING n != 0`,
    w.params,
  );
  return series(rows, g, f, [...EMOTIONS]);
}

/** Akun aktif (unik) per hari. */
export async function activeAccounts(ch: ClickHouseClient, f: AnalyticsFilter) {
  const w = base(f, "bucket", true);
  const rows = await q<{ k: "accounts"; b: string; n: string }>(
    ch,
    `SELECT 'accounts' AS k, toString(bucket) AS b, uniqExact(author_id) AS n
     FROM (SELECT author_id, bucket, sum(posts) + sum(replies) + sum(reposts) AS c FROM agg_author_1d WHERE ${w.where} GROUP BY author_id, bucket HAVING c != 0)
     GROUP BY b`,
    w.params,
  );
  return series(rows, "1d", f, ["accounts"]);
}

/** Jumlah per platform × jenis konten (post / reply / repost …) — kartu "Total posts / Total replies". */
export async function platformBreakdown(ch: ClickHouseClient, f: AnalyticsFilter) {
  const w = base(f, "bucket", true);
  const rows = await q<{ platform: string; content_type: string; n: string; e: string }>(
    ch,
    `SELECT platform, content_type, sum(posts) AS n, sum(engagement) AS e FROM agg_topic_1d WHERE ${w.where}
     GROUP BY platform, content_type HAVING n != 0 ORDER BY n DESC`,
    w.params,
  );
  return { items: rows.map((r) => ({ platform: r.platform, content_type: r.content_type, count: Number(r.n), engagement: Number(r.e) })) };
}

/** Akun yang paling banyak di-repost/di-quote (Most retweeted accounts). */
export async function repostedAccounts(ch: ClickHouseClient, f: AnalyticsFilter, limit = 10) {
  const w = base(f, "bucket", true);
  const rows = await q<{ platform: string; author_id: string; handle: string | null; n: string }>(
    ch,
    `SELECT platform, parent_author_id AS author_id, anyLast(parent_author_handle) AS handle, sum(reposted_count) AS n
     FROM agg_reposted_author_1d WHERE ${w.where} GROUP BY platform, author_id HAVING n > 0 ORDER BY n DESC LIMIT {lim:UInt32}`,
    { ...w.params, lim: limit },
  );
  return { items: rows.map((r) => ({ platform: r.platform, author_id: r.author_id, handle: r.handle, value: Number(r.n) })) };
}

/** Kecenderungan waktu aktif audiens: hari (1=Senin) × jam, zona Asia/Jakarta. */
export async function activityHeatmap(ch: ClickHouseClient, f: AnalyticsFilter, tz = "Asia/Jakarta") {
  const w = base(f, "bucket");
  const rows = await q<{ d: number; h: number; n: string }>(
    ch,
    `SELECT toDayOfWeek(bucket, 0, {tz:String}) AS d, toHour(bucket, {tz:String}) AS h, sum(posts) AS n
     FROM agg_topic_1h WHERE ${w.where} GROUP BY d, h HAVING n != 0`,
    { ...w.params, tz },
  );
  return { timezone: tz, cells: rows.map((r) => ({ day: Number(r.d), hour: Number(r.h), count: Number(r.n) })) };
}

/** Tahun akun dibuat (User created time) — agregat tanpa kolom platform, jadi filter platform tidak berlaku. */
export async function authorCreatedYear(ch: ClickHouseClient, f: AnalyticsFilter) {
  const rows = await q<{ y: number; n: string }>(
    ch,
    `SELECT author_created_year AS y, uniqMerge(authors) AS n FROM agg_author_age_1d
     WHERE tenant_id = {t:UUID} AND topic_id = {topic:UUID} AND bucket >= toDate({from:DateTime}) AND bucket <= toDate({to:DateTime})
     GROUP BY y ORDER BY y`,
    { t: f.tenantId, topic: f.topicId, from: chTs(f.from), to: chTs(f.to) },
  );
  const known = rows.filter((r) => Number(r.y) > 0);
  const unknown = rows.filter((r) => Number(r.y) === 0).reduce((a, r) => a + Number(r.n), 0);
  return { unknown, items: known.map((r) => ({ year: Number(r.y), count: Number(r.n) })) };
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

/** Isu/keyphrase (AI_SPEC §5) dari `agg_issue_1h` — word cloud "Isu" & "Isu (engagement)"; `mode=engagement` = urut bobot engagement. */
export async function issues(
  ch: ClickHouseClient,
  f: AnalyticsFilter,
  limit = 40,
  mode: "count" | "engagement" = "count",
  sentiment?: string,
) {
  const w = base(f);
  const rows = await q<{ issue: string; n: string; e: string }>(
    ch,
    `SELECT issue, sum(mentions) AS n, sum(engagement) AS e FROM agg_issue_1h WHERE ${w.where}${sentiment ? " AND sentiment = {s:String}" : ""}
     GROUP BY issue HAVING n > 0 ORDER BY ${mode === "engagement" ? "e" : "n"} DESC, n DESC LIMIT {lim:UInt32}`,
    { ...w.params, lim: limit, s: sentiment ?? "" },
  );
  return { items: rows.map((r) => ({ issue: r.issue, count: Number(r.n), engagement: Number(r.e) })) };
}

export async function topAccounts(
  ch: ClickHouseClient,
  f: AnalyticsFilter,
  by: "posts" | "engagement" | "replies" | "reposts" = "posts",
  limit = 10,
  sentiment?: string,
) {
  const w = base(f, "bucket", true);
  if (sentiment) w.where += " AND sentiment = {s:String}";
  const rows = await q<{ platform: string; author_id: string; handle: string; value: string; followers: string | null }>(
    ch,
    `SELECT platform, author_id, anyLast(author_handle) AS handle, sum(${by}) AS value, anyLast(author_followers) AS followers
     FROM agg_author_1d WHERE ${w.where} GROUP BY platform, author_id HAVING value > 0 ORDER BY value DESC LIMIT {lim:UInt32}`,
    { ...w.params, lim: limit, s: sentiment ?? "" },
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

export interface FeedOptions {
  sentiment?: string;
  emotion?: string;
  hashtag?: string;
  issue?: string;
  authorId?: string;
  region?: string;
  contentType?: string;
  sort?: "latest" | "engagement";
  limit: number;
  offset: number;
}

/** WHERE atas topic_matches FINAL untuk feed + drill-down widget (klik chart → post di baliknya). */
function feedWhere(f: AnalyticsFilter, o: FeedOptions) {
  const w = ["tenant_id = {t:UUID}", "topic_id = {topic:UUID}", "published_at >= {from:DateTime}", "published_at <= {to:DateTime}"];
  if (f.platforms?.length) w.push("platform IN {pl:Array(String)}");
  if (o.sentiment) w.push("sentiment = {s:String}");
  if (o.emotion) w.push("emotion = {e:String}");
  if (o.hashtag) w.push("has(arrayMap(x -> lower(x), hashtags), lower({h:String}))");
  if (o.issue) w.push("has(issues, {i:String})");
  if (o.authorId) w.push("author_id = {a:String}");
  if (o.region) w.push("geo_region_code = {r:String}");
  // "replies"/"reposts" = kelompok jenis konten (komentar & balasan / repost & quote)
  if (o.contentType === "replies") w.push("content_type IN ('reply', 'comment')");
  else if (o.contentType === "reposts") w.push("content_type IN ('repost', 'quote')");
  else if (o.contentType) w.push("content_type = {ct:String}");
  return {
    where: w.join(" AND "),
    params: {
      t: f.tenantId,
      topic: f.topicId,
      from: chTs(f.from),
      to: chTs(f.to),
      pl: f.platforms ?? [],
      s: o.sentiment ?? "",
      e: o.emotion ?? "",
      h: (o.hashtag ?? "").replace(/^#/, ""),
      i: o.issue ?? "",
      a: o.authorId ?? "",
      r: o.region ?? "",
      ct: o.contentType ?? "",
    },
  };
}

/** D-02 feed: post match topik (label terbaru via topic_matches FINAL), tanpa demografi individu (SEC-09). */
export async function feed(ch: ClickHouseClient, f: AnalyticsFilter, o: FeedOptions) {
  const w = feedWhere(f, o);
  const order = o.sort === "engagement" ? "engagement DESC, published_at DESC" : "published_at DESC";
  const rows = await q<Record<string, unknown>>(
    ch,
    `SELECT m.platform AS platform, m.post_id AS post_id, toString(m.published_at) AS published_at, toString(m.sentiment) AS sentiment,
            m.sentiment_score AS sentiment_score, toString(m.emotion) AS emotion, m.engagement AS engagement, m.engagement_known AS engagement_known,
            m.content_type AS content_type, m.hashtags AS hashtags, m.issues AS issues, m.author_id AS author_id, m.author_handle AS author_handle,
            m.model_version AS model_version, p.text AS text, p.url AS url, p.author_name AS author_name, p.author_followers AS author_followers
     FROM (SELECT * FROM topic_matches FINAL WHERE ${w.where}
           ORDER BY ${order} LIMIT {lim:UInt32} OFFSET {off:UInt32}) AS m
     LEFT JOIN (SELECT platform, post_id, text, url, author_name, author_followers FROM posts FINAL) AS p ON p.platform = m.platform AND p.post_id = m.post_id
     ORDER BY ${o.sort === "engagement" ? "m.engagement DESC, m.published_at DESC" : "m.published_at DESC"}`,
    { ...w.params, lim: o.limit, off: o.offset },
  );
  return rows.map((r) => ({
    ...r,
    engagement: r.engagement_known ? Number(r.engagement) : null,
    engagement_known: undefined,
    author_followers: r.author_followers === null || r.author_followers === undefined ? null : Number(r.author_followers),
  }));
}

/** Jumlah post untuk filter feed yang sama (untuk "N post" di popup drill-down). */
export async function feedCount(ch: ClickHouseClient, f: AnalyticsFilter, o: FeedOptions) {
  const w = feedWhere(f, o);
  const [r] = await q<{ n: string }>(ch, `SELECT count() AS n FROM topic_matches FINAL WHERE ${w.where}`, w.params);
  return Number(r?.n ?? 0);
}

/**
 * D-04 Psikografi (AI_SPEC §12.4): proporsi gender & rentang usia (berbasis post dari akun ber-label ≥ τ) + sentimen per kelompok.
 * Hanya agregat; `coverage_pct` = porsi post dari akun yang terdeteksi — bucket unknown tidak disembunyikan (AGENTS §3a).
 * `below_18` tidak pernah tersimpan per akun (ADR-007) sehingga tidak muncul.
 */
export async function psychography(ch: ClickHouseClient, f: AnalyticsFilter) {
  const one = async (table: string, col: string) => {
    const w = base(f, "bucket", true);
    const rows = await q<{ k: string; s: string; n: string }>(
      ch,
      `SELECT toString(${col}) AS k, toString(sentiment) AS s, sum(posts) AS n FROM ${table} WHERE ${w.where} GROUP BY k, s HAVING n != 0`,
      w.params,
    );
    const total = rows.reduce((a, r) => a + Number(r.n), 0);
    const known = rows.filter((r) => r.k !== "unknown");
    const knownTotal = known.reduce((a, r) => a + Number(r.n), 0);
    const by = new Map<string, Record<string, number>>();
    for (const r of known) {
      const m = by.get(r.k) ?? { negative: 0, neutral: 0, positive: 0 };
      m[r.s] = (m[r.s] ?? 0) + Number(r.n);
      by.set(r.k, m);
    }
    return {
      total,
      unknown: total - knownTotal,
      coverage_pct: total ? Math.round((knownTotal / total) * 1000) / 10 : 0,
      items: [...by].map(([k, s]) => {
        const n = s.negative! + s.neutral! + s.positive!;
        return { key: k, count: n, pct: knownTotal ? Math.round((n / knownTotal) * 1000) / 10 : 0, sentiment: s };
      }),
    };
  };
  const [gender, age] = await Promise.all([one("agg_psycho_gender_1d", "author_gender"), one("agg_psycho_age_1d", "author_age_range")]);
  return { gender, age, basis: "post dari akun yang terdeteksi (perkiraan per akun, ambang confidence)" };
}
