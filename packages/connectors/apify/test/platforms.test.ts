// I-18 contract suite + normalizer connector Apify per platform. Fixture SINTETIS mengikuti bentuk hasil probe
// (docs/evidence/shapes/*.json) — tanpa konten/akun asli; HTTP di-mock (CI tidak memanggil Apify).
import { describe, expect, test } from "bun:test";
import { CanonicalItem } from "@smip/contracts";
import { HttpClient } from "@smip/connector-sdk";
import { contractContext, runContractSuite } from "@smip/connector-sdk/contract";
import {
  ApifyActorConnector,
  type ActorSpec,
  FACEBOOK_SCRAPERONE,
  fbHandle,
  INSTAGRAM_BOOLEAN,
  THREADS_SCRAPERSDELIGHT,
  TIKTOK_APIDOJO,
  tiktokDateRange,
  X_APIDOJO,
  windowAgeDays,
  YOUTUBE_STREAMERS,
  youtubeDateFilter,
} from "../src";

const TOKEN = "apify_api_TEST_platforms_987654321";
const IN = "2026-09-29T01:00:00.000Z"; // di dalam window
const OUT = "2026-09-20T01:00:00.000Z"; // di luar window (dibuang)
const tw = (iso: string) => new Date(iso).toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT$/, "$1 $3 $2 $5 +0000 $4");

