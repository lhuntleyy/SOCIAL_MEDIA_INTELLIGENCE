// I-17 contract suite + normalizer connector Apify (xquik X). HTTP di-mock — CI tidak memanggil Apify.
import { describe, expect, test } from "bun:test";
import { CanonicalItem } from "@smip/contracts";
import { HttpClient } from "@smip/connector-sdk";
import { contractContext, runContractSuite } from "@smip/connector-sdk/contract";
import { ApifyActorConnector, X_XQUIK, normalizeXquik, xWindowOperators } from "../src";
import fixture from "./fixtures/xquik-items.json";

const TOKEN = "apify_api_TEST_rahasia_1234567890";
type Mode = "ok" | "running" | "failed" | "401" | "402" | "429" | "500";
let mode: Mode = "ok";
const setMode = (m: Mode) => () => {
  mode = m;
};
const calls: { method: string; path: string; body?: unknown }[] = [];

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** Mock API Apify (bentuk respons docs.apify.com/api/v2). */
async function mockFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const u = new URL(String(input));
  calls.push({ method: init?.method ?? "GET", path: u.pathname + u.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
  if ((init?.headers as Record<string, string>)?.Authorization !== `Bearer ${TOKEN}` || mode === "401")
    return json(401, { error: { type: "token-not-valid" } });
  if (mode === "402") return json(402, { error: { type: "not-enough-usage-to-run-paid-actor" } });
  if (mode === "429") return json(429, { error: { type: "rate-limit-exceeded" } }, { "retry-after": "20" });
  if (mode === "500") return json(503, { error: { type: "internal" } });
  if (u.pathname === "/v2/users/me/limits") return json(200, { data: { current: { monthlyUsageUsd: 1 } } });
  const run = (status: string) => ({
    data: { id: "run123", status, defaultDatasetId: "ds123", startedAt: "2026-09-29T01:50:00.000Z", usageTotalUsd: 0.0009 },
  });
  if (u.pathname === "/v2/acts/xquik~x-tweet-scraper/runs")
    return json(201, run(mode === "running" ? "RUNNING" : mode === "failed" ? "FAILED" : "SUCCEEDED"));
  if (u.pathname === "/v2/actor-runs/run123") return json(200, run("SUCCEEDED"));
  if (u.pathname === "/v2/datasets/ds123/items") return json(200, fixture);
  return json(404, { error: { type: "not-found" } });
}

const http = new HttpClient({
  allowedHosts: ["api.apify.com"],
  resolver: async () => ["93.184.216.34"],
  fetchImpl: mockFetch,
  timeoutMs: 2000,
});
const connector = new ApifyActorConnector(X_XQUIK);
const credential = { kind: "api_key" as const, secret: { api_token: TOKEN } };
const req = (o: Partial<Parameters<typeof connector.fetch>[0]> = {}) => ({
  requestId: "0192f000-0000-7000-8000-000000000001",
  idempotencyKey: "run.x.attempt.1.q0.page.1",
  platform: "x",
  operation: "search_keyword" as const,
  query: { native: '"koperasi merah putih" OR kopdes', sourceNodeIds: [] },
  window: { since: "2026-09-28T00:00:00.000Z", until: "2026-09-29T02:00:00.000Z" },
  cursor: null,
  pageLimit: 1,
  maxItems: 50,
  ...o,
});

runContractSuite("apify.x.xquik", () => ({
  connector,
  credential,
  config: { maxTotalChargeUsd: 0.05, memoryMb: 1024 },
  http,
  secretValues: [TOKEN],
  scenarios: [
    { name: "sukses", setup: setMode("ok"), request: req(), expect: "ok" },
    { name: "token salah", setup: setMode("401"), request: req(), expect: "AUTH_INVALID" },
    { name: "kredit Apify habis", setup: setMode("402"), request: req(), expect: "QUOTA_EXHAUSTED" },
    { name: "rate limit", setup: setMode("429"), request: req(), expect: "RATE_LIMITED" },
    { name: "5xx", setup: setMode("500"), request: req(), expect: "UPSTREAM_5XX" },
    { name: "run FAILED", setup: setMode("failed"), request: req(), expect: "UPSTREAM_5XX" },
    { name: "operation tak didukung", setup: setMode("ok"), request: req({ operation: "profile" }), expect: "NOT_SUPPORTED" },
  ],
}));

describe("apify.x.xquik", () => {
  const ctx = () => contractContext({ credential, config: { maxTotalChargeUsd: 0.05, memoryMb: 1024 }, http });

  test("input actor: query + operator waktu Unix, Latest, maxItems; biaya/memori dari config ke query string", async () => {
    mode = "ok";
    calls.length = 0;
    await connector.fetch(req(), ctx());
    const start = calls.find((c) => c.method === "POST")!;
    expect(start.body).toEqual({
      searchTerms: ['"koperasi merah putih" OR kopdes since_time:1790553600 until_time:1790647200'],
      maxItems: 50,
      queryType: "Latest",
    });
    expect(start.path).toContain("memory=1024");
    expect(start.path).toContain("maxTotalChargeUsd=0.05");
    expect(start.path).toContain("waitForFinish=50");
    expect(xWindowOperators(undefined)).toBe("");
  });

  test("normalisasi: post/reply/repost; bio & data profil lain dibuang; item tanpa handle / di luar window dibuang; usage = dikembalikan", async () => {
    mode = "ok";
    const r = await connector.fetch(req(), ctx());
    expect(r.items.map((i) => [i.platform_post_id.slice(-1), i.content_type])).toEqual([
      ["1", "post"],
      ["2", "reply"],
      ["3", "repost"],
    ]);
    const [post, reply, repost] = r.items;
    expect(post).toMatchObject({
      published_at: "2026-09-29T01:22:46.000Z",
      lang_hint: "in",
      hashtags: ["kopdes"],
      media: [{ type: "image", url: "https://pbs.example.invalid/m1.jpg", thumb: null }],
      metrics: { likes: 12, comments: 3, shares: 2, views: 450, quotes: 0, saves: 1 },
      author: {
        platform_user_id: "1001",
        handle: "akun_satu",
        followers: 150,
        created_at: "2019-03-02T00:00:00.000Z",
        location_raw: "Bandung, Jawa Barat",
      },
      root_post_id: null,
    });
    expect(JSON.stringify(post)).not.toContain("bio yang tidak boleh ikut");
    expect(reply).toMatchObject({
      parent: { platform_post_id: "1840000000000000001", author: { platform_user_id: "1001", handle: "akun_satu" } },
      root_post_id: "1840000000000000001",
    });
    expect(reply!.author.location_raw).toBeNull(); // "" → null, bukan string kosong
    expect(repost).toMatchObject({ parent: null, metrics: { likes: null, views: null } }); // tak diketahui = null
    expect(r.usage).toEqual({ requests: 2, results: 5, costUnits: 0.0009, costUnitLabel: "usd" });
    expect(r.warnings[0]?.code).toBe("ITEMS_DROPPED");
    for (const it of r.items) expect(CanonicalItem.safeParse(it).success).toBe(true);
  });

  test("run belum selesai → asyncHandle (tanpa item), lalu resume mengambil dataset", async () => {
    mode = "running";
    const r = await connector.fetch(req(), ctx());
    expect(r).toMatchObject({ items: [], hasMore: true, asyncHandle: { kind: "apify-run", id: "run123" } });
    mode = "ok";
    const done = await connector.resume(r.asyncHandle!, ctx(), req());
    expect(done.items).toHaveLength(3);
    await expect(connector.resume({ ...r.asyncHandle!, kind: "lain" }, ctx())).rejects.toMatchObject({ code: "INVALID_QUERY" });
  });

  test("normalizer menolak waktu tak pasti (JANGAN menebak)", () => {
    const meta = { key: "apify.x.xquik", version: "0.1.0", fetchedAt: "2026-09-29T02:00:00.000Z", rawRef: null };
    expect(normalizeXquik({ ...fixture[0], createdAt: "2 jam lalu" }, meta)).toBeNull();
    expect(normalizeXquik({ ...fixture[0], createdAt: "2026-09-29T01:00:00" }, meta)).toBeNull();
  });
});
