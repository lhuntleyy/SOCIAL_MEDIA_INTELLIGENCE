// Contract suite + normalizer + paginasi — HTTP di-mock (CI tidak memanggil LamaTok). Fixture sintetis mengikuti bentuk respons nyata
// (probe 2026-10-01: /v2/search `aweme_list[]` + `next_page_id`; /v2/media/comments/by/id `comments[]` + `cursor`/`has_more`).
import { describe, expect, test } from "bun:test";
import { HttpClient } from "@smip/connector-sdk";
import { contractContext, runContractSuite } from "@smip/connector-sdk/contract";
import { CanonicalItem } from "@smip/contracts";
import { keywordsOf, LamatokConnector, normalizeVideo } from "../src";

const KEY = "lama_TEST_rahasia_0123456789abcdef";
const NOW = Math.floor(Date.now() / 1000);
type Mode = "ok" | "401" | "402" | "429" | "500";
let mode: Mode = "ok";
const setMode = (m: Mode) => () => {
  mode = m;
};
const calls: string[] = [];

const video = (id: string, ageMin: number, extra: Record<string, unknown> = {}) => ({
  aweme_id: id,
  desc: `video ${id} #Kopdes`,
  create_time: NOW - ageMin * 60,
  desc_language: "id",
  is_ads: false,
  author: { uid: "70001", unique_id: "akun.uji", nickname: "Akun Uji", follower_count: 1200, verification_type: 0 },
  statistics: { digg_count: 10, comment_count: 2, share_count: 1, play_count: 500, collect_count: 3 },
  text_extra: [{ hashtag_name: "Kopdes", type: 1 }],
  video: { cover: { url_list: ["https://cdn.example.invalid/c.jpg"] } },
  ...extra,
});
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
async function mockFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const u = new URL(String(input));
  calls.push(u.pathname + u.search);
  if ((init?.headers as Record<string, string>)?.["x-access-key"] !== KEY || mode === "401") return json(403, { detail: "Invalid key" });
  if (mode === "402") return json(402, { detail: "balance" });
  if (mode === "429") return json(429, { detail: "slow down" });
  if (mode === "500") return json(503, { detail: "upstream" });
  if (u.pathname === "/sys/balance") return json(200, { requests: 94 });
  if (u.pathname === "/v2/search") {
    const p = u.searchParams.get("page_id");
    const kw = u.searchParams.get("keyword")!.replace(/\s/g, "");
    // hal.1 berisi video baru; hal.2 hanya video lama (> window) → berhenti; hal.3 tak boleh diminta
    if (!p)
      return json(200, {
        aweme_list: [video(`1${kw.length}1`, 10), video(`1${kw.length}2`, 50 * 24 * 60)],
        next_page_id: "p2",
        has_more: 1,
      });
    if (p === "p2") return json(200, { aweme_list: [video(`1${kw.length}3`, 300)], next_page_id: "p3", has_more: 1 });
    return json(200, { aweme_list: [video("999", 1)], next_page_id: null });
  }
  if (u.pathname === "/v1/user/by/username")
    return u.searchParams.get("username") === "tidakada"
      ? json(200, { userInfo: {} })
      : json(200, { userInfo: { user: { secUid: "SEC1" } } });
  if (u.pathname === "/v2/user/medias/by/secUid")
    return json(200, { aweme_list: [video("201", 5), video("202", 30)], max_cursor: "0", has_more: false });
  if (u.pathname === "/v2/media/comments/by/id")
    return json(200, {
      comments: [
        {
          cid: "c1",
          text: "setuju #kopdes",
          create_time: NOW - 60,
          digg_count: 4,
          comment_language: "id",
          user: { uid: "8", unique_id: "warga1", nickname: "W" },
        },
        { cid: "c2", text: "tanpa user", create_time: NOW - 60 },
      ],
      cursor: 50,
      has_more: false,
    });
  return json(404, { detail: "not found" });
}