const FIXTURES: Record<string, { spec: ActorSpec; items: unknown[]; expectCount: number }> = {
  x_apidojo: {
    spec: X_APIDOJO,
    expectCount: 2,
    items: [
      {
        id: "1850000000000000001",
        url: "https://x.com/u1/status/1850000000000000001",
        fullText: "kopdes jalan #kdmp",
        text: "kopdes jalan",
        lang: "in",
        createdAt: tw(IN),
        conversationId: "1850000000000000001",
        isReply: false,
        isRetweet: false,
        isQuote: false,
        likeCount: 4,
        replyCount: 1,
        retweetCount: 0,
        quoteCount: 0,
        viewCount: 99,
        bookmarkCount: 0,
        author: {
          id: "11",
          userName: "u1",
          name: "U Satu",
          followers: 5,
          following: 6,
          isVerified: false,
          createdAt: tw("2020-01-01T00:00:00.000Z"),
          location: "Surabaya",
        },
        entities: {
          hashtags: [{ text: "kdmp", indices: [13, 18] }],
          user_mentions: [],
          media: [{ type: "photo", media_url_https: "https://pbs.example.invalid/a.jpg" }],
        },
      },
      {
        id: "1850000000000000002",
        text: "kutip kopdes",
        createdAt: tw(IN),
        isQuote: true,
        quoteId: "1850000000000000001",
        quote: { id: "1850000000000000001", author: { id: "11", userName: "u1" } },
        author: { id: "12", userName: "u2" },
        entities: {},
      },
      { id: "1850000000000000003", text: "lama", createdAt: tw(OUT), author: { id: "13", userName: "u3" } },
    ],
  },
  tiktok: {
    spec: TIKTOK_APIDOJO,
    expectCount: 1,
    items: [
      {
        id: "7400000000000000001",
        title: "video kopdes #kdmp",
        uploadedAt: Date.parse(IN) / 1000,
        uploadedAtFormatted: IN,
        postPage: "https://www.tiktok.com/@c1/video/7400000000000000001",
        likes: 10,
        comments: 2,
        shares: 1,
        views: 300,
        bookmarks: 3,
        hashtags: ["kdmp"],
        channel: {
          id: "21",
          username: "c1",
          name: "C Satu",
          followers: 1000,
          following: null,
          verified: true,
          avatar: "https://p.example.invalid/c.jpg",
        },
        video: { url: "https://v.example.invalid/v.mp4", cover: "https://v.example.invalid/c.jpg" },
      },
      { id: "7400000000000000002", title: "tanpa channel → dibuang", uploadedAt: Date.parse(IN) / 1000 },
    ],
  },
  instagram: {
    spec: INSTAGRAM_BOOLEAN,
    expectCount: 1,
    items: [
      {
        shortCode: "Cabc123",
        postId: "3400000000000000001",
        url: "https://www.instagram.com/p/Cabc123/",
        caption: "rapat koperasi merah putih",
        publishedAt: "2026-09-29T08:00:00+07:00",
        username: "desa_a",
        userId: "31",
        fullName: "Desa A",
        verified: false,
        contentType: "reel",
        likeCount: 7,
        commentCount: 1,
        shareCount: 0,
        viewCount: 120,
        hashtags: ["#kdmp"],
        mediaUrl: "https://m.example.invalid/r.mp4",
        thumbnailUrl: "https://m.example.invalid/r.jpg",
        latitude: -6.9,
        longitude: 107.6,
        locationName: "Bandung",
      },
      { shortCode: "Cold", publishedAt: "2026-05-01T00:00:00+00:00", username: "lama", caption: "post lama (tak terurut) → dibuang" },
    ],
  },
  facebook: {
    spec: FACEBOOK_SCRAPERONE,
    expectCount: 2,
    items: [
      {
        postId: "900000000000001",
        url: "https://www.facebook.com/p/900000000000001",
        postText: "kopdes desa kami #kdmp",
        timestamp: Date.parse(IN),
        reactionsCount: 15,
        commentsCount: 3,
        sharesCount: 2,
        author: {
          id: "41",
          name: "Warga Satu",
          profileUrl: "https://www.facebook.com/warga.satu",
          profilePicture: "https://f.example.invalid/w.jpg",
        },
        attachments: [{ type: "Photo", url: "https://f.example.invalid/a.jpg", id: "1" }],
      },
      {
        postId: "900000000000002",
        postText: "profil tanpa username",
        timestamp: Date.parse(IN),
        author: { id: "42", name: "Warga Dua", profileUrl: "https://www.facebook.com/profile.php?id=42" },
      },
    ],
  },
  youtube: {
    spec: YOUTUBE_STREAMERS,
    expectCount: 1,
    items: [
      {
        id: "abcDEF12345",
        url: "https://www.youtube.com/watch?v=abcDEF12345",
        title: "Koperasi Merah Putih",
        text: "deskripsi video",
        date: IN,
        channelId: "UC51",
        channelUsername: "@kanal51",
        channelName: "Kanal 51",
        numberOfSubscribers: 5000,
        likes: 30,
        commentsCount: 4,
        viewCount: 900,
        hashtags: ["#kdmp"],
        thumbnailUrl: "https://i.example.invalid/t.jpg",
      },
    ],
  },
  threads: {
    spec: THREADS_SCRAPERSDELIGHT,
    expectCount: 2,
    items: [
      {
        postId: "3600000000000000001",
        postCode: "DAbc",
        postUrl: "https://www.threads.com/@t1/post/DAbc",
        text: "kopdes #kdmp",
        postedAt: IN,
        authorId: "61",
        authorUsername: "t1",
        authorFullName: "T Satu",
        authorIsVerified: false,
        authorProfilePicUrl: "https://t.example.invalid/p.jpg",
        likeCount: 9,
        replyCount: 1,
        repostCount: 2,
        quoteCount: 0,
        countsHidden: false,
        hashtags: ["kdmp"],
        mentions: [],
        imageUrl: "https://t.example.invalid/i.jpg",
        videoUrl: null,
        isPaidPartnership: true,
        isReply: false,
        language: null,
      },
      {
        postId: "3600000000000000002",
        postUrl: "https://www.threads.com/@t2/post/DAbd",
        text: "balasan kopdes",
        postedAt: IN,
        authorId: "62",
        authorUsername: "t2",
        likeCount: 0,
        countsHidden: true,
        isReply: true,
        isPaidPartnership: false,
      },
      { postId: "3600000000000000003", text: "post lama", postedAt: OUT, authorId: "63", authorUsername: "t3" },
    ],
  },
};

type Mode = "ok" | "401" | "402" | "limited" | "empty";
let mode: Mode = "ok";
const setMode = (m: Mode) => () => {
  mode = m;
};
const byActor = Object.fromEntries(Object.values(FIXTURES).map((f) => [f.spec.actorId.replace("/", "~"), f.items]));
const bodies: Record<string, unknown> = {};

async function mockFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const u = new URL(String(input));
  const j = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
  if ((init?.headers as Record<string, string>)?.Authorization !== `Bearer ${TOKEN}` || mode === "401") return j(401, {});
  if (mode === "402") return j(402, {});
  if (u.pathname === "/v2/users/me/limits") return j(200, { data: {} });
  const m = /^\/v2\/acts\/([^/]+)\/runs$/.exec(u.pathname);
  if (m) {
    bodies[m[1]!] = JSON.parse(String(init?.body));
    return j(201, { data: { id: `run-${m[1]}`, status: "SUCCEEDED", defaultDatasetId: `ds-${m[1]}`, usageTotalUsd: 0.001 } });
  }
  const d = /^\/v2\/datasets\/ds-([^/]+)\/items$/.exec(u.pathname);
  if (d) return j(200, mode === "limited" || mode === "empty" ? [{ noResults: true }, { noResults: true }] : (byActor[d[1]!] ?? []));
  if (/^\/v2\/actor-runs\/[^/]+\/log$/.test(u.pathname))
    return new Response(
      mode === "limited"
        ? "ERROR Monthly run limit exceeded per user.\nPlease subscribe to a paid plan on Apify if you want to use it without monthly limits."
        : "INFO selesai, tidak ada hasil",
      { status: 200 },
    );
  return j(404, {});
}

