// I-18 contract suite + normalizer connector Apify per platform. Fixture SINTETIS mengikuti bentuk hasil probe
// (docs/evidence/shapes/*.json) — tanpa konten/akun asli; HTTP di-mock (CI tidak memanggil Apify).
import { describe, expect, test } from "bun:test";
import { HttpClient } from "@smip/connector-sdk";
import { contractContext, runContractSuite } from "@smip/connector-sdk/contract";
import { CanonicalItem } from "@smip/contracts";
import {
  type ActorSpec,
  ApifyActorConnector,
  clockworksDateFilter,
  FACEBOOK_SCRAPEFORGE,
  FACEBOOK_SCRAPERONE,
  FACEBOOK_SILENTFLOW,
  fbHandle,
  INSTAGRAM_BOOLEAN,
  INSTAGRAM_HASHTAG,
  KAITO_MIN_ITEMS,
  queryToHashtags,
  THREADS_MINEWORKS,
  THREADS_SCRAPERSDELIGHT,
  TIKTOK_CLOCKWORKS,
  TIKTOK_XMOLODTSOV,
  windowAgeDays,
  withHashtags,
  X_KAITO,
  X_SCRAPERONE,
  YOUTUBE_STREAMERS,
  youtubeDateFilter,
} from "../src";

const TOKEN = "apify_api_TEST_platforms_987654321";
const IN = "2026-09-29T01:00:00.000Z"; // di dalam window
const OUT = "2026-09-20T01:00:00.000Z"; // di luar window (dibuang)
const tw = (iso: string) => new Date(iso).toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT$/, "$1 $3 $2 $5 +0000 $4");

