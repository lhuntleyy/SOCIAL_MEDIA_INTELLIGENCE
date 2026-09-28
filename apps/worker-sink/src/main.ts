// Service `worker-sink` (ARCHITECTURE §5): consume sink.analytics → ClickHouse + penutupan run + realtime.notify.
import { createClient } from "@clickhouse/client";
import { loadConfig } from "@smip/config";
import { SinkAnalyticsPayload } from "@smip/contracts";
import { createDb } from "@smip/db";
import { createLogger } from "@smip/observability";
import { BullMqQueue } from "@smip/queue";
import { S3BlobStore } from "@smip/storage";
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
logger.info("worker-sink mulai");
const shutdown = async () => {
  await sub.close(30_000);
  await queue.close();
  await ch.close();
  await close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