const http = new HttpClient({
  allowedHosts: ["api.apify.com"],
  resolver: async () => ["93.184.216.34"],
  fetchImpl: mockFetch,
  timeoutMs: 2000,
});
const credential = { kind: "api_key" as const, secret: { api_token: TOKEN } };
const req = (spec: ActorSpec, o: Record<string, unknown> = {}) => ({
  requestId: "0192f000-0000-7000-8000-000000000001",
  idempotencyKey: "run.x.attempt.1.q0.page.1",
  platform: spec.platform,
  operation: "search_keyword" as const,
  query: { native: '"koperasi merah putih"', sourceNodeIds: [] },
  window: { since: "2026-09-28T00:00:00.000Z", until: "2026-09-29T02:00:00.000Z" },
  cursor: null,
  pageLimit: 1,
  maxItems: 20,
  ...o,
});

for (const [name, f] of Object.entries(FIXTURES)) {
  const connector = new ApifyActorConnector(f.spec);
  runContractSuite(f.spec.key, () => ({
    connector,
    credential,
    config: { maxTotalChargeUsd: 0.05 },
    http,
    secretValues: [TOKEN],
    scenarios: [
      { name: "sukses", setup: setMode("ok"), request: req(f.spec), expect: "ok" },
      { name: "token salah", setup: setMode("401"), request: req(f.spec), expect: "AUTH_INVALID" },
      { name: "kredit habis", setup: setMode("402"), request: req(f.spec), expect: "QUOTA_EXHAUSTED" },
      { name: "batas run bulanan plan (placeholder + log)", setup: setMode("limited"), request: req(f.spec), expect: "QUOTA_EXHAUSTED" },
    ],
  }));
  test(`${name}: item valid, di luar window/tanpa field wajib dibuang; usage = dikembalikan`, async () => {
    mode = "ok";
    const r = await connector.fetch(req(f.spec), contractContext({ credential, config: {}, http }));
    expect(r.items).toHaveLength(f.expectCount);
    for (const it of r.items) expect(CanonicalItem.safeParse(it).success).toBe(true);
    expect(r.usage.results).toBe(f.items.length);
  });
}

