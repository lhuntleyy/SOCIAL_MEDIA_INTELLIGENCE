// Service `worker-sink` (ARCHITECTURE §5): consume sink.analytics → ClickHouse + penutupan run + realtime.notify.
import { createClient } from "@clickhouse/client";
import { loadConfig } from "@smip/config";
import { HttpClient } from "@smip/connector-sdk";
import { SinkAnalyticsPayload } from "@smip/contracts";
import { createKms } from "@smip/crypto";
import { createDb } from "@smip/db";
import { createLogger } from "@smip/observability";
import { BullMqQueue } from "@smip/queue";
import { S3BlobStore } from "@smip/storage";
import { z } from "zod";
import { evaluateAlerts } from "./alerts";
import { planComments } from "./comments";
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
// planner komentar (Pengaturan → Batas & jadwal → Komentar): tiap 15 menit, satu pemegang lock
const COMMENTS_LOCK = "lock:comments:planner";
let planningComments = false;
async function planCommentsTick() {
  if (planningComments) return;
  planningComments = true;
  try {
    if ((await cache.send("SET", [COMMENTS_LOCK, owner, "NX", "PX", String(14 * 60_000)])) !== "OK") return;
    const r = await planComments(db, ch);
    if (r.runs) logger.info("komentar direncanakan", { runs: r.runs, posts: r.posts });
  } catch (e) {
    logger.error("planner komentar gagal", { error: e });
  } finally {
    planningComments = false;
  }
}
const commentsTimer = setInterval(planCommentsTick, 15 * 60_000);
// D-03: realtime.notify (outbox sink) → Redis PUBLISH; replika API meneruskan ke klien SSE topik itu
const rtSub = await queue.consume(
  "realtime.notify",
  async (m) => {
    const p = m.payload;
    await cache.send("PUBLISH", [
      "smip:rt",
      JSON.stringify({
        tenant_id: p.tenant_id,
        topic_id: p.topic_id,
        event: "aggregates.updated",
        data: { buckets: p.buckets, platforms: p.platforms },
      }),
    ]);
  },
  {
    concurrency: 4,
    parse: z.object({ tenant_id: z.string(), topic_id: z.string(), buckets: z.array(z.string()), platforms: z.array(z.string()) }).parse,
  },
);
// O-05 alert: evaluasi aturan tiap ALERTS_EVAL_MS (satu pemegang lock), kirim Telegram/webhook lewat HttpClient (guard SSRF)
const kms = createKms(cfg);
const http = new HttpClient({ timeoutMs: 15_000 });
const ALERTS_LOCK = "lock:alerts:evaluator";
let evaluating = false;
async function alertsTick() {
  if (evaluating) return;
  evaluating = true;
  try {
    if ((await cache.send("SET", [ALERTS_LOCK, owner, "NX", "PX", String((cfg.ALERTS_EVAL_MS ?? 300_000) - 5000)])) !== "OK") return;
    const r = await evaluateAlerts({
      db,
      ch,
      kms,
      post: async (url, init) => ({ status: (await http.request(url, { ...init, throwOnStatus: false })).status }),
      appUrl: cfg.APP_PUBLIC_URL,
      onFired: (e) =>
        cache.send("PUBLISH", [
          "smip:rt",
          JSON.stringify({
            tenant_id: e.tenant_id,
            topic_id: null,
            event: "alert.fired",
            data: { event_id: e.event_id, title: e.title, topic_id: e.topic_id },
          }),
        ]),
    });
    if (r.fired) logger.info("alert terpicu", { ...r });
  } catch (e) {
    logger.error("evaluasi alert gagal", { error: e });
  } finally {
    evaluating = false;
  }
}
const alertsTimer = setInterval(alertsTick, cfg.ALERTS_EVAL_MS ?? 300_000);
logger.info("worker-sink mulai", { engagement_refresh: cfg.ENGAGEMENT_REFRESH_ENABLED });
const shutdown = async () => {
  if (refreshTimer) clearInterval(refreshTimer);
  clearInterval(commentsTimer);
  clearInterval(alertsTimer);
  await sub.close(30_000);
  await rtSub.close(5_000);
  await queue.close();
  await ch.close();
  cache.close();
  await close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
