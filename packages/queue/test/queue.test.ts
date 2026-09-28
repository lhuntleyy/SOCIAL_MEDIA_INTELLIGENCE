// Integrasi F-08 (QUEUE_SPEC §4.3 / TESTING §4.3) — butuh Redis-queue (scripts/spike-infra.sh start → :6390).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PermanentJobError, type Subscription } from "@smip/core";
import { initTracing, tracer } from "@smip/observability";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import IORedis from "ioredis";
import { z } from "zod";
import { BullMqQueue, createEnvelope } from "../src";

// default: Redis-queue compose; override TEST_REDIS_QUEUE_URL (spike: redis://127.0.0.1:6390)
const RQ = new URL(process.env.TEST_REDIS_QUEUE_URL ?? "redis://127.0.0.1:56379");
const REDIS = { host: RQ.hostname, port: Number(RQ.port), maxRetriesPerRequest: null };
const up = await new IORedis({ ...REDIS, lazyConnect: true, retryStrategy: () => null })
  .connect()
  .then(() => true)
  .catch(() => false);

const Payload = z.object({ n: z.number() });
const parse = (p: unknown) => Payload.parse(p);
const waitFor = async <T>(fn: () => T | undefined | Promise<T | undefined>, ms = 8000): Promise<T> => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > ms) throw new Error("timeout menunggu kondisi");
    await Bun.sleep(25);
  }
};
let seq = 0;
const env = (n: number, key = `t.${Date.now()}.${seq++}`) =>
  createEnvelope({ type: "crawl.dispatch", idempotencyKey: key, tenantId: null, payload: { n } });

