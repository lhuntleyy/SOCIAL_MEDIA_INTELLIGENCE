// S-05 spike (Redis-queue compose): sumber sinyal autoscaling untuk BullMQ.
// KEDA scaler `redis` (listLength) membaca LLEN satu key list. Test ini membuktikan key mana yang terisi per jenis job:
// job biasa → list `wait`; job ber-priority → sorted set `prioritized`; job delay → sorted set `delayed`.
// Kesimpulan (DEPLOYMENT §4, ADR-001): LLEN `wait` MENGABAIKAN job prioritized (crawl.dispatch/fetch memakai priority)
// → autoscaling memakai metric `smip_queue_depth{state}` + KEDA Prometheus scaler.
import { afterAll, describe, expect, test } from "bun:test";
import { BullMqQueue, createEnvelope } from "../src";

const REDIS_QUEUE = process.env.TEST_REDIS_QUEUE_URL ?? "redis://127.0.0.1:56379";
const up = await (async () => {
  try {
    const r = new Bun.RedisClient(REDIS_QUEUE, { connectionTimeout: 2000, autoReconnect: false });
    await r.ping();
    r.close();
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!up)("S-05 KEDA: struktur key BullMQ vs scaler Redis list", () => {
  const prefix = `keda${Date.now()}`;
  const q = new BullMqQueue({ connection: { url: REDIS_QUEUE }, prefix });
  const redis = new Bun.RedisClient(REDIS_QUEUE);
  afterAll(async () => {
    await q.close();
    const keys = (await redis.send("KEYS", [`${prefix}:*`])) as string[];
    if (keys.length) await redis.send("DEL", keys);
    redis.close();
  });
  const env = (i: number) =>
    createEnvelope({ type: "crawl.dispatch", idempotencyKey: `k05.${i}`, tenantId: null, payload: { i } as never });

  test("LLEN wait hanya melihat job tanpa priority/delay; depth() melihat semuanya", async () => {
    await q.enqueueBulk("crawl.dispatch", [env(1), env(2), env(3)]); // biasa
    await q.enqueue("crawl.dispatch", env(4), { priority: 1 });
    await q.enqueue("crawl.dispatch", env(5), { priority: 10 });
    await q.enqueue("crawl.dispatch", env(6), { delayMs: 60_000 });
    const k = (s: string) => `${prefix}:crawl.dispatch:${s}`;
    const llenWait = Number(await redis.send("LLEN", [k("wait")]));
    const zPrio = Number(await redis.send("ZCARD", [k("prioritized")]));
    const zDelay = Number(await redis.send("ZCARD", [k("delayed")]));
    expect([llenWait, zPrio, zDelay]).toEqual([3, 2, 1]);
    expect(await q.depth("crawl.dispatch")).toEqual({ waiting: 3, prioritized: 2, delayed: 1, active: 0, backlog: 5 });
    // scaler Redis list KEDA (listName = <prefix>:crawl.dispatch:wait) akan melihat 3, padahal backlog siap jalan = 5
    expect(llenWait).toBeLessThan((await q.depth("crawl.dispatch")).backlog);
  });
});
