// Service `scheduler` (ARCHITECTURE §5): 2 replika, 1 leader. Tick 15 s (plan jatuh tempo), reaper 60 s,
// relay outbox → queue/pubsub tiap 1 s. Semua pekerjaan hanya oleh leader; SKIP LOCKED menjaga bila lock sempat ganda.
import { loadConfig } from "@smip/config";
import { createDb, publishOutbox } from "@smip/db";
import { Counter, createLogger } from "@smip/observability";
import { BullMqQueue } from "@smip/queue";
import { LeaderLock } from "./leader";
import { reapStuckRuns } from "./reaper";
import { jobRelay } from "./relay";
import { planStreams } from "./streams";
import { schedulerTick } from "./tick";

const cfg = loadConfig("scheduler");
// loadConfig("scheduler") sudah memvalidasi & mengisi default; tipe gabungan membuatnya opsional
const TICK_MS = cfg.SCHEDULER_TICK_MS!;
const GRACE_SEC = cfg.SCHEDULER_STUCK_RUN_GRACE_SEC!;
const BACKPRESSURE = cfg.SCHEDULER_BACKPRESSURE_WAITING!;
const MAX_GAP_AGE_SEC = cfg.SCHEDULER_MAX_GAP_AGE_SEC!;
const gapAbandoned = new Counter("smip_crawl_gap_abandoned_total", "Celah partial success yang dibuang karena melewati max_gap_age", [
  "platform",
]);
const costGuardThrottled = new Counter("smip_cost_guard_throttled_total", "Soft cap biaya tercapai → throttle interval (bukan stop)", [
  "scope_type",
]);
const logger = createLogger({ service: "scheduler", version: cfg.SERVICE_VERSION, env: cfg.NODE_ENV, level: cfg.LOG_LEVEL });
const { db, close } = createDb(cfg.DATABASE_URL, { max: 4 });
const cache = new Bun.RedisClient(cfg.REDIS_CACHE_URL);
const queue = new BullMqQueue({ connection: { url: cfg.REDIS_URL }, logger });
const leader = new LeaderLock(cache, { ttlMs: Math.max(30_000, TICK_MS * 2) });
const bus = { publish: (c: string, m: string) => cache.publish(c, m), incr: (k: string) => cache.incr(k) };

let busy = false;
let lastReap = 0;
let lastPlan = 0;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    if (!(await leader.ensure())) return;
    const fetchWaiting = (await queue.waitingCount("fetch.bun")) + (await queue.waitingCount("fetch.py"));
    const r = await schedulerTick(db, {
      initialLookbackSec: cfg.SCHEDULER_INITIAL_LOOKBACK_SEC,
      backpressure: () => fetchWaiting > BACKPRESSURE,
      maxGapAgeSec: MAX_GAP_AGE_SEC,
      costGuard: { throttleIntervalSec: cfg.SCHEDULER_COST_GUARD_INTERVAL_SEC },
    });
    for (const p of r.costGuard.throttledNow) {
      costGuardThrottled.inc({ scope_type: p.scope_type });
      logger.warn("cost guard: soft cap tercapai → interval di-throttle (ingestion tetap jalan)", {
        policy_id: p.id,
        scope_type: p.scope_type,
        scope_id: p.scope_id,
        unit: p.unit,
        used: p.used,
        limit: p.limit,
      });
    }
    for (const id of r.costGuard.released) logger.info("cost guard: soft cap dilepas, interval normal kembali", { policy_id: id });
    for (const [platform, n] of Object.entries(r.gapsAbandoned)) {
      gapAbandoned.inc({ platform }, n);
      logger.warn("celah dibuang (melewati max_gap_age) — data hilang yang disadari", { platform, count: n });
    }
    if (r.scheduled || r.coalesced || r.deferred) logger.info("tick", { ...r, fetch_waiting: fetchWaiting });
    if (cfg.SCHEDULER_STREAMS_ENABLED && Date.now() - lastPlan >= cfg.SCHEDULER_STREAM_PLAN_MS!) {
      lastPlan = Date.now();
      const p = await planStreams(db);
      if (p.created || p.retired) logger.info("collection stream direncanakan ulang", { ...p });
    }
    if (Date.now() - lastReap >= 60_000) {
      lastReap = Date.now();
      const stuck = await reapStuckRuns(db, { graceSec: GRACE_SEC });
      if (stuck.length) logger.warn("reaper: run macet dibebaskan", { count: stuck.length });
    }
  } catch (e) {
    logger.error("tick gagal", { error: e });
  } finally {
    busy = false;
  }
}

let relaying = false;
async function relay() {
  if (relaying || !leader.isLeader) return;
  relaying = true;
  try {
    while ((await publishOutbox(db, bus, { enqueue: jobRelay(queue) })) > 0) {}
  } catch (e) {
    logger.error("relay outbox gagal", { error: e });
  } finally {
    relaying = false;
  }
}

const t1 = setInterval(tick, TICK_MS);
const t2 = setInterval(relay, 1000);
void tick();
logger.info("scheduler mulai", { tick_ms: TICK_MS, owner: leader.owner });

async function shutdown() {
  clearInterval(t1);
  clearInterval(t2);
  await leader.release();
  await queue.close();
  cache.close();
  await close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
