// I-13 unit worker-fetch-bun: batas halaman/item, error di tengah (item tetap diteruskan), deadline, redaksi.
import { beforeEach, describe, expect, test } from "bun:test";
import { FakeConnector, fakeItem } from "@smip/connector-fake";
import { ConnectorError } from "@smip/connector-sdk";
import type { FetchRequestPayload } from "@smip/contracts";
import { createLogger } from "@smip/observability";
import { MemoryBlobStore } from "@smip/storage";
import { type AccountLoader, executeFetch } from "../src";

const id = (n: number) => `0192f000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const fake = new FakeConnector({ platform: "x" });
const blobs = new MemoryBlobStore();
const logs: string[] = [];
const logger = createLogger({ service: "t", level: "debug", sink: (l) => logs.push(l) });
const accounts: AccountLoader = async () => ({ credential: { kind: "api_key", secret: { api_key: "SANGAT-RAHASIA-123" } }, config: {} });
const deps = () => ({ connectors: new Map([[fake.manifest.key, fake]]), accounts, blobs, logger });
const msg = (o: Partial<FetchRequestPayload["request"]> = {}, deadlineMs = 5000): FetchRequestPayload => ({
  crawl_run_id: id(1),
  attempt_no: 1,
  connector_id: id(2),
  connector_key: "fake.x",
  connector_version: "0.1.0",
  provider_account_id: id(3),
  reservation_id: "r1",
  request: {
    requestId: id(4),
    idempotencyKey: `run.${id(1)}.attempt.1`,
    platform: "x",
    operation: "search_keyword",
    queries: [
      { native: "a", sourceNodeIds: ["a"] },
      { native: "b", sourceNodeIds: ["b"] },
    ],
    pageLimit: 2,
    maxItems: 100,
    ...o,
  },
  deadline_at: new Date(Date.now() + deadlineMs).toISOString(),
});
const it = (n: number) => fakeItem("x", n);

describe("executeFetch", () => {
  beforeEach(() => {
    fake.reset();
    logs.length = 0;
  });

  test("pageLimit per sub-query dihormati; usage dijumlah; item unik → items_ref", async () => {
    fake.script([
      { respond: { items: [it(1), it(2)], nextCursor: "p2", returned: 3 } },
      { respond: { items: [it(3)], nextCursor: "p3" } }, // halaman ke-2 = batas pageLimit
      { respond: { items: [it(3), it(4)] } }, // sub-query b; it(3) duplikat
    ]);
    const r = await executeFetch(deps(), msg());
    expect(r).toMatchObject({ outcome: "success", items_count: 4, has_more: false, error: null });
    expect(r.usage).toMatchObject({ requests: 3, results: 6 });
    expect(fake.calls.map((c) => [c.query?.native, c.cursor, c.idempotencyKey.split(".").slice(-3).join(".")])).toEqual([
      ["a", null, "q0.page.1"],
      ["a", "p2", "q0.page.2"],
      ["b", null, "q1.page.1"],
    ]);
    expect((await blobs.getJsonl(r.items_ref!)).length).toBe(4);
  });

  test("maxItems total menghentikan sub-query berikutnya", async () => {
    fake.script([{ respond: { items: [it(1), it(2), it(3)] } }]);
    const r = await executeFetch(deps(), msg({ maxItems: 3 }));
    expect([r.items_count, fake.calls.length]).toEqual([3, 1]);
  });

  test("error di sub-query kedua → outcome error, item sub-query pertama TETAP diteruskan (sudah dibayar)", async () => {
    fake.script([{ respond: { items: [it(1)] } }, { fail: { code: "RATE_LIMITED", retryAfterMs: 30_000, httpStatus: 429 } }]);
    const r = await executeFetch(deps(), msg());
    expect(r).toMatchObject({
      outcome: "error",
      items_count: 1,
      error: { code: "RATE_LIMITED", retry_after_ms: 30_000, scope: "account", http_status: 429 },
    });
    expect(r.items_ref).not.toBeNull();
  });

  test("deadline: connector lambat → TIMEOUT; deadline sudah lewat → TIMEOUT tanpa panggil connector", async () => {
    fake.script([{ delayMs: 2000 }]);
    const r = await executeFetch(deps(), msg({}, 100));
    expect(r.error?.code).toBe("TIMEOUT");
    fake.reset();
    const r2 = await executeFetch(deps(), msg({}, -1));
    expect([r2.error?.code, fake.calls.length]).toEqual(["TIMEOUT", 0]);
  });

  test("connector belum dimuat worker → NETWORK sementara (bukan NOT_SUPPORTED: capability tidak dimatikan); kredensial gagal → AUTH_INVALID", async () => {
    const r = await executeFetch(deps(), { ...msg(), connector_key: "hilang.x" });
    expect(r.error).toMatchObject({ code: "NETWORK", scope: "connector", retry_after_ms: 60_000 });
    const bad = await executeFetch(
      {
        ...deps(),
        accounts: async () => {
          throw new ConnectorError("AUTH_INVALID", "credential dicabut", { scope: "account" });
        },
      },
      msg(),
    );
    expect(bad.error).toMatchObject({ code: "AUTH_INVALID", scope: "account" });
  });

  test("secret kredensial tidak pernah muncul di log maupun hasil", async () => {
    fake.script([{ fail: { code: "UPSTREAM_5XX" } }]);
    const r = await executeFetch(deps(), msg());
    expect(JSON.stringify(r)).not.toContain("SANGAT-RAHASIA");
    expect(logs.join("\n")).not.toContain("SANGAT-RAHASIA");
  });
});
