// I-16 interop nyata (Redis-queue compose): TS enqueue `fetch.py` (envelope + jobId TS) → worker-fetch-py (FakeConnector
// Python, handle_job asli) → `fetch.result` → consumer TS mem-parse FetchResultPayload. Bukti kontrak lintas runtime.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { FetchResultPayload } from "@smip/contracts";
import { BullMqQueue, createEnvelope } from "@smip/queue";

const REDIS_QUEUE = process.env.TEST_REDIS_QUEUE_URL ?? "redis://127.0.0.1:56379";
const PY = `${import.meta.dir}/../../../.venv/bin/python`;
const up = await (async () => {
  try {
    const r = new Bun.RedisClient(REDIS_QUEUE, { connectionTimeout: 2000, autoReconnect: false });
    await r.ping();
    r.close();
    const probe = Bun.spawnSync([PY, "-c", "import bullmq, smip_contracts"], { cwd: `${import.meta.dir}/../../../workers-py` });
    return existsSync(PY) && probe.exitCode === 0;
  } catch {
    return false;
  }
})();

describe.skipIf(!up)("I-16 interop TS ↔ worker-fetch-py", () => {
  const prefix = `pyi${Date.now()}`;
  const queue = new BullMqQueue({ connection: { url: REDIS_QUEUE }, prefix });
  afterAll(async () => {
    await queue.close();
    const r = new Bun.RedisClient(REDIS_QUEUE);
    const keys = (await r.send("KEYS", [`${prefix}:*`])) as string[];
    if (keys.length) await r.send("DEL", keys);
    r.close();
  });

  test("fetch.py → Python → fetch.result tervalidasi kontrak TS (jobId = kunci hasil TS)", async () => {
    const run = "0192f000-0000-7000-8000-0000000000a1";
    const proc = Bun.spawn([PY, "tests/interop_worker.py", REDIS_QUEUE, prefix], {
      cwd: `${import.meta.dir}/../../../workers-py`,
      stdout: "pipe",
      stderr: "pipe",
    });
    const got: FetchResultPayload[] = [];
    const sub = await queue.consume("fetch.result", async (m) => void got.push(m.payload), { parse: FetchResultPayload.parse });
    await queue.enqueue(
      "fetch.py",
      createEnvelope({
        type: "fetch.request",
        idempotencyKey: `run.${run}.attempt.1`,
        tenantId: null,
        payload: {
          crawl_run_id: run,
          attempt_no: 1,
          connector_id: "0192f000-0000-7000-8000-000000000011",
          connector_key: "fake.x.py",
          connector_version: "0.1.0",
          provider_account_id: "0192f000-0000-7000-8000-000000000013",
          reservation_id: "res-1",
          request: {
            requestId: Bun.randomUUIDv7(),
            idempotencyKey: `run.${run}.attempt.1`,
            platform: "x",
            operation: "search_keyword",
            queries: [{ native: "kopdes", sourceNodeIds: [] }],
            window: { since: "2026-09-27T00:00:00.000Z" },
            cursor: null,
            pageLimit: 1,
            maxItems: 10,
          },
          deadline_at: new Date(Date.now() + 30_000).toISOString(),
        },
      }),
    );
    const t0 = Date.now();
    while (!got.length && Date.now() - t0 < 25_000) await Bun.sleep(50);
    const code = await proc.exited;
    await sub.close(1000);
    if (!got.length) throw new Error(`python: ${await new Response(proc.stderr).text()}`);
    expect(code).toBe(0);
    expect(got[0]).toMatchObject({ crawl_run_id: run, outcome: "success", items_count: 2, part: 0, error: null });
    expect(got[0]!.items_ref).toStartWith("mem://batches/");
  }, 30_000);
});
