// Contract suite connector (CONNECTOR_SPEC §3.1/§12, TESTING §2). Setiap connector (fake maupun nyata) WAJIB lolos:
//   bun test packages/connectors/<nama>
// Connector nyata memakai fixture rekaman (fetch di-mock) — CI tidak pernah memanggil provider eksternal (TESTING §1).
import { describe, expect, test } from "bun:test";
import { CanonicalItem, type ConnectorErrorCode } from "@smip/contracts";
import { createLogger } from "@smip/observability";
import { ConnectorError } from "./errors";
import { HttpClient } from "./http";
import type { Connector, ConnectorContext, DecryptedCredential, FetchRequest, RateLimitInfo } from "./types";

export interface ContractScenario {
  name: string;
  /** Siapkan provider (script fake / mock fetch) sebelum request. */
  setup?: () => void | Promise<void>;
  request: FetchRequest;
  expect: "ok" | ConnectorErrorCode;
}

export interface ContractHarness {
  connector: Connector;
  credential: DecryptedCredential;
  config?: Record<string, unknown>;
  http?: HttpClient;
  /** Nilai rahasia yang TIDAK boleh muncul di log apa pun (SEC-02). */
  secretValues: string[];
  scenarios: ContractScenario[];
}

export interface CapturedContext extends ConnectorContext {
  logs: string[];
  rateLimits: RateLimitInfo[];
}

export function contractContext(
  h: Pick<ContractHarness, "credential" | "config" | "http">,
  signal = new AbortController().signal,
): CapturedContext {
  const logs: string[] = [];
  const rateLimits: RateLimitInfo[] = [];
  return {
    credential: h.credential,
    config: h.config ?? {},
    http: h.http ?? new HttpClient(),
    logger: createLogger({ service: "contract", level: "debug", sink: (l) => logs.push(l) }),
    signal,
    reportRateLimit: (i) => void rateLimits.push(i),
    archiveRaw: async (_p, m) => `s3://contract/${m.platform}/${m.crawlRunId}/${m.attemptNo}-${m.page}.json.gz`,
    logs,
    rateLimits,
  };
}

/** Angka rate limit/harga DILARANG di manifest (Golden Rule 1) — kecuali batas teknis query/halaman. */
const FORBIDDEN_MANIFEST_KEYS = /(rate|price|pricing|cost_?per|quota|qps|rps|per_?(second|minute|hour|day)|limit)$/i;
const ALLOWED_NUMERIC = new Set(["maxQueryLength", "maxPageSize"]);
function forbiddenNumbers(o: unknown, path = ""): string[] {
  if (!o || typeof o !== "object") return [];
  return Object.entries(o).flatMap(([k, v]) => {
    const p = path ? `${path}.${k}` : k;
    if (typeof v === "number" && FORBIDDEN_MANIFEST_KEYS.test(k) && !ALLOWED_NUMERIC.has(k)) return [p];
    return forbiddenNumbers(v, p);
  });
}

export function runContractSuite(name: string, makeHarness: () => Promise<ContractHarness> | ContractHarness) {
  describe(`contract: ${name}`, async () => {
    const h = await makeHarness();
    const m = h.connector.manifest;
    const allLogs: string[] = [];

    test("manifest valid & bebas angka rate/harga", () => {
      expect(m.key).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*(\.[a-z0-9_]+)?$/);
      expect(m.key.split(".")[0]).toBe(m.providerKey);
      expect(m.key.split(".")[1]).toBe(m.platform);
      expect(m.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(m.docsUrl).toMatch(/^https:\/\//);
      expect(Object.keys(m.operations).length).toBeGreaterThan(0);
      expect(forbiddenNumbers(m)).toEqual([]);
    });

    for (const s of h.scenarios) {
      test(`skenario: ${s.name} → ${s.expect}`, async () => {
        await s.setup?.();
        const ctx = contractContext(h);
        const run = h.connector.fetch(s.request, ctx);
        if (s.expect === "ok") {
          const r = await run;
          allLogs.push(...ctx.logs);
          const op = m.operations[s.request.operation];
          expect(op).toBeDefined();
          for (const it of r.items) {
            const v = CanonicalItem.safeParse(it);
            expect(v.success ? "valid" : JSON.stringify(v.error.issues.slice(0, 3))).toBe("valid");
            expect(it.platform).toBe(m.platform);
            expect(it.provenance.connector_key).toBe(m.key);
            if (op?.supportsSince && s.request.window?.since) expect(it.published_at >= s.request.window.since).toBe(true);
          }
          expect(r.items.length).toBeLessThanOrEqual(s.request.maxItems);
          // biaya dari hasil DIKEMBALIKAN provider (≥ yang lolos normalisasi/disimpan) — CONNECTOR_SPEC §4a, P-15
          expect(r.usage.requests).toBeGreaterThanOrEqual(1);
          expect(r.usage.results).toBeGreaterThanOrEqual(r.items.length);
          if (r.hasMore) expect(r.nextCursor ?? r.asyncHandle).toBeTruthy();
        } else {
          let caught: unknown;
          try {
            await run;
          } catch (e) {
            caught = e;
          }
          allLogs.push(...ctx.logs);
          expect(caught).toBeInstanceOf(ConnectorError); // bukan error mentah
          expect((caught as ConnectorError).code).toBe(s.expect);
          if (s.expect === "RATE_LIMITED")
            expect(ctx.rateLimits.length + ((caught as ConnectorError).retryAfterMs ? 1 : 0)).toBeGreaterThan(0);
        }
      });
    }

    test("menghormati signal: request dengan deadline yang sudah lewat → ConnectorError TIMEOUT < 2 s", async () => {
      const ac = new AbortController();
      ac.abort(new Error("deadline"));
      const ok = h.scenarios.find((s) => s.expect === "ok");
      await ok?.setup?.();
      const t0 = performance.now();
      let caught: unknown;
      try {
        await h.connector.fetch(ok!.request, contractContext(h, ac.signal));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ConnectorError);
      expect((caught as ConnectorError).code).toBe("TIMEOUT");
      expect(performance.now() - t0).toBeLessThan(2000);
    });

    test("healthProbe mengembalikan bentuk kontrak", async () => {
      await h.scenarios.find((s) => s.expect === "ok")?.setup?.();
      const r = await h.connector.healthProbe(contractContext(h));
      expect(typeof r.ok).toBe("boolean");
      expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    });

    test("SEC-02: nilai credential tidak pernah muncul di log connector", () => {
      const joined = allLogs.join("\n");
      for (const v of h.secretValues) expect(joined.includes(v)).toBe(false);
    });
  });
}
