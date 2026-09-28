// Service `worker-pipeline` (ARCHITECTURE §5): consume pipeline.items → match lokal, dedupe, geo, iklan.
// Enqueue hilir (ai.enrich / sink.analytics) lewat outbox; relay dijalankan scheduler/worker-dispatch.
import { loadConfig } from "@smip/config";
import { PipelineItemsPayload } from "@smip/contracts";
import { createDb, loadGeoRegions } from "@smip/db";
import { Gazetteer } from "@smip/geo";
import { createLogger } from "@smip/observability";
import { BullMqQueue } from "@smip/queue";
import { S3BlobStore } from "@smip/storage";
import { Deduper } from "./dedupe";
import { cachedGazetteer, handlePipelineItems } from "./pipeline";

const cfg = loadConfig("worker-pipeline");
const logger = createLogger({ service: "worker-pipeline", version: cfg.SERVICE_VERSION, env: cfg.NODE_ENV, level: cfg.LOG_LEVEL });
const { db, close } = createDb(cfg.DATABASE_URL, { max: 6 });
const cache = new Bun.RedisClient(cfg.REDIS_CACHE_URL);
const queue = new BullMqQueue({ connection: { url: cfg.REDIS_URL }, logger });
const deps = {
  db,
  blobs: new S3BlobStore({
    endpoint: cfg.S3_ENDPOINT!,
    region: cfg.S3_REGION,
    bucket: cfg.S3_BUCKET_RAW!,
    accessKeyId: cfg.S3_ACCESS_KEY_ID!,
    secretAccessKey: cfg.S3_SECRET_ACCESS_KEY!,
  }),
  dedupe: new Deduper(cache),
  gazetteer: cachedGazetteer(async () => new Gazetteer(await loadGeoRegions(db))),
  logger,
};
const sub = await queue.consume("pipeline.items", async (m) => void (await handlePipelineItems(deps, m.payload)), {
  parse: PipelineItemsPayload.parse,
});
logger.info("worker-pipeline mulai");

async function shutdown() {
  await sub.close(30_000);
  await queue.close();
  cache.close();
  await close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