describe.skipIf(!up)("BullMqQueue (integrasi Redis)", () => {
  const prefix = `smiptest${Date.now()}`;
  const exporter = new InMemorySpanExporter();
  let tracing: { shutdown: () => Promise<void> };
  let q: BullMqQueue;
  const subs: Subscription[] = [];

  beforeAll(() => {
    tracing = initTracing({ serviceName: "queue-test", exporter });
    q = new BullMqQueue({
      connection: REDIS,
      prefix,
      policies: {
        "crawl.dispatch": { attempts: 3, backoff: { type: "fixed", delay: 30 } },
        "fetch.bun": { attempts: 1, timeoutMs: 10_000 },
        "fetch.resume": { attempts: 1, timeoutMs: 300 },
      },
      worker: { lockDuration: 1000, stalledInterval: 500 },
    });
  });
  afterAll(async () => {
    await Promise.all(subs.map((s) => s.close(100)));
    await q.close();
    const r = new IORedis(REDIS);
    const keys = await r.keys(`${prefix}:*`);
    if (keys.length) await r.del(...keys);
    await r.quit();
    await tracing.shutdown();
  });

  test("envelope tidak valid ditolak sebelum menyentuh Redis (jobId ':' — S-03)", async () => {
    expect(() => env(1, "run:1:attempt:1")).toThrow();
    await expect(q.enqueue("crawl.dispatch", { ...env(1), v: 2 } as never)).rejects.toThrow(/envelope tidak valid/);
  });

  test("consume + idempotensi jobId: enqueue ganda diproses sekali", async () => {
    const seen: number[] = [];
    subs.push(await q.consume("health.probe", async (m) => void seen.push(m.payload.n), { parse }));
    const e = createEnvelope({ type: "health.probe", idempotencyKey: `hp.fake.acc.${Date.now()}`, tenantId: null, payload: { n: 7 } });
    await q.enqueue("health.probe", e);
    await q.enqueue("health.probe", e);
    await waitFor(() => (seen.length ? seen : undefined));
    await Bun.sleep(300);
    expect(seen).toEqual([7]);
  });

  test("poison (payload invalid) → DLQ tanpa retry, handler tidak dipanggil", async () => {
    let calls = 0;
    subs.push(await q.consume("alert.evaluate", async () => void calls++, { parse }));
    const bad = createEnvelope({
      type: "alert.evaluate",
      idempotencyKey: `poison.${Date.now()}`,
      tenantId: null,
      payload: { n: "bukan angka" },
    });
    await q.enqueue("alert.evaluate", bad);
    const [entry] = await waitFor(async () => {
      const d = await q.listDlq("alert.evaluate");
      return d.length ? d : undefined;
    });
    expect(calls).toBe(0);
    expect(entry!.poison).toBe(true);
    expect(entry!.attempts).toBeLessThanOrEqual(1);
  });

  test("retry habis → DLQ dengan error ter-redact; redrive → diproses", async () => {
    let fail = true;
    const ok: number[] = [];
    subs.push(
      await q.consume(
        "crawl.dispatch",
        async (m, ctx) => {
          if (fail) throw new Error(`provider 401 token=Rahasia123 attempt ${ctx.attempt}`);
          ok.push(m.payload.n);
        },
        { parse },
      ),
    );
    const e = env(42);
    await q.enqueue("crawl.dispatch", e);
    const [entry] = await waitFor(async () => {
      const d = (await q.listDlq("crawl.dispatch")).filter((x) => x.job_id === e.idempotency_key);
      return d.length ? d : undefined;
    });
    expect(entry!.attempts).toBe(3);
    expect(entry!.poison).toBe(false);
    expect(entry!.last_error).not.toContain("Rahasia123");
    fail = false;
    const newKey = await q.redrive("crawl.dispatch", e.idempotency_key);
    expect(newKey).toBe(`${e.idempotency_key}.redrive.1`);
    await waitFor(() => (ok.includes(42) ? true : undefined));
    expect((await q.listDlq("crawl.dispatch")).some((x) => x.job_id === e.idempotency_key)).toBe(false);
  });

  test("PermanentJobError tidak di-retry walau policy attempts 5 → DLQ", async () => {
    let attempts = 0;
    subs.push(
      await q.consume(
        "ai.llm_fallback",
        async () => {
          attempts++;
          throw new PermanentJobError("label ditolak permanen");
        },
        { parse },
      ),
    );
    const perm = createEnvelope({ type: "ai.llm_fallback", idempotencyKey: `perm.${Date.now()}`, tenantId: null, payload: { n: 1 } });
    await q.enqueue("ai.llm_fallback", perm);
    const [pe] = await waitFor(async () => {
      const d = (await q.listDlq("ai.llm_fallback")).filter((x) => x.job_id === perm.idempotency_key);
      return d.length ? d : undefined;
    });
    expect(pe!.poison).toBe(true);
    expect(attempts).toBe(1);
  });

  test("timeout job: signal di-abort, job gagal dengan pesan timeout → DLQ", async () => {
    let sawAbort = false;
    subs.push(
      await q.consume(
        "fetch.resume",
        async (_m, ctx) => {
          await new Promise<void>((_, rej) =>
            ctx.signal.addEventListener("abort", () => {
              sawAbort = true;
              rej(ctx.signal.reason);
            }),
          );
        },
        { parse },
      ),
    );
    const e = createEnvelope({ type: "fetch.resume", idempotencyKey: `slow.${Date.now()}`, tenantId: null, payload: { n: 9 } });
    const t0 = Date.now();
    await q.enqueue("fetch.resume", e);
    const [d] = await waitFor(async () => {
      const x = (await q.listDlq("fetch.resume")).filter((y) => y.job_id === e.idempotency_key);
      return x.length ? x : undefined;
    });
    expect(sawAbort).toBe(true);
    expect(d!.last_error).toContain("timeout 300 ms");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
  });

  test("trace producer → consumer: trace_id sama lintas queue (QUEUE_SPEC §9)", async () => {
    let consumerTrace: string | undefined;
    subs.push(
      await q.consume(
        "realtime.notify",
        async () => {
          consumerTrace = (await import("@opentelemetry/api")).trace.getActiveSpan()?.spanContext().traceId;
        },
        { parse },
      ),
    );
    let producerTrace = "";
    await tracer().startActiveSpan("sink.insert", async (span) => {
      producerTrace = span.spanContext().traceId;
      await q.enqueue(
        "realtime.notify",
        createEnvelope({ type: "realtime.notify", idempotencyKey: `rn.${Date.now()}`, tenantId: null, payload: { n: 1 } }),
      );
      span.end();
    });
    await waitFor(() => consumerTrace);
    expect(consumerTrace).toBe(producerTrace);
  });

  test("graceful shutdown: job yang belum selesai dikembalikan ke queue (bukan gagal), diproses consumer lain", async () => {
    let startedA = false;
    const subA = await q.consume(
      "fetch.bun",
      async (_m, ctx) => {
        startedA = true;
        await new Promise<void>((_, rej) => ctx.signal.addEventListener("abort", () => rej(ctx.signal.reason)));
      },
      { parse },
    );
    const e = createEnvelope({
      type: "fetch.request",
      idempotencyKey: `run.gs.${Date.now()}.attempt.1`,
      tenantId: null,
      payload: { n: 5 },
    });
    await q.enqueue("fetch.bun", e);
    await waitFor(() => (startedA ? true : undefined));
    await subA.close(100);
    let attemptB = 0;
    subs.push(
      await q.consume(
        "fetch.bun",
        async (_m, ctx) => {
          attemptB = ctx.attempt;
        },
        { parse },
      ),
    );
    await waitFor(() => (attemptB ? attemptB : undefined));
    expect(attemptB).toBe(1); // pengembalian saat shutdown tidak menghabiskan attempt
    expect((await q.listDlq("fetch.bun")).length).toBe(0);
  });
});
