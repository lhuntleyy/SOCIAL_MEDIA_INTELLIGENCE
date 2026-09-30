// D-01/D-02 (API_SPEC §5): analitik & feed dari agregat ClickHouse — SEC-01 isolasi tenant (topik tenant lain → 404,
// filter tenant_id selalu dari token), validasi parameter, angka sesuai event ber-sign (−1/+1 relabel ikut benar).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ClickHouseClient, createClient } from "@clickhouse/client";
import { chUp } from "@smip/analytics";
import { type ApiHarness, apiHarness, infraUp, tid } from "./helpers";

const CH_URL = process.env.TEST_CLICKHOUSE_URL ?? "http://smip:smip_dev@127.0.0.1:58123";
const up =
  (await infraUp()) &&
  (await fetch(`${new URL(CH_URL).origin}/ping`)
    .then((r) => r.ok)
    .catch(() => false));
const [A, B, TA, TB, UA, UB] = [1, 2, 3, 4, 5, 6].map(tid) as [string, string, string, string, string, string];

describe.skipIf(!up)("D-01 analytics", () => {
  let h: ApiHarness;
  const chName = `smip_an_${Date.now()}`;
  let chAdmin: ClickHouseClient;
  let ch: ClickHouseClient;
  let ta: string;
  let tb: string;
  const get = async (p: string, t: string) => {
    const r = await h.call("GET", p, { token: t });
    return { status: r.status, json: (await r.json()) as { data: never } };
  };
  beforeAll(async () => {
    chAdmin = createClient({ url: CH_URL });
    await chAdmin.command({ query: `CREATE DATABASE ${chName}` });
    ch = createClient({ url: CH_URL, database: chName });
    await chUp(ch);
    h = await apiHarness("an", undefined, (db) => ({ analytics: { db, ch } }));
    await h.sql`insert into tenants (id, slug, name) values (${A}, 'a', 'A'), (${B}, 'b', 'B')`;
    await h.sql`insert into topics (id, tenant_id, name) values (${TA}, ${A}, 'KDMP'), (${TB}, ${B}, 'Lain')`;
    ta = await h.token({ sub: UA, tid: A, role: "analyst" });
    tb = await h.token({ sub: UB, tid: B, role: "analyst" });
    const now = Date.now();
    const ev = (k: number, sentiment: string, emotion: string, sign: number, mv: string, tenant = A, topic = TA) => ({
      tenant_id: tenant,
      topic_id: topic,
      topic_query_id: tid(9),
      platform: "x",
      post_id: `p${k}`,
      content_type: "post",
      published_at: new Date(now - (k + 1) * 3_600_000).toISOString().replace("T", " ").slice(0, 23),
      author_id: `a${k % 2}`,
      author_handle: `akun${k % 2}`,
      author_created_year: null,
      author_followers: 100,
      sentiment,
      sentiment_score: 0.9,
      emotion,
      emotion_score: 0.8,
      author_gender: "unknown",
      author_gender_conf: 0,
      author_age_range: "unknown",
      author_age_conf: 0,
      model_version: mv,
      issues: k <= 1 ? ["gaji kopdes"] : [],
      hashtags: k === 0 ? ["kopdes"] : [],
      parent_author_id: null,
      parent_author_handle: null,
      geo_region_code: k === 0 ? "31" : null,
      media: [],
      engagement: 10,
      engagement_known: 1,
      sign,
      event_at: new Date(now).toISOString().replace("T", " ").slice(0, 23),
    });
    await ch.insert({
      table: "topic_match_events",
      format: "JSONEachRow",
      values: [
        ev(0, "neutral", "unknown", 1, "stub-0"),
        ev(0, "neutral", "unknown", -1, "stub-0"), // relabel: −1 lalu +1 label baru
        ev(0, "negative", "anger", 1, "llm:v1"),
        ev(1, "negative", "disgust", 1, "llm:v1"),
        ev(2, "positive", "joy", 1, "llm:v1"),
        ev(3, "negative", "anger", 1, "llm:v1", B, TB), // tenant lain
      ],
    });
    await ch.insert({
      table: "posts",
      format: "JSONEachRow",
      values: [
        {
          platform: "x",
          post_id: "p0",
          text: "kopdes gaji belum cair",
          published_at: new Date(now - 3_600_000).toISOString().replace("T", " ").slice(0, 23),
          author_id: "a0",
          author_handle: "akun0",
          hashtags: ["kopdes"],
          mentions: [],
          media: "[]",
          matched: 1,
          source_connector: "fake.x",
          raw_ref: "",
          ingested_at: new Date(now).toISOString().replace("T", " ").slice(0, 23),
          version: 1,
          content_type: "post",
          lang: "id",
        },
      ],
    });
  });
  afterAll(async () => {
    await h?.close();
    await ch?.close();
    await chAdmin?.command({ query: `DROP DATABASE IF EXISTS ${chName}` });
    await chAdmin?.close();
  });

  test("proporsi, ringkasan, emosi, hashtag, lokasi, feed — angka ber-sign benar; hanya data tenant sendiri", async () => {
    const p = await get(`/analytics/sentiment/proportion?topic_id=${TA}`, ta);
    expect(p.status).toBe(200);
    expect((p.json.data as { total: number; items: { sentiment: string; count: number; pct: number }[] }).items).toEqual([
      { sentiment: "negative", count: 2, pct: 66.67 },
      { sentiment: "positive", count: 1, pct: 33.33 },
    ]);
    const s = await get(`/analytics/summary?topic_id=${TA}`, ta);
    expect((s.json.data as { current: unknown }).current).toMatchObject({ posts: 3, engagement: 30, negative: 2, positive: 1, authors: 2 });
    const e = await get(`/analytics/emotion/proportion?topic_id=${TA}`, ta);
    expect((e.json.data as { items: { emotion: string }[] }).items.map((i) => i.emotion).sort()).toEqual(["anger", "disgust", "joy"]);
    expect(((await get(`/analytics/hashtags?topic_id=${TA}`, ta)).json.data as { items: unknown[] }).items).toEqual([
      { hashtag: "kopdes", count: 1, engagement: 10 },
    ]);
    // isu: pasangan relabel −1/+1 saling meniadakan → 2 post (p0 label baru + p1)
    expect(((await get(`/analytics/issues?topic_id=${TA}`, ta)).json.data as { items: unknown[] }).items).toEqual([
      { issue: "gaji kopdes", count: 2, engagement: 20 },
    ]);
    const tl = (await get(`/analytics/sentiment/timeline?topic_id=${TA}&granularity=1h`, ta)).json.data as {
      series: { key: string; values: number[] }[];
    };
    expect(tl.series.map((x) => [x.key, x.values.reduce((a, b) => a + b, 0)])).toEqual([
      ["negative", 2],
      ["neutral", 0],
      ["positive", 1],
    ]);
    const feed = (await get(`/posts?topic_id=${TA}&sentiment=negative`, ta)).json.data as {
      post_id: string;
      sentiment: string;
      text: string | null;
    }[];
    expect(feed.map((x) => [x.post_id, x.sentiment])).toEqual([
      ["p0", "negative"],
      ["p1", "negative"],
    ]);
    expect(feed[0]!.text).toBe("kopdes gaji belum cair");
  });

  test("drill-down feed (klik widget → post): hashtag, lokasi, akun, sort engagement, total; widget tambahan", async () => {
    const posts = async (qs: string) => {
      const r = await h.call("GET", `/posts?topic_id=${TA}&count=1&${qs}`, { token: ta });
      const j = (await r.json()) as { data: { post_id: string }[]; meta: { total?: number } };
      return { ids: j.data.map((x) => x.post_id), total: j.meta.total };
    };
    expect(await posts("hashtag=%23KOPDES")).toEqual({ ids: ["p0"], total: 1 }); // '#' & huruf besar diabaikan
    expect(await posts("region=31")).toEqual({ ids: ["p0"], total: 1 });
    expect(await posts("author_id=a1")).toEqual({ ids: ["p1"], total: 1 });
    expect((await posts("sentiment=negative&emotion=anger")).ids).toEqual(["p0"]);
    expect((await posts("content_type=replies")).total).toBe(0);
    expect((await posts("sort=engagement&limit=2")).total).toBe(3);
    // total hanya bila diminta
    const plain = (await (await h.call("GET", `/posts?topic_id=${TA}`, { token: ta })).json()) as { meta: { total?: number } };
    expect(plain.meta.total).toBeUndefined();
    expect((await get(`/posts?topic_id=${TA}&region=31;drop`, ta)).status).toBe(400);

    const emo = (await get(`/analytics/emotion/timeline?topic_id=${TA}&granularity=1h`, ta)).json.data as {
      series: { key: string; values: number[] }[];
    };
    const sum = Object.fromEntries(emo.series.map((x) => [x.key, x.values.reduce((a, b) => a + b, 0)]));
    expect(sum).toMatchObject({ anger: 1, disgust: 1, joy: 1, trust: 0 });
    const br = (await get(`/analytics/platforms?topic_id=${TA}`, ta)).json.data as { items: unknown[] };
    expect(br.items).toEqual([{ platform: "x", content_type: "post", count: 3, engagement: 30 }]);
    const act = (await get(`/analytics/accounts/active?topic_id=${TA}`, ta)).json.data as { series: { values: number[] }[] };
    expect(Math.max(...act.series[0]!.values)).toBeGreaterThanOrEqual(1);
    const heat = (await get(`/analytics/activity?topic_id=${TA}`, ta)).json.data as { cells: { count: number }[] };
    expect(heat.cells.reduce((a, c) => a + c.count, 0)).toBe(3);
    const neg = (await get(`/analytics/accounts/top?topic_id=${TA}&sentiment=negative&by=engagement`, ta)).json.data as {
      items: { handle: string; value: number }[];
    };
    expect(neg.items.map((i) => [i.handle, i.value]).sort()).toEqual([
      ["akun0", 10],
      ["akun1", 10],
    ]);
    const eng = (await get(`/analytics/exposure?topic_id=${TA}&mode=engagement&granularity=1h`, ta)).json.data as {
      series: { values: number[] }[];
    };
    expect(eng.series[0]!.values.reduce((a, b) => a + b, 0)).toBe(30);
    expect((await get(`/analytics/accounts/created-year?topic_id=${TA}`, ta)).status).toBe(200);
    expect((await get(`/analytics/accounts/reposted?topic_id=${TA}`, ta)).status).toBe(200);
    // widget baru tetap terisolasi tenant
    expect((await get(`/analytics/platforms?topic_id=${TA}`, tb)).status).toBe(404);
  });

  test("SEC-01: topik tenant lain → 404; parameter tidak valid → 400", async () => {
    expect((await get(`/analytics/sentiment/proportion?topic_id=${TA}`, tb)).status).toBe(404);
    expect((await get(`/posts?topic_id=${TA}`, tb)).status).toBe(404);
    const own = (await get(`/analytics/summary?topic_id=${TB}`, tb)).json.data as { current: { posts: number } };
    expect(own.current.posts).toBe(1);
    expect((await get(`/analytics/summary?topic_id=bukan-uuid`, ta)).status).toBe(400);
    expect((await get(`/analytics/summary?topic_id=${TA}&from=2026-09-10T00:00:00Z&to=2026-09-01T00:00:00Z`, ta)).status).toBe(400);
  });
});
