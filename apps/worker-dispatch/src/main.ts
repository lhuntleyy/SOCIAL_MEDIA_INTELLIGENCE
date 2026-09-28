// Service `worker-dispatch` (ARCHITECTURE §5): consume crawl.dispatch & fetch.result; relay outbox → queue.
// Profil MVP single-node: loop pemeliharaan router (sweeper reservasi, flush quota, refresh health) ikut di sini;
// dipindah ke worker-ops/worker-health saat skala naik.
import { loadConfig } from "@smip/config";
import { CrawlDispatchPayload, FetchResultPayload } from "@smip/contracts";
import {
  CONFIG_CHANNEL,
  createDb,
  flushQuotaUsage,
  loadQuotaUsage,
  loadRoutingSnapshot,
  markAccountAttention,
  markCapabilityFailed,
  publishOutbox,
  reactivateCooledAccounts,
  setAccountCooldown,
} from "@smip/db";
import { createLogger } from "@smip/observability";
import { BullMqQueue } from "@smip/queue";
import { HealthCache, HealthMonitor, RedisReserver, Router, SnapshotStore } from "@smip/router";
import { jobRelay } from "@smip/scheduler";
import { handleDispatch, handleFetchResult } from "./dispatch";

const cfg = loadConfig("worker-dispatch");
const logger = createLogger({ service: "worker-dispatch", version: cfg.SERVICE_VERSION, env: cfg.NODE_ENV, level: cfg.LOG_LEVEL });
const { db, close } = createDb(cfg.DATABASE_URL, { max: 10 });
const cache = new Bun.RedisClient(cfg.REDIS_CACHE_URL);
const queue = new BullMqQueue({ connection: { url: cfg.REDIS_URL }, logger });
const store = new SnapshotStore((v) => loadRoutingSnapshot(db, v), { get: (k) => cache.get(k) }, { logger });
const reserver = new RedisReserver(cache, {
  seed: (k) => loadQuotaUsage(db, k),
  onThreshold: (e) => logger.warn("quota threshold", { key: e.key, threshold: e.threshold }),
});
const monitor = new HealthMonitor(cache, { onTransition: (t) => logger.warn("circuit berubah", { ...t }) });
const health = new HealthCache(monitor);
const router = new Router({
  snapshots: store,
  reserver,
  health,
  monitor,
  logger,
  effects: {
    accountAttention: (a, code) => markAccountAttention(db, a, code),
    accountCooldown: (a, until, code) => setAccountCooldown(db, a, new Date(until), code),
    capabilityFailed: (c, op) => markCapabilityFailed(db, c, op),
    alert: async (e) => logger.warn("alert router", { event: e.event, connector_id: e.connectorId, code: e.code }),
  },
});
const deps = { db, router, snapshots: store, logger };

const subs = [
  await queue.consume("crawl.dispatch", async (m) => void (await handleDispatch(deps, m.payload)), { parse: CrawlDispatchPayload.parse }),
  await queue.consume("fetch.result", async (m) => void (await handleFetchResult(deps, m.payload)), { parse: FetchResultPayload.parse }),
];

// invalidasi snapshot instan saat config berubah (selain poll cfg:version)
const sub = new Bun.RedisClient(cfg.REDIS_CACHE_URL);
await sub.subscribe(CONFIG_CHANNEL, () => void store.refresh().catch(() => {}));
store.start();

const bus = { publish: (c: string, m: string) => cache.publish(c, m), incr: (k: string) => cache.incr(k) };
const loops = [
  setInterval(async () => {
    try {
      while ((await publishOutbox(db, bus, { enqueue: jobRelay(queue) })) > 0) {}
    } catch (e) {
      logger.error("relay outbox gagal", { error: e });
    }
  }, 1000),
  setInterval(async () => {
    try {
      await health.refresh(await store.get());
    } catch (e) {
      logger.error("refresh health gagal", { error: e });
    }
  }, 10_000),
  setInterval(async () => {
    try {
      const swept = await reserver.sweep();
      if (swept) logger.warn("reservasi kedaluwarsa dilepas", { count: swept });
      const rows = await reserver.drainDirty();
      try {
        await flushQuotaUsage(db, rows);
      } catch (e) {
        await reserver.markDirty(rows);
        throw e;
      }
      await reactivateCooledAccounts(db);
    } catch (e) {
      logger.error("pemeliharaan router gagal", { error: e });
    }
  }, 30_000),
];
logger.info("worker-dispatch mulai");

async function shutdown() {
  for (const l of loops) clearInterval(l);
  store.stop();
  for (const s of subs) await s.close(10_000);
  await queue.close();
  sub.close();
  cache.close();
  await close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
