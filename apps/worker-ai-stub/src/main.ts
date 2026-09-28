// Service dev `worker-ai-stub`: consume ai.enrich → sink.analytics (label netral "stub-0"). DILARANG di produksi.
import { loadConfig } from "@smip/config";
import { AiEnrichPayload, type PostRecord } from "@smip/contracts";
import { createLogger } from "@smip/observability";
import { BullMqQueue, createEnvelope } from "@smip/queue";
import { S3BlobStore } from "@smip/storage";
import { stubEnrich } from "./stub";

const cfg = loadConfig("worker-pipeline");
if (cfg.NODE_ENV === "production") throw new Error("worker-ai-stub dilarang di produksi — pakai worker-ai (Python)");
const logger = createLogger({ service: "worker-ai-stub", env: cfg.NODE_ENV, level: cfg.LOG_LEVEL });
const queue = new BullMqQueue({ connection: { url: cfg.REDIS_URL }, logger });
const blobs = new S3BlobStore({
  endpoint: cfg.S3_ENDPOINT!,
  region: cfg.S3_REGION,
  bucket: cfg.S3_BUCKET_RAW!,
  accessKeyId: cfg.S3_ACCESS_KEY_ID!,
  secretAccessKey: cfg.S3_SECRET_ACCESS_KEY!,
});
const sub = await queue.consume(
  "ai.enrich",
  async (m) => {
    const out = stubEnrich(m.payload, await blobs.getJsonl<PostRecord>(m.payload.items_ref!));
    await queue.enqueue(
      "sink.analytics",
      createEnvelope({ type: "sink.analytics", idempotencyKey: `sink.${out.batch_id}`, tenantId: out.tenant_id, payload: out }),
    );
  },
  { parse: AiEnrichPayload.parse },
);
logger.warn("worker-ai-stub mulai — label NETRAL, bukan inferensi nyata");
const shutdown = async () => {
  await sub.close(10_000);
  await queue.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
