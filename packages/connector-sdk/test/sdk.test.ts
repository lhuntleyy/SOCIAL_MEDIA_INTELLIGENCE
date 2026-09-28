import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ConnectorError,
  codeForStatus,
  toConnectorError,
  compareIds,
  count,
  HttpClient,
  isNonPublicIp,
  maxId,
  parseRetryAfter,
  stripPii,
  toUtcIso,
} from "../src";

describe("SEC-07 SSRF guard", () => {
  const pub = async () => ["93.184.216.34"];
  test("IP non-publik ditolak (literal)", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.5",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "224.0.0.1",
    ]) {
      expect({ ip, blocked: isNonPublicIp(ip) }).toEqual({ ip, blocked: true });
    }
    for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700::1111", "172.32.0.1", "11.0.0.1"])
      expect({ ip, blocked: isNonPublicIp(ip) }).toEqual({ ip, blocked: false });
  });

  test("base URL connector ke IP privat / host yang resolve ke privat / http / di luar allowlist → FORBIDDEN", async () => {
    const reject = async (h: HttpClient, url: string) => {
      const e = await h.assertSafeUrl(url).then(
        () => null,
        (x) => x,
      );
      expect(e).toBeInstanceOf(ConnectorError);
      expect((e as ConnectorError).code).toBe("FORBIDDEN");
    };
    await reject(new HttpClient({ resolver: pub }), "https://127.0.0.1/admin");
    await reject(new HttpClient({ resolver: pub }), "https://[::1]/");
    await reject(new HttpClient({ resolver: async () => ["10.0.0.5"] }), "https://internal.evil.example/");
    await reject(new HttpClient({ resolver: async () => ["93.184.216.34", "127.0.0.1"] }), "https://mixed.example/"); // satu alamat privat pun ditolak
    await reject(new HttpClient({ resolver: pub }), "http://api.apify.com/");
    await reject(new HttpClient({ resolver: pub, allowedHosts: ["apify.com"] }), "https://api.evil.com/");
    await reject(new HttpClient({ resolver: pub }), "https://user:pass@api.apify.com/");
    expect((await new HttpClient({ resolver: pub, allowedHosts: ["apify.com"] }).assertSafeUrl("https://api.apify.com/v2")).hostname).toBe(
      "api.apify.com",
    );
  });
});

describe("HttpClient ke server lokal", () => {
  let srv: ReturnType<typeof Bun.serve>;
  let base: string;
  beforeAll(() => {
    srv = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const p = new URL(req.url).pathname;
        if (p === "/ok") return Response.json({ ok: true });
        if (p === "/429") return new Response("slow down token=Rahasia123", { status: 429, headers: { "retry-after": "30" } });
        if (p === "/401") return new Response("no", { status: 401 });
        if (p === "/500") return new Response("boom", { status: 503 });
        if (p === "/notjson") return new Response("<html>", { status: 200 });
        if (p === "/slow") {
          await Bun.sleep(2000);
          return new Response("late");
        }
        if (p === "/redirect-private")
          return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data" } });
        return new Response("?", { status: 404 });
      },
    });
    base = `http://127.0.0.1:${srv.port}`;
  });
  afterAll(() => srv.stop(true));
  const h = () => new HttpClient({ allowPrivateNetwork: true, timeoutMs: 300 }); // lokal: izinkan http/127.0.0.1 (hanya test)
  const err = async (p: Promise<unknown>) =>
    (await p.then(
      () => null,
      (e) => e,
    )) as ConnectorError;

  test("pemetaan status → ConnectorError; Retry-After; body di-redact", async () => {
    expect((await h().json<{ ok: boolean }>(`${base}/ok`)).data.ok).toBe(true);
    const rl = await err(h().request(`${base}/429`));
    expect([rl.code, rl.retryAfterMs, rl.httpStatus]).toEqual(["RATE_LIMITED", 30_000, 429]);
    expect(rl.message).not.toContain("Rahasia123");
    expect((await err(h().request(`${base}/401`))).code).toBe("AUTH_INVALID");
    expect((await err(h().request(`${base}/500`))).code).toBe("UPSTREAM_5XX");
    expect((await err(h().json(`${base}/notjson`))).code).toBe("PARSE_ERROR");
  });

  test("timeout & abort eksternal → TIMEOUT", async () => {
    expect((await err(h().request(`${base}/slow`))).code).toBe("TIMEOUT");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    expect(
      (await err(new HttpClient({ allowPrivateNetwork: true, timeoutMs: 5000 }).request(`${base}/slow`, { signal: ac.signal }))).code,
    ).toBe("TIMEOUT");
  });

  test("redirect ke alamat privat diblok (guard dicek ulang di setiap hop)", async () => {
    const guarded = new HttpClient({
      timeoutMs: 1000,
      fetchImpl: (u, i) => fetch(String(u).replace("https://api.example.test", base), i),
      resolver: async () => ["93.184.216.34"],
    });
    expect((await err(guarded.request("https://api.example.test/redirect-private"))).code).toBe("FORBIDDEN");
  });
});

