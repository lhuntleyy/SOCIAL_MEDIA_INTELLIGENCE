// Contract suite + normalizer + paginasi berhenti di window — HTTP di-mock (CI tidak memanggil HikerAPI). Fixture sintetis
// mengikuti bentuk respons nyata (probe 2026-10-01: /v2/hashtag/medias/recent `response.sections[].layout_content.medias[].media`,
// /gql/topsearch `items[]` XDTMediaDict dengan key ber-awalan `1l`).
import { describe, expect, test } from "bun:test";
import { HttpClient } from "@smip/connector-sdk";
import { contractContext, runContractSuite } from "@smip/connector-sdk/contract";
import { CanonicalItem } from "@smip/contracts";
import { HikerApiConnector, normalizeHikerMedia, queryParts } from "../src";

const KEY = "hiker_TEST_rahasia_0123456789abcdef";
const NOW = Math.floor(Date.now() / 1000);
type Mode = "ok" | "401" | "402" | "429" | "500";
let mode: Mode = "ok";
const setMode = (m: Mode) => () => {
  mode = m;
};
const calls: string[] = [];

const media = (code: string, ageMin: number, extra: Record<string, unknown> = {}) => ({
  code,
  taken_at: NOW - ageMin * 60,
  media_type: 1,
  like_count: 5,
  comment_count: 1,
  is_paid_partnership: false,
  caption: { text: `contoh #KopDes ${code} @akun_lain` },
  user: { pk: 111, id: "111", username: "akun_uji", full_name: "Akun Uji", is_verified: false },
  image_versions2: { candidates: [{ url: `https://cdn.example.invalid/${code}.jpg` }] },
  ...extra,
});
const page = (medias: unknown[], next: string | null) => ({
  response: { sections: [{ layout_content: { medias: medias.map((m) => ({ media: m })) } }] },
  next_page_id: next,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
async function mockFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const u = new URL(String(input));
  calls.push(u.pathname + u.search);
  if ((init?.headers as Record<string, string>)?.["x-access-key"] !== KEY || mode === "401") return json(403, { detail: "Invalid key" });
  if (mode === "402") return json(402, { detail: "Not enough balance" });
  if (mode === "429") return json(429, { detail: "Too many requests" });
  if (mode === "500") return json(503, { detail: "upstream" });
  if (u.pathname === "/sys/balance") return json(200, { requests: 95 });
  if (u.pathname === "/v2/hashtag/medias/recent") {
    const tag = u.searchParams.get("name");
    if (tag === "tidakada") return json(404, { detail: "Hashtag not found" });
    // hal.1: 2 post baru; hal.2: 1 baru + 1 lebih lama dari window (→ berhenti); hal.3 tidak boleh diminta
    if (!u.searchParams.get("page_id")) return json(200, page([media(`${tag}1`, 5), media(`${tag}2`, 20)], "p2"));
    if (u.searchParams.get("page_id") === "p2") return json(200, page([media(`${tag}3`, 40), media(`${tag}old`, 600)], "p3"));
    return json(200, page([media(`${tag}never`, 900)], null));
  }
  if (u.pathname === "/gql/topsearch")
    return json(200, {
      items: [
        { __typename: "XDTUserDict", username: "x" },
        {
          __typename: "XDTMediaDict",
          code: "TOP1",
          "1ltaken_at": NOW - 3 * 86400, // keyword: relevansi, post lama tetap diteruskan (≤ 30 hari)
          media_type: 2,
          play_count: 1000,
          like_count: 50,
          comment_count: 3,
          caption: { text: "kopdes di caption saja" },
          user: { pk: null, id: "222", username: "akun_dua", full_name: null, is_verified: true },
          video_versions: [{ url: "https://cdn.example.invalid/v.mp4" }],
          image_versions2: { candidates: [{ url: "https://cdn.example.invalid/t.jpg" }] },
          location: { name: "Bandung", "1flat": -6.9, "1flng": 107.6 },
        },
        { __typename: "XDTMediaDict", code: "TOOOLD", "1ltaken_at": NOW - 90 * 86400, user: { id: "3", username: "lama" } },
      ],
    });
  return json(404, { detail: "not found" });
}

const http = new HttpClient({
  allowedHosts: ["api.instagrapi.com"],
  resolver: async () => ["93.184.216.34"],
  fetchImpl: mockFetch,
  timeoutMs: 2000,
});
const connector = new HikerApiConnector();
const credential = { kind: "api_key" as const, secret: { api_key: KEY } };
const iso = (s: number) => new Date(s * 1000).toISOString();
const req = (o: Partial<Parameters<typeof connector.fetch>[0]> = {}) => ({
  requestId: "0192f000-0000-7000-8000-000000000001",
  idempotencyKey: "run.x.attempt.1",
  platform: "instagram",
  operation: "search_keyword" as const,
  query: { native: '"koperasi merah putih" OR kopdes', sourceNodeIds: [] },
  window: { since: iso(NOW - 60 * 60), until: iso(NOW) }, // 1 jam terakhir
  cursor: null,
  pageLimit: 3,
  maxItems: 300,
  ...o,
});
const config = { usdPerRequest: 0.001 };

runContractSuite("hikerapi.instagram", () => ({
  connector,
  credential,
  config,
  http,
  secretValues: [KEY],
  scenarios: [
    { name: "sukses", setup: setMode("ok"), request: req(), expect: "ok" },
    { name: "key ditolak", setup: setMode("401"), request: req(), expect: "AUTH_INVALID" },
    { name: "saldo habis", setup: setMode("402"), request: req(), expect: "QUOTA_EXHAUSTED" },
    { name: "rate limit", setup: setMode("429"), request: req(), expect: "RATE_LIMITED" },
    { name: "5xx", setup: setMode("500"), request: req(), expect: "UPSTREAM_5XX" },
    {
      name: "operation tak didukung",
      setup: setMode("ok"),
      request: req({ operation: "profile" }),
      expect: "NOT_SUPPORTED",
    },
  ],
}));

describe("hikerapi.instagram", () => {
  const ctx = () => contractContext({ credential, config, http });

  test("query → keyword polos + hashtag gabungan (frasa digabung, unik, ≥ 3 huruf)", () => {
    expect(queryParts('"Koperasi Merah Putih" OR kopdes OR #KDMP OR ab')).toEqual({
      keywords: ["Koperasi Merah Putih", "kopdes", "ab"],
      hashtags: ["koperasimerahputih", "kopdes", "kdmp"],
    });
  });

  test("hashtag terbaru: halaman berhenti begitu melewati window (tanpa tagihan berulang); topsearch 1 req/keyword; biaya = request × tarif", async () => {
    mode = "ok";
    calls.length = 0;
    const r = await connector.fetch(req(), ctx());
    const tagCalls = calls.filter((c) => c.startsWith("/v2/hashtag"));
    // 2 hashtag × 2 halaman (hal.2 memuat post > 1 jam → berhenti; hal.3 tidak diminta)
    expect(tagCalls).toHaveLength(4);
    expect(calls.some((c) => c.includes("never"))).toBe(false);
    expect(calls.filter((c) => c.startsWith("/gql/topsearch"))).toHaveLength(2);
    expect(r.usage).toEqual({ requests: 6, results: 12, costUnits: 0.006, costUnitLabel: "usd" });
    const codes = r.items.map((i) => i.platform_post_id);
    expect(codes).toContain("TOP1"); // keyword lama ≤ 30 hari tetap diteruskan
    expect(codes).not.toContain("TOOOLD"); // > 30 hari dibuang
    expect(new Set(codes).size).toBe(codes.length);
    for (const it of r.items) expect(CanonicalItem.safeParse(it).success).toBe(true);
    expect(calls.every((c) => !c.includes(KEY))).toBe(true); // key hanya di header
  });

  test("hashtag tak dikenal (404) dilewati, bukan menggagalkan run", async () => {
    mode = "ok";
    const r = await connector.fetch(req({ query: { native: "tidakada", sourceNodeIds: [] } }), ctx());
    expect(r.items.map((i) => i.platform_post_id)).toEqual(["TOP1"]);
  });

  test("normalisasi: shortcode = id (sama dgn Apify), video + views, lokasi dari key GraphQL, followers null (bukan 0)", () => {
    const m = {
      code: "ABC",
      "1ltaken_at": 1790000000,
      media_type: 2,
      play_count: 7,
      like_count: 1,
      comment_count: 0,
      caption: { text: "halo #Demo @Budi" },
      user: { id: "9", username: "u" },
      video_versions: [{ url: "https://cdn.example.invalid/v.mp4" }],
      location: { name: "X", "1flat": 1.5, "1flng": 2.5 },
    };
    const it = normalizeHikerMedia(m, { fetchedAt: "2026-10-01T00:00:00.000Z", rawRef: null })!;
    expect(it).toMatchObject({
      platform_post_id: "ABC",
      url: "https://www.instagram.com/p/ABC/",
      published_at: new Date(1790000000 * 1000).toISOString(),
      hashtags: ["demo"],
      mentions: ["budi"],
      metrics: { views: 7, likes: 1, comments: 0 },
      author: { platform_user_id: "9", handle: "u", followers: null },
      geo: { lat: 1.5, lng: 2.5, place_name: "X" },
      is_ad: null,
    });
    expect(normalizeHikerMedia({ code: "N", taken_at: 1 }, { fetchedAt: "x", rawRef: null })).toBeNull(); // tanpa user
  });

  test("health probe memakai /sys/balance (gratis)", async () => {
    mode = "ok";
    const h = await connector.healthProbe(ctx());
    expect(h).toMatchObject({ ok: true, details: { requests_left: 95 } });
  });
});