const http = new HttpClient({
  allowedHosts: ["api.lamatok.com"],
  resolver: async () => ["93.184.216.34"],
  fetchImpl: mockFetch,
  timeoutMs: 2000,
});
const connector = new LamatokConnector();
const credential = { kind: "api_key" as const, secret: { api_key: KEY } };
const iso = (s: number) => new Date(s * 1000).toISOString();
const config = { usdPerRequest: 0.001 };
const req = (o: Partial<Parameters<typeof connector.fetch>[0]> = {}) => ({
  requestId: "0192f000-0000-7000-8000-000000000001",
  idempotencyKey: "run.x.attempt.1",
  platform: "tiktok",
  operation: "search_keyword" as const,
  query: { native: '"koperasi merah putih" OR kopdes', sourceNodeIds: [] },
  window: { since: iso(NOW - 60 * 60), until: iso(NOW) },
  cursor: null,
  pageLimit: 3,
  maxItems: 300,
  ...o,
});

runContractSuite("lamatok.tiktok", () => ({
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
    { name: "operation tak didukung", setup: setMode("ok"), request: req({ operation: "profile" }), expect: "NOT_SUPPORTED" },
  ],
}));

describe("lamatok.tiktok", () => {
  const ctx = () => contractContext({ credential, config, http });

  test("keyword dari query: kutip & NOT dibuang, unik", () => {
    expect(keywordsOf('"Koperasi Merah Putih" OR kopdes OR #KDMP OR kopdes NOT hoaks')).toEqual(["Koperasi Merah Putih", "kopdes", "KDMP"]);
  });

  test("search: halaman berhenti saat tak ada video dalam window; post > 30 hari dibuang; biaya = request × tarif", async () => {
    mode = "ok";
    calls.length = 0;
    const r = await connector.fetch(req(), ctx());
    // 2 keyword × 2 halaman (hal.2 hanya video lama → berhenti), hal.3 tidak diminta
    expect(calls.filter((c) => c.startsWith("/v2/search"))).toHaveLength(4);
    expect(calls.some((c) => c.includes("page_id=p3"))).toBe(false);
    expect(r.usage).toEqual({ requests: 4, results: 6, costUnits: 0.004, costUnitLabel: "usd" });
    const ids = r.items.map((i) => i.platform_post_id);
    expect(ids).not.toContain("1202"); // 50 hari
    for (const it of r.items) expect(CanonicalItem.safeParse(it).success).toBe(true);
    expect(calls.every((c) => !c.includes(KEY))).toBe(true);
  });

  test("user_timeline (menu Akun): username → secUid → video terbaru; akun tak ditemukan dilewati", async () => {
    mode = "ok";
    calls.length = 0;
    const r = await connector.fetch(req({ operation: "user_timeline", query: undefined, targetIds: ["@akun.uji", "tidakada"] }), ctx());
    expect(r.items.map((i) => i.platform_post_id)).toEqual(["201", "202"]);
    expect(r.usage.requests).toBe(3); // 2 profil + 1 halaman video
  });

  test("post_comments: komentar = content_type comment dengan parent video; item tanpa user dibuang", async () => {
    mode = "ok";
    const r = await connector.fetch(req({ operation: "post_comments", query: undefined, targetIds: ["7691556213712112903"] }), ctx());
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      content_type: "comment",
      parent: { platform_post_id: "7691556213712112903" },
      author: { handle: "warga1", followers: null },
      hashtags: ["kopdes"],
    });
    expect(CanonicalItem.safeParse(r.items[0]).success).toBe(true);
  });

  test("normalisasi video: metrik lengkap, iklan, bahasa, hashtag huruf kecil", () => {
    const it = normalizeVideo(video("7", 1, { is_ads: true }), { fetchedAt: "2026-10-01T00:00:00.000Z", rawRef: null })!;
    expect(it).toMatchObject({
      platform_post_id: "7",
      url: "https://www.tiktok.com/@akun.uji/video/7",
      is_ad: true,
      lang_hint: "id",
      hashtags: ["kopdes"],
      metrics: { likes: 10, comments: 2, shares: 1, views: 500, saves: 3 },
      author: { followers: 1200, handle: "akun.uji" },
    });
  });

  test("health probe memakai /sys/balance (gratis)", async () => {
    mode = "ok";
    expect(await connector.healthProbe(ctx())).toMatchObject({ ok: true, details: { requests_left: 94 } });
  });
});
