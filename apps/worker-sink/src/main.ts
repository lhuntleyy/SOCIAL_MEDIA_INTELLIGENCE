// Service `worker-sink` (ARCHITECTURE §5): consume sink.analytics → ClickHouse + penutupan run + realtime.notify.
import { createClient } from "@clickhouse/client";
import { loadConfig } from "@smip/config";
import { SinkAnalyticsPayload } from "@smip/contracts";
import { createDb } from "@smip/db";
import { createLogger } from "@smip/observability";
import { BullMqQueue } from "@smip/queue";
import { S3BlobStore } from "@smip/storage";
import { planEngagementRefresh } from "./refresh";
import { handleSink } from "./sink";

const cfg = loadConfig("worker-sink");
const logger = createLogger({ service: "worker-sink", version: cfg.SERVICE_VERSION, env: cfg.NODE_ENV, level: cfg.LOG_LEVEL });
const { db, close } = createDb(cfg.DATABASE_URL, { max: 4 });
const ch = createClient({
  url: cfg.CLICKHOUSE_URL,
  database: cfg.CLICKHOUSE_DB,
  username: cfg.CLICKHOUSE_USER,
  password: cfg.CLICKHOUSE_PASSWORD,
});
const queue = new BullMqQueue({ connection: { url: cfg.REDIS_URL }, logger });
const blobs = new S3BlobStore({
  endpoint: cfg.S3_ENDPOINT!,
  region: cfg.S3_REGION,
  bucket: cfg.S3_BUCKET_RAW!,
  accessKeyId: cfg.S3_ACCESS_KEY_ID!,
  secretAccessKey: cfg.S3_SECRET_ACCESS_KEY!,
});
// concurrency 1: guard dedup ClickHouse "cek lalu insert" tidak atomik (DATA_MODEL §6.2)
const sub = await queue.consume("sink.analytics", async (m) => void (await handleSink({ db, ch, blobs, logger }, m.payload)), {
  parse: SinkAnalyticsPayload.parse,
  concurrency: 1,
});
// I-20 planner engagement refresh: satu pemegang lock di antara replika (SET NX PX); run & job ditulis atomik (outbox)
const cache = new Bun.RedisClient(cfg.REDIS_CACHE_URL);
const LOCK = "lock:engagement-refresh:planner";
const owner = Bun.randomUUIDv7();
let planning = false;
async function planRefresh() {
  if (planning) return;
  planning = true;
  try {
    const ok = await cache.send("SET", [LOCK, owner, "NX", "PX", String(Math.max(60_000, cfg.ENGAGEMENT_REFRESH_PLAN_MS! - 5000))]);
    if (ok !== "OK") return;
    const r = await planEngagementRefresh(db, ch, {
      maxAgeHours: cfg.ENGAGEMENT_REFRESH_MAX_AGE_HOURS,
      refreshEverySec: cfg.ENGAGEMENT_REFRESH_MIN_GAP_SEC,
      maxPostsPerPlatform: cfg.ENGAGEMENT_REFRESH_MAX_POSTS,
    });
    if (r.runs || r.skippedPlatforms.length) logger.info("engagement refresh direncanakan", { ...r });
  } catch (e) {
    logger.error("planner engagement refresh gagal", { error: e });
  } finally {
    planning = false;
  }
}
const refreshTimer = cfg.ENGAGEMENT_REFRESH_ENABLED ? setInterval(planRefresh, cfg.ENGAGEMENT_REFRESH_PLAN_MS!) : undefined;
logger.info("worker-sink mulai", { engagement_refresh: cfg.ENGAGEMENT_REFRESH_ENABLED });
const shutdown = async () => {
  if (refreshTimer) clearInterval(refreshTimer);
  await sub.close(30_000);
  await queue.close();
  await ch.close();
  cache.close();
  await close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
