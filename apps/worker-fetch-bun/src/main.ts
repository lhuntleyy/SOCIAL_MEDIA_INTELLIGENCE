// Service `worker-fetch-bun` (ARCHITECTURE §5): consume fetch.bun → executeFetch → fetch.result.
import { loadConfig } from "@smip/config";
import { FetchRequestPayload } from "@smip/contracts";
import { createKms } from "@smip/crypto";
import { createDb } from "@smip/db";
import { createLogger } from "@smip/observability";
import { BullMqQueue, createEnvelope } from "@smip/queue";
import { RedisReserver } from "@smip/router";
import { S3BlobStore } from "@smip/storage";
import { dbAccountLoader } from "./accounts";
import { executeFetch } from "./execute";
import { connectorRegistry } from "./registry";

const cfg = loadConfig("worker-fetch-bun");
const logger = createLogger({ service: "worker-fetch-bun", version: cfg.SERVICE_VERSION, env: cfg.NODE_ENV, level: cfg.LOG_LEVEL });
const { db, close } = createDb(cfg.DATABASE_URL, { max: 4 });
const cache = new Bun.RedisClient(cfg.REDIS_CACHE_URL);
const reserver = new RedisReserver(cache);
const queue = new BullMqQueue({ connection: { url: cfg.REDIS_URL }, logger });
const blobs = new S3BlobStore({
  endpoint: cfg.S3_ENDPOINT!,
  region: cfg.S3_REGION,
  bucket: cfg.S3_BUCKET_RAW!,
  accessKeyId: cfg.S3_ACCESS_KEY_ID!,
  secretAccessKey: cfg.S3_SECRET_ACCESS_KEY!,
});
const connectors = connectorRegistry(cfg.NODE_ENV);
const deps = {
  connectors,
  accounts: dbAccountLoader(db, createKms(cfg)),
  blobs,
  logger,
  onRateLimit: (accountId: string, i: { retryAfterMs: number | null }) => reserver.setDynamicLimit(accountId, i.retryAfterMs ?? 0),
};

const sub = await queue.consume(
  "fetch.bun",
  async (m, ctx) => {
    const res = await executeFetch(deps, m.payload, ctx.signal);
    await queue.enqueue(
      "fetch.result",
      createEnvelope({
        type: "fetch.result",
        idempotencyKey: `run.${res.crawl_run_id}.attempt.${res.attempt_no}.result`,
        tenantId: m.tenant_id,
        payload: res,
      }),
    );
  },
  { parse: FetchRequestPayload.parse },
);
logger.info("worker-fetch-bun mulai", { connectors: [...connectors.keys()] });

async function shutdown() {
  await sub.close(30_000);
  await queue.close();
  cache.close();
  await close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