const FIXTURES: Record<string, { spec: ActorSpec; items: unknown[]; expectCount: number }> = {
  x_kaito: {
    spec: X_KAITO,
    expectCount: 3,
    items: [
      {
        id: "1850000000000000001",
        url: "https://x.com/u1/status/1850000000000000001",
        text: "kopdes jalan #kdmp",
        lang: "in",
        createdAt: tw(IN),
        conversationId: "1850000000000000001",
        isReply: false,
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
        entities: { hashtags: [{ text: "kdmp" }], user_mentions: [{ screen_name: "u9" }] },
        extendedEntities: { media: [{ type: "photo", media_url_https: "https://pbs.example.invalid/a.jpg" }] },
      },
      {
        id: "1850000000000000002",
        text: "kutip kopdes",
        createdAt: tw(IN),
        isQuote: true,
        quoted_tweet: { id: "1850000000000000001", author: { id: "11", userName: "u1" } },
        author: { id: "12", userName: "u2" },
        entities: {},
      },
      {
        id: "1850000000000000004",
        text: "RT kopdes",
        createdAt: tw(IN),
        retweeted_tweet: { id: "1850000000000000001", author: { id: "11", userName: "u1" } },
        author: { id: "14", userName: "u4" },
      },
      { id: "1850000000000000003", text: "lama", createdAt: tw(OUT), author: { id: "13", userName: "u3" } },
    ],
  },
  x_scraperone: {
    spec: X_SCRAPERONE,
    expectCount: 1,
    items: [
      {
        postId: "1850000000000000010",
        postUrl: "https://x.com/s1/status/1850000000000000010",
        postText: "kopdes #kdmp desa",
        timestamp: Date.parse(IN),
        conversationId: "1850000000000000009",
        favouriteCount: 3,
        replyCount: 0,
        repostCount: 1,
        quoteCount: 0,
        author: { userId: "71", screenName: "s1", name: "S Satu", profileImageUrl: "https://pbs.example.invalid/s.jpg" },
        media: [{ type: "video", mediaUrlHttps: "https://pbs.example.invalid/v.jpg", id: "5" }],
      },
      { postId: "1850000000000000011", postText: "tanpa author", timestamp: Date.parse(IN) },
    ],
  },
  tiktok_clockworks: {
    spec: TIKTOK_CLOCKWORKS,
    expectCount: 1,
    items: [
      {
        id: "7400000000000000001",
        text: "video kopdes #kdmp",
        textLanguage: "id",
        createTime: Date.parse(IN) / 1000,
        createTimeISO: IN,
        webVideoUrl: "https://www.tiktok.com/@c1/video/7400000000000000001",
        diggCount: 10,
        commentCount: 2,
        shareCount: 1,
        playCount: 300,
        collectCount: 3,
        hashtags: [{ id: "1", name: "kdmp" }],
        mentions: ["@c2"],
        isAd: false,
        isSponsored: true,
        authorMeta: {
          id: "21",
          name: "c1",
          nickName: "C Satu",
          fans: 1000,
          following: 10,
          verified: true,
          avatar: "https://p.example.invalid/c.jpg",
          createTime: null,
        },
        videoMeta: { coverUrl: "https://v.example.invalid/c.jpg" },
        locationCreated: "ID",
      },
      { id: "7400000000000000002", text: "lama", createTimeISO: OUT, authorMeta: { id: "22", name: "c2" } },
    ],
  },
  tiktok_xmolodtsov: {
    spec: TIKTOK_XMOLODTSOV,
    expectCount: 1,
    items: [
      {
        id: "7400000000000000003",
        title: "video kopdes #kdmp",
        uploadedAt: Date.parse(IN) / 1000,
        uploadedAtFormatted: IN,
        postPage: "https://www.tiktok.com/@c3/video/7400000000000000003",
        likes: 10,
        comments: 2,
        shares: 1,
        views: 300,
        bookmarks: 3,
        hashtags: ["kdmp"],
        channel: {
          id: "23",
          username: "c3",
          name: "C Tiga",
          followers: 1000,
          following: 5,
          verified: false,
          avatar: "https://p.example.invalid/c.jpg",
        },
        video: { url: "https://v.example.invalid/v.mp4", cover: "https://v.example.invalid/c.jpg" },
        poi: { poiName: "Alun-alun Bandung" },
      },
      { id: "7400000000000000004", title: "tanpa channel → dibuang", uploadedAt: Date.parse(IN) / 1000 },
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
  instagram_hashtag: {
    spec: INSTAGRAM_HASHTAG,
    expectCount: 1,
    items: [
      {
        shortCode: "Chash1",
        id: "3500000000000000001",
        url: "https://www.instagram.com/p/Chash1/",
        caption: "gerai #kopdes baru",
        timestamp: IN,
        ownerUsername: "koperasi_b",
        ownerId: "41",
        ownerFullName: "Koperasi B",
        type: "Video",
        productType: "clips",
        likesCount: 12,
        commentsCount: 2,
        videoViewCount: 300,
        hashtags: ["kopdes"],
        mentions: ["@desa_b"],
        displayUrl: "https://m.example.invalid/h.jpg",
        locationName: "Garut",
        paidPartnership: true,
      },
      {
        shortCode: "Chold",
        timestamp: "2026-05-01T00:00:00Z",
        ownerUsername: "lama",
        ownerId: "42",
        caption: "> 30 hari sebelum window → dibuang",
      },
    ],
  },
  threads_mineworks: {
    spec: THREADS_MINEWORKS,
    expectCount: 2,
    items: [
      {
        post_id: "3700000000000000001",
        code: "DTm1",
        url: "https://www.threads.com/@tm1/post/DTm1",
        text: "kopdes jalan terus #kdmp",
        posted_at: IN,
        username: "tm1",
        user_full_name: "TM Satu",
        user_verified: true,
        like_count: 4,
        reply_count: 1,
        repost_count: 0,
        quote_count: 0,
        hashtags: ["kdmp"],
        mentions: [],
        media_urls: ["https://m.example.invalid/t.jpg"],
        media_type: "image",
        is_reply: false,
        is_repost: false,
      },
      { post_id: "3700000000000000002", text: "balasan", posted_at: IN, username: "tm2", is_reply: true, like_count: 0 },
      { post_id: "3700000000000000003", text: "terlalu lama", posted_at: "2026-05-01T00:00:00Z", username: "tm3" },
      { _type: "summary", delivered: 3, message: "selesai" },
    ],
  },
  facebook_silentflow: {
    spec: FACEBOOK_SILENTFLOW,
    expectCount: 2,
    items: [
      {
        post_id: "1100000000000000001",
        url: "https://www.facebook.com/desa.a/posts/1100000000000000001",
        message: "rapat koperasi #kopdes di balai desa",
        timestamp: Math.floor(Date.parse(IN) / 1000),
        author: {
          id: "8001",
          name: "Desa A",
          url: "https://www.facebook.com/desa.a",
          profile_picture_url: "https://p.example.invalid/a.jpg",
        },
        reactions_count: 12,
        comments_count: 3,
        reshare_count: 1,
        video: "https://v.example.invalid/f.mp4",
        video_thumbnail: "https://v.example.invalid/f.jpg",
        video_view_count: 90,
      },
      {
        post_id: "1100000000000000002",
        message: "profil tanpa username",
        timestamp: Math.floor(Date.parse(IN) / 1000),
        author: { id: "8002", name: "Budi", url: "https://www.facebook.com/profile.php?id=8002" },
        reactions_count: 0,
      },
      { post_id: "1100000000000000003", message: "lama", timestamp: Math.floor(Date.parse(OUT) / 1000), author: { id: "8003", url: null } },
    ],
  },
  facebook_scrapeforge: {
    spec: FACEBOOK_SCRAPEFORGE,
    expectCount: 2,
    items: [
      {
        post_id: "1100000000000000001",
        url: "https://www.facebook.com/desa.a/posts/1100000000000000001",
        message: "rapat koperasi #kopdes di balai desa",
        timestamp: Math.floor(Date.parse(IN) / 1000),
        author: {
          id: "8001",
          name: "Desa A",
          url: "https://www.facebook.com/desa.a",
          profile_picture_url: "https://p.example.invalid/a.jpg",
        },
        reactions_count: 12,
        comments_count: 3,
        reshare_count: 1,
        video: "https://v.example.invalid/f.mp4",
        video_thumbnail: "https://v.example.invalid/f.jpg",
        video_view_count: 90,
      },
      {
        post_id: "1100000000000000002",
        message: "profil tanpa username",
        timestamp: Math.floor(Date.parse(IN) / 1000),
        author: { id: "8002", name: "Budi", url: "https://www.facebook.com/profile.php?id=8002" },
        reactions_count: 0,
      },
      { post_id: "1100000000000000003", message: "lama", timestamp: Math.floor(Date.parse(OUT) / 1000), author: { id: "8003", url: null } },
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

  test("X kaito: operator waktu di field terpisah, maxItems ≥ 20, media dari extendedEntities, quote & repost → parent", async () => {
    const [a, b, c] = await fetchOf(X_KAITO);
    expect(a).toMatchObject({
      text: "kopdes jalan #kdmp",
      hashtags: ["kdmp"],
      mentions: ["u9"],
      media: [{ type: "image" }],
      author: { handle: "u1", location_raw: "Surabaya" },
    });
    expect(b).toMatchObject({ content_type: "quote", parent: { platform_post_id: "1850000000000000001", author: { handle: "u1" } } });
    expect(c).toMatchObject({
      content_type: "repost",
      parent: { platform_post_id: "1850000000000000001", author: { platform_user_id: "11" } },
    });
    expect(bodies["kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest"]).toEqual({
      twitterContent: '"koperasi merah putih"',
      maxItems: KAITO_MIN_ITEMS,
      queryType: "Latest",
      since_time: "1790553600",
      until_time: "1790647200",
    });
  });

  test("X scraper_one: timestamp ms, handle screenName, tipe konten tak ditebak, resultsCount ≤ 100 (plan FREE)", async () => {
    const [p] = await fetchOf(X_SCRAPERONE);
    expect(p).toMatchObject({
      content_type: "post",
      root_post_id: "1850000000000000009",
      author: { handle: "s1", followers: null },
      media: [{ type: "video" }],
      hashtags: ["kdmp"],
    });
    expect(bodies["scraper_one~x-posts-search"]).toMatchObject({ query: '"koperasi merah putih"', searchType: "latest", resultsCount: 20 });
    const hours = Math.max(1, Math.ceil(windowAgeDays(req(X_SCRAPERONE).window)! * 24)); // relatif jam sekarang
    expect((bodies["scraper_one~x-posts-search"] as { timeWindowHours: number }).timeWindowHours).toBe(hours);
  });

  test("TikTok clockworks: bahasa dari textLanguage, isSponsored → is_ad, followers = fans; filter tanggal dari umur window", async () => {
    const [v] = await fetchOf(TIKTOK_CLOCKWORKS);
    expect(v).toMatchObject({
      lang_hint: "id",
      is_ad: true,
      hashtags: ["kdmp"],
      mentions: ["c2"],
      author: { handle: "c1", followers: 1000 },
      metrics: { views: 300, saves: 3 },
      geo: { place_name: null },
    });
    expect([0.5, 3, 20, 60, 120, 400, null].map(clockworksDateFilter)).toEqual([
      "PAST_24_HOURS",
      "PAST_WEEK",
      "PAST_MONTH",
      "LAST_3_MONTHS",
      "LAST_6_MONTHS",
      "ALL_TIME",
      "ALL_TIME",
    ]);
    expect(bodies["clockworks~free-tiktok-scraper"]).toMatchObject({
      searchQueries: ["koperasi merah putih"],
      searchSection: "/video",
      videoSearchSorting: "LATEST",
    });
  });

  test("TikTok xmolodtsov: tanpa filter tanggal di input (saring lokal), POI → place_name, bahasa null", async () => {
    const [v] = await fetchOf(TIKTOK_XMOLODTSOV);
    expect(v).toMatchObject({ lang_hint: null, geo: { place_name: "Alun-alun Bandung" }, media: [{ type: "video" }] });
    expect(bodies["xmolodtsov~tiktok-search-scraper"]).toEqual({
      keywords: ["koperasi merah putih"],
      maxItems: 20,
      sortType: "DATE_POSTED",
    });
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
      hashtagFeedType: "recent",
    });
    // keyword IG diurutkan relevansi (post lama) → cabang #hashtag (feed recent) ikut dalam run yang sama
    expect(withHashtags('"koperasi merah putih" OR kopdes OR #KDMP')).toBe(
      '"koperasi merah putih" OR kopdes OR #KDMP OR #koperasimerahputih OR #kopdes',
    );
    const thirty = Array.from({ length: 30 }, (_, i) => `term${i}`).join(" OR ");
    expect(withHashtags(thirty).split(" OR ")).toHaveLength(32); // tidak melewati batas cabang actor
    const tooMany = Array.from({ length: 33 }, (_, i) => `t${i}`).join(" OR ");
    await expect(
      new ApifyActorConnector(INSTAGRAM_BOOLEAN).fetch(req(INSTAGRAM_BOOLEAN, { query: { native: tooMany, sourceNodeIds: [] } }), ctx()),
    ).rejects.toMatchObject({
      code: "INVALID_QUERY",
    });
  });

  test("Instagram hashtag: query → hashtag (frasa digabung, unik, ≥ 3 huruf), paidPartnership → iklan, window lokal", async () => {
    expect(queryToHashtags('"koperasi merah putih" OR kopdes OR #KDMP OR ab OR Kopdes')).toEqual(["koperasimerahputih", "kopdes", "kdmp"]);
    const [p] = await fetchOf(INSTAGRAM_HASHTAG);
    expect(p).toMatchObject({
      platform_post_id: "Chash1",
      is_ad: true,
      mentions: ["desa_b"],
      media: [{ type: "video" }],
      geo: { place_name: "Garut" },
      author: { handle: "koperasi_b", display_name: "Koperasi B" },
      metrics: { likes: 12, views: 300 },
    });
    expect(bodies["apify~instagram-hashtag-scraper"]).toEqual({ hashtags: ["koperasimerahputih"], resultsType: "posts", resultsLimit: 20 });
    // actor tanpa filter tanggal: post di luar potongan window (tapi ≤ LOOKBACK_DAYS) TIDAK dibuang — sudah dibayar & sah
    const narrow = { since: "2026-09-29T00:30:00.000Z", until: "2026-09-29T00:40:00.000Z" };
    const kept = await new ApifyActorConnector(INSTAGRAM_HASHTAG).fetch(req(INSTAGRAM_HASHTAG, { window: narrow }), ctx());
    expect(kept.items.map((i) => i.platform_post_id)).toEqual(["Chash1"]);
    await expect(
      new ApifyActorConnector(INSTAGRAM_HASHTAG).fetch(req(INSTAGRAM_HASHTAG, { query: { native: '"!!"', sourceNodeIds: [] } }), ctx()),
    ).rejects.toMatchObject({ code: "INVALID_QUERY" });
  });

  test("Threads themineworks: terbaru (resultType recent), username = id penulis, baris ringkasan dibuang, reply terdeteksi", async () => {
    const r = await fetchOf(THREADS_MINEWORKS);
    expect(r.map((i) => [i.platform_post_id, i.content_type])).toEqual([
      ["3700000000000000001", "post"],
      ["3700000000000000002", "reply"],
    ]);
    expect(r[0]).toMatchObject({
      author: { platform_user_id: "tm1", handle: "tm1", verified: true },
      metrics: { likes: 4 },
      hashtags: ["kdmp"],
    });
    expect(bodies["themineworks~threads-search-scraper"]).toEqual({
      searchQuery: "koperasi merah putih",
      resultType: "recent",
      maxPosts: 20,
    });
    expect(THREADS_MINEWORKS.operations.search_keyword?.resultOrder).toBe("desc"); // → maxItems adaptif berlaku
  });

  test("Facebook silentflow/scrapeforge: terbaru (recent_posts), epoch detik, handle dari author.url, reaksi = likes, video", async () => {
    const [a, b] = await fetchOf(FACEBOOK_SILENTFLOW);
    expect(a).toMatchObject({
      platform_post_id: "1100000000000000001",
      published_at: IN,
      author: { platform_user_id: "8001", handle: "desa.a", display_name: "Desa A" },
      metrics: { likes: 12, comments: 3, shares: 1, views: 90 },
      media: [{ type: "video" }],
      hashtags: ["kopdes"],
    });
    expect(b!.author.handle).toBe("8002");
    expect(bodies["silentflow~facebook-search-scraper"]).toMatchObject({
      query: "koperasi merah putih",
      search_type: "posts",
      recent_posts: true,
      max_posts: 20,
    });
    await fetchOf(FACEBOOK_SCRAPEFORGE);
    expect(bodies["scrapeforge~facebook-search-posts"]).toMatchObject({
      recent_posts: true,
      max_results: 20,
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
    const r = await new ApifyActorConnector(X_KAITO).fetch(req(X_KAITO), ctx());
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
