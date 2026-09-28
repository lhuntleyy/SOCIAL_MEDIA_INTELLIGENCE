import { describe, expect, test } from "bun:test";
import type { ConnectorError } from "@smip/connector-sdk";
import { contractContext, runContractSuite } from "@smip/connector-sdk/contract";
import { FakeConnector, fakeItem } from "../src";

const fake = new FakeConnector({ platform: "x" });
const req = (over: Record<string, unknown> = {}) => ({
  requestId: "0192f0c4-8a4e-7c3b-9d2e-5b1a2f3c4d5e",
  idempotencyKey: "run.0192.attempt.1.page.1",
  platform: "x",
  operation: "search_keyword" as const,
  query: { native: "kopdes", sourceNodeIds: [] },
  pageLimit: 1,
  maxItems: 50,
  ...over,
});
const CRED = { kind: "api_key" as const, secret: { token: "fake_secret_ABC123XYZ" } };

runContractSuite("fake.x", () => ({
  connector: fake,
  credential: CRED,
  secretValues: ["fake_secret_ABC123XYZ"],
  scenarios: [
    {
      name: "hasil biasa",
      setup: () => void fake.reset().script([{ respond: { items: [1, 2, 3].map((n) => fakeItem("x", n)) } }]),
      request: req(),
      expect: "ok",
    },
    {
      name: "window since dihormati",
      setup: () => void fake.reset().script([{ respond: { items: [1, 30, 60].map((n) => fakeItem("x", n)) } }]),
      request: req({ window: { since: "2026-09-27T10:20:00.000Z" } }),
      expect: "ok",
    },
    {
      name: "halaman berikut via cursor",
      setup: () => void fake.reset().script([{ respond: { items: [fakeItem("x", 1)], nextCursor: "c2" } }]),
      request: req(),
      expect: "ok",
    },
    {
      name: "rate limited",
      setup: () => void fake.reset().script([{ fail: { code: "RATE_LIMITED", retryAfterMs: 30_000 } }]),
      request: req(),
      expect: "RATE_LIMITED",
    },
    {
      name: "auth invalid",
      setup: () => void fake.reset().script([{ fail: { code: "AUTH_INVALID", httpStatus: 401 } }]),
      request: req(),
      expect: "AUTH_INVALID",
    },
    {
      name: "schema drift → PARSE_ERROR",
      setup: () => void fake.reset().script([{ respond: { items: [{ id: 1, text: "bentuk lain" }] } }]),
      request: req(),
      expect: "PARSE_ERROR",
    },
    { name: "operation tak didukung", request: req({ operation: "profile" }), expect: "NOT_SUPPORTED" },
  ],
}));

describe("fake connector — perilaku skenario TESTING §3", () => {
  const ctx = () => contractContext({ credential: CRED });

  test("P-15: provider mengembalikan 25, yang lolos 2 → usage.results = 25 (biaya dari hasil dikembalikan)", async () => {
    fake.reset().script([{ respond: { items: [1, 2].map((n) => fakeItem("x", n)), returned: 25 } }]);
    const r = await fake.fetch(req(), ctx());
    expect([r.items.length, r.usage.results]).toEqual([2, 25]);
  });

  test("delay + deadline → TIMEOUT cepat (tidak menunggu delay penuh)", async () => {
    fake.reset().script([{ delayMs: 5000 }]);
    const t0 = performance.now();
    const e = await fake.fetch(req(), { ...ctx(), signal: AbortSignal.timeout(50) }).then(
      () => null,
      (x) => x,
    );
    expect((e as ConnectorError).code).toBe("TIMEOUT");
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  test("dua instance (fake-a/fake-b) independen untuk skenario failover; langkah per operation; jejak calls", async () => {
    const a = new FakeConnector({ platform: "x", variant: "a" }).script([{ fail: { code: "RATE_LIMITED" } }]);
    const b = new FakeConnector({ platform: "x", variant: "b" }).script([{ respond: { items: [fakeItem("x", 9)] } }]);
    expect([a.manifest.key, b.manifest.key]).toEqual(["fake.x.a", "fake.x.b"]);
    expect(((await a.fetch(req(), ctx()).catch((e) => e)) as ConnectorError).code).toBe("RATE_LIMITED");
    const r = await b.fetch(req(), ctx());
    expect(r.items[0]!.provenance.connector_key).toBe("fake.x.b");
    const c = new FakeConnector({ platform: "x" }).script([
      { op: "user_timeline", respond: { items: [fakeItem("x", 1)] } },
      { op: "search_keyword", respond: { items: [] } },
    ]);
    expect((await c.fetch(req(), ctx())).items.length).toBe(0); // langkah search_keyword diambil walau urutan kedua
    expect(c.calls.length).toBe(1);
  });

  test("health: bisa disetel tidak sehat untuk uji circuit breaker", async () => {
    const f = new FakeConnector({ platform: "x" });
    expect((await f.healthProbe(ctx())).ok).toBe(true);
    expect((await f.setHealthy(false).healthProbe(ctx())).errorCode).toBe("UPSTREAM_5XX");
  });
});