describe("normalisasi", () => {
  test("waktu: semua format dari uji kontrak 2026-09-28; ISO tanpa zona & relatif → null", () => {
    expect(toUtcIso("Mon Sep 28 01:22:46 +0000 2026")).toBe("2026-09-28T01:22:46.000Z"); // twitterapi.io / xquik
    expect(toUtcIso("Mon Sep 28 08:22:46 +0700 2026")).toBe("2026-09-28T01:22:46.000Z");
    expect(toUtcIso("2026-06-21T01:07:45+00:00")).toBe("2026-06-21T01:07:45.000Z"); // scraping_solutions
    expect(toUtcIso("2026-09-27T15:54:58+0700")).toBe("2026-09-27T08:54:58.000Z");
    expect(toUtcIso(1790558371000)).toBe("2026-09-28T01:19:31.000Z"); // FB scraper_one (ms)
    expect(toUtcIso("1790558371")).toBe("2026-09-28T01:19:31.000Z"); // TikTok / scrapeforge (detik)
    expect(toUtcIso("2026-09-27T03:27:01")).toBeNull(); // crawlerbros: tanpa zona → JANGAN menebak
    expect(toUtcIso("2 jam lalu")).toBeNull();
    expect(toUtcIso(null)).toBeNull();
  });

  test("metrik: tak diketahui = null (bukan 0); ID snowflake dibanding numerik", () => {
    expect([count(12), count("7"), count(null), count(""), count(-1), count("abc"), count(0)]).toEqual([12, 7, null, null, null, null, 0]);
    expect(compareIds("9", "10")).toBe(-1); // leksikal akan salah
    expect(maxId(["1830000000000000009", "1830000000000000010", "999"])).toBe("1830000000000000010");
  });

  test("toConnectorError: error mentah → terklasifikasi (connector tidak boleh melempar error mentah)", () => {
    const abort = new Error("x");
    abort.name = "AbortError";
    expect(toConnectorError(abort).code).toBe("TIMEOUT");
    expect(toConnectorError(new Error("aneh")).code).toBe("UNKNOWN");
    expect(toConnectorError("string").message).toBe("string");
    const ce = new ConnectorError("PARSE_ERROR", "x");
    expect(toConnectorError(ce)).toBe(ce);
    expect([ce.scope, new ConnectorError("RATE_LIMITED", "y").scope]).toEqual(["connector", "account"]);
  });

  test("PII tambahan dari provider dibuang; kode status → error", () => {
    expect(Object.keys(stripPii({ text: "x", emails: ["a@b.id"], phone_numbers: ["08"], bio_links: [], username: "u" }))).toEqual([
      "text",
      "username",
    ]);
    expect([429, 401, 402, 403, 400, 404, 503, 418].map(codeForStatus)).toEqual([
      "RATE_LIMITED",
      "AUTH_INVALID",
      "QUOTA_EXHAUSTED",
      "FORBIDDEN",
      "INVALID_QUERY",
      "NOT_SUPPORTED",
      "UPSTREAM_5XX",
      "UNKNOWN",
    ]);
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT", Date.parse("Wed, 21 Oct 2026 07:27:00 GMT"))).toBe(60_000);
  });
});