describe("detail normalizer & input", () => {
  const ctx = () => contractContext({ credential, config: {}, http });
  const fetchOf = async (spec: ActorSpec) => {
    mode = "ok";
    return (await new ApifyActorConnector(spec).fetch(req(spec), ctx())).items;
  };

  test("X apidojo: fullText, media dari entities, quote → parent", async () => {
    const [a, b] = await fetchOf(X_APIDOJO);
    expect(a).toMatchObject({
      text: "kopdes jalan #kdmp",
      hashtags: ["kdmp"],
      media: [{ type: "image" }],
      author: { handle: "u1", location_raw: "Surabaya" },
    });
    expect(b).toMatchObject({
      content_type: "quote",
      parent: { platform_post_id: "1850000000000000001", author: { platform_user_id: "11", handle: "u1" } },
    });
    expect(bodies["apidojo~tweet-scraper"]).toEqual({
      searchTerms: ['"koperasi merah putih" since_time:1790553600 until_time:1790647200'],
      maxItems: 20,
      sort: "Latest",
    });
  });

  test("TikTok: epoch detik, video + cover, bahasa tak diketahui = null; dateRange kasar dipilih dari umur window", async () => {
    const [v] = await fetchOf(TIKTOK_APIDOJO);
    expect(v).toMatchObject({
      published_at: IN,
      lang_hint: null,
      media: [{ type: "video", thumb: "https://v.example.invalid/c.jpg" }],
      metrics: { saves: 3, quotes: null },
    });
    expect([0.5, 3, 20, 60, 120, 400].map(tiktokDateRange)).toEqual([
      "YESTERDAY",
      "THIS_WEEK",
      "THIS_MONTH",
      "LAST_THREE_MONTHS",
      "LAST_SIX_MONTHS",
      "ALL_TIME",
    ]);
    expect(tiktokDateRange(null)).toBe("DEFAULT");
    expect((bodies["apidojo~tiktok-scraper"] as { keywords: string[] }).keywords).toEqual(["koperasi merah putih"]);
  });

  test("Instagram: shortcode sebagai id, offset +07:00 → UTC, reel = video, geo dari lat/lng, filter tanggal", async () => {
    const [p] = await fetchOf(INSTAGRAM_BOOLEAN);
    expect(p).toMatchObject({
      platform_post_id: "Cabc123",
      published_at: "2026-09-29T01:00:00.000Z",
      hashtags: ["kdmp"],
      media: [{ type: "video", url: "https://m.example.invalid/r.mp4" }],
      geo: { lat: -6.9, lng: 107.6, place_name: "Bandung" },
      author: { followers: null },
    });
    expect(bodies["scraping_solutions~instagram-boolean-search-scraper-posts-reels"]).toMatchObject({
      oldestPostDate: "2026-09-28",
      newestPostDate: "2026-09-29",
    });
    const tooMany = Array.from({ length: 33 }, (_, i) => `t${i}`).join(" OR ");
    await expect(
      new ApifyActorConnector(INSTAGRAM_BOOLEAN).fetch(req(INSTAGRAM_BOOLEAN, { query: { native: tooMany, sourceNodeIds: [] } }), ctx()),
    ).rejects.toMatchObject({
      code: "INVALID_QUERY",
    });
  });

  test("Facebook: handle dari profileUrl (username / profile.php?id), reaksi = likes, hashtag dari teks", async () => {
    const [a, b] = await fetchOf(FACEBOOK_SCRAPERONE);
    expect(a).toMatchObject({
      author: { handle: "warga.satu" },
      metrics: { likes: 15, views: null },
      hashtags: ["kdmp"],
      media: [{ type: "image" }],
    });
    expect(b!.author.handle).toBe("42");
    expect(fbHandle(null, "7")).toBe("7");
    expect(bodies["scraper_one~facebook-posts-search"]).toMatchObject({
      query: "koperasi merah putih",
      startDate: "2026-09-28",
      endDate: "2026-09-29",
    });
  });

  test("YouTube: teks = judul + deskripsi, handle tanpa @, subscriber = followers", async () => {
    const [v] = await fetchOf(YOUTUBE_STREAMERS);
    expect(v).toMatchObject({
      text: "Koperasi Merah Putih\n\ndeskripsi video",
      author: { handle: "kanal51", followers: 5000 },
      hashtags: ["kdmp"],
    });
    expect([0.02, 0.5, 3, 20, 200, 500, null].map(youtubeDateFilter)).toEqual([
      "hour",
      "today",
      "week",
      "month",
      "year",
      undefined,
      undefined,
    ]);
    // umur window relatif terhadap jam sekarang → hitung dari fungsi yang sama (tidak bergantung waktu tes)
    const expected = youtubeDateFilter(windowAgeDays(req(YOUTUBE_STREAMERS).window));
    expect(bodies["streamers~youtube-scraper"]).toMatchObject({ dateFilter: expected, sortingOrder: "date" });
    expect(bodies["streamers~youtube-scraper"]).not.toHaveProperty("oldestPostDate"); // tidak dihormati mode search
  });

  test("placeholder noResults tanpa tanda limit → 0 item, 0 hasil (tidak ditagih), bukan error", async () => {
    mode = "empty";
    const r = await new ApifyActorConnector(X_APIDOJO).fetch(req(X_APIDOJO), ctx());
    expect([r.items.length, r.usage.results]).toEqual([0, 0]);
    mode = "ok";
  });

  test("Threads: isPaidPartnership → is_ad, countsHidden → metrik null (bukan 0), balasan tanpa ID induk → parent null", async () => {
    const [a, b] = await fetchOf(THREADS_SCRAPERSDELIGHT);
    expect(a).toMatchObject({ is_ad: true, metrics: { likes: 9, shares: 2 }, media: [{ type: "image" }], hashtags: ["kdmp"] });
    expect(b).toMatchObject({ content_type: "reply", parent: null, is_ad: false, metrics: { likes: null, comments: null } });
    expect(bodies["scrapersdelight~threads-keyword-search-scraper"]).toMatchObject({
      keywords: ["koperasi merah putih"],
      searchType: "top",
      passesPerSurface: 1,
    });
  });
});
