// I-18 contract suite + normalizer YouTube Data API v3. HTTP di-mock (bentuk respons dari probe 2026-09-29,
// docs/evidence/shapes/shape-youtube-data-api.json; isi fixture SINTETIS). CI tidak memanggil Google.
import { describe, expect, test } from "bun:test";
import { HttpClient } from "@smip/connector-sdk";
import { contractContext, runContractSuite } from "@smip/connector-sdk/contract";
import { CanonicalItem } from "@smip/contracts";
import { classifyGoogleError, normalizeVideo, toYoutubeQuery, YoutubeDataConnector } from "../src";

const KEY = "AIzaTESTkeyRAHASIA_0123456789abcdefghijk";
type Mode = "ok" | "badkey" | "quota" | "ratelimit" | "disabled" | "500" | "badreq";
let mode: Mode = "ok";
const setMode = (m: Mode) => () => {
  mode = m;
};
const calls: string[] = [];
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const gErr = (code: number, reason: string, detail?: string) =>
  json(code, {
    error: { code, message: "x", errors: [{ reason, domain: "youtube" }], ...(detail ? { details: [{ reason: detail }] } : {}) },
  });

const video = (id: string, at: string, o: Record<string, unknown> = {}) => ({
  kind: "youtube#video",
  id,
  snippet: {
    publishedAt: at,
    channelId: "UCsintetis001",
    title: `Video sintetis ${id}`,
    description: "Deskripsi uji #KopDes #kopdes dan #MerahPutih",
    thumbnails: { high: { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` } },
    channelTitle: "Kanal Sintetis",
    defaultAudioLanguage: "id",
  },
  statistics: { viewCount: "721", likeCount: "3", favoriteCount: "0", commentCount: "0" },
  ...o,
});

async function mockFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const u = new URL(String(input));
  calls.push(u.pathname + u.search);
  const h = init?.headers as Record<string, string>;
  if (h["X-Goog-Api-Key"] !== KEY || mode === "badkey") return gErr(400, "badRequest", "API_KEY_INVALID");
  if (mode === "quota") return gErr(403, "quotaExceeded");
  if (mode === "ratelimit") return gErr(403, "rateLimitExceeded");
  if (mode === "disabled") return gErr(403, "accessNotConfigured", "SERVICE_DISABLED");
  if (mode === "500") return json(503, { error: { code: 503 } });
  if (mode === "badreq") return gErr(400, "invalidSearchFilter");
  if (u.pathname === "/youtube/v3/search")
    return json(200, {
      kind: "youtube#searchListResponse",
      nextPageToken: u.searchParams.get("pageToken") ? undefined : "CAUQAA",
      pageInfo: { totalResults: 3, resultsPerPage: 3 },
      items: ["v1", "v2", "v3"].map((v) => ({ kind: "youtube#searchResult", id: { kind: "youtube#video", videoId: v } })),
    });
  if (u.pathname === "/youtube/v3/videos")
    return json(200, {
      items: [
        video("v1", "2026-09-29T07:00:21Z"),
        video("v2", "2026-09-29T06:58:09Z", { statistics: {} }),
        video("v3", "2026-09-20T00:00:00Z"), // di luar window → dibuang lokal
      ].filter((v) => (u.searchParams.get("id") ?? "").split(",").includes(v.id)),
    });
  if (u.pathname === "/youtube/v3/channels")
    return json(200, {
      items: [
        {
          id: "UCsintetis001",
          snippet: { title: "Kanal Sintetis", customUrl: "@kanalsintetis", publishedAt: "2020-01-01T00:00:00Z" },
          statistics: { subscriberCount: "1200", hiddenSubscriberCount: false },
        },
      ],
    });
  if (u.pathname === "/youtube/v3/i18nRegions") return json(200, { items: [] });
  return json(404, { error: { code: 404 } });
}

const http = new HttpClient({
  allowedHosts: ["www.googleapis.com"],
  resolver: async () => ["142.250.4.95"],
  fetchImpl: mockFetch,
  timeoutMs: 2000,
});
const connector = new YoutubeDataConnector();
const credential = { kind: "api_key" as const, secret: { api_key: KEY } };
const req = (o: Partial<Parameters<typeof connector.fetch>[0]> = {}) => ({
  requestId: "0192f000-0000-7000-8000-000000000001",
  idempotencyKey: "run.yt.attempt.1.q0.page.1",
  platform: "youtube",
  operation: "search_keyword" as const,
  query: { native: '"koperasi merah putih" OR kopdes', sourceNodeIds: [] },
  window: { since: "2026-09-28T00:00:00.000Z", until: "2026-09-29T08:00:00.000Z" },
  cursor: null,
  pageLimit: 1,
  maxItems: 50,
  ...o,
});

runContractSuite("youtube_data_api.youtube", () => ({
  connector,
  credential,
  config: { regionCode: "ID", relevanceLanguage: "id" },
  http,
  secretValues: [KEY],
  scenarios: [
    { name: "sukses", setup: setMode("ok"), request: req(), expect: "ok" },
    { name: "key salah", setup: setMode("badkey"), request: req(), expect: "AUTH_INVALID" },
    { name: "quota harian habis", setup: setMode("quota"), request: req(), expect: "QUOTA_EXHAUSTED" },
    { name: "rate limit", setup: setMode("ratelimit"), request: req(), expect: "RATE_LIMITED" },
    { name: "API belum diaktifkan", setup: setMode("disabled"), request: req(), expect: "FORBIDDEN" },
    { name: "5xx", setup: setMode("500"), request: req(), expect: "UPSTREAM_5XX" },
    { name: "filter tidak valid", setup: setMode("badreq"), request: req(), expect: "INVALID_QUERY" },
    { name: "operation tak didukung", setup: setMode("ok"), request: req({ operation: "profile" }), expect: "NOT_SUPPORTED" },
  ],
}));

describe("youtube_data_api.youtube", () => {
  const ctx = () => contractContext({ credential, config: { regionCode: "ID" }, http });

  test("search → videos → channels: item valid, window dijaga lokal, cursor = nextPageToken, key hanya di header", async () => {
    mode = "ok";
    calls.length = 0;
    const r = await connector.fetch(req(), ctx());
    expect(r.items.map((i) => i.platform_post_id)).toEqual(["v1", "v2"]);
    for (const it of r.items) expect(CanonicalItem.safeParse(it).success).toBe(true);
    expect(r.nextCursor).toBe("CAUQAA");
    expect(r.hasMore).toBe(true);
    expect(r.usage).toEqual({ requests: 3, results: 3, costUnits: 0, costUnitLabel: "usd" });
    const s = new URL(`https://x${calls[0]}`).searchParams;
    expect(Object.fromEntries(s)).toMatchObject({
      part: "id",
      type: "video",
      order: "date",
      q: '"koperasi merah putih"|kopdes',
      publishedAfter: "2026-09-28T00:00:00.000Z",
      publishedBefore: "2026-09-29T08:00:00.000Z",
      regionCode: "ID",
    });
    expect(calls.join(" ")).not.toContain(KEY);
    const a = r.items[0]!;
    expect(a.author).toMatchObject({ handle: "kanalsintetis", followers: 1200, display_name: "Kanal Sintetis" });
    expect(a.metrics).toMatchObject({ views: 721, likes: 3, comments: 0, shares: null });
    expect(a.hashtags).toEqual(["kopdes", "merahputih"]);
    expect(a.lang_hint).toBe("id");
    expect(r.items[1]!.metrics.likes).toBeNull(); // statistik disembunyikan → null, bukan 0
    const p2 = await connector.fetch(req({ cursor: "CAUQAA" }), ctx());
    expect([p2.nextCursor, p2.hasMore]).toEqual([null, false]);
  });

  test("post_detail (engagement refresh): videos.list per id tanpa search", async () => {
    mode = "ok";
    calls.length = 0;
    const r = await connector.fetch(req({ operation: "post_detail", query: undefined, targetIds: ["v1", "v3"] }), ctx());
    expect(r.items.map((i) => i.platform_post_id)).toEqual(["v1", "v3"]);
    expect(calls.some((c) => c.startsWith("/youtube/v3/search"))).toBe(false);
    await expect(connector.fetch(req({ operation: "post_detail", query: undefined, targetIds: [] }), ctx())).rejects.toMatchObject({
      code: "INVALID_QUERY",
    });
  });

  test("query native → sintaks YouTube; klasifikasi error Google; subscriber tersembunyi = null", () => {
    expect(toYoutubeQuery('("banjir" OR bencana) OR "gempa bumi"')).toBe('"banjir"|bencana|"gempa bumi"');
    expect(classifyGoogleError(403, { error: { errors: [{ reason: "dailyLimitExceeded" }] } }).code).toBe("QUOTA_EXHAUSTED");
    expect(classifyGoogleError(400, { error: { details: [{ reason: "API_KEY_INVALID" }] } }).code).toBe("AUTH_INVALID");
    expect(classifyGoogleError(502, null).code).toBe("UPSTREAM_5XX");
    const it = normalizeVideo(
      video("v9", "2026-09-29T07:00:21Z"),
      { id: "UCsintetis001", snippet: {}, statistics: { subscriberCount: "0", hiddenSubscriberCount: true } },
      { fetchedAt: "2026-09-29T08:00:00.000Z", rawRef: null },
    );
    expect(it!.author.followers).toBeNull();
    expect(it!.author.handle).toBe("UCsintetis001");
    expect(normalizeVideo(video("v8", "2026-09-29T07:00:21", {}), undefined, { fetchedAt: "x", rawRef: null })).toBeNull(); // tanpa zona
  });

  test("health probe murah (tanpa bucket search)", async () => {
    mode = "ok";
    calls.length = 0;
    expect((await connector.healthProbe(ctx())).ok).toBe(true);
    expect(calls[0]).toStartWith("/youtube/v3/i18nRegions");
    mode = "badkey";
    expect(await connector.healthProbe(ctx())).toMatchObject({ ok: false, errorCode: "AUTH_INVALID" });
  });
});
