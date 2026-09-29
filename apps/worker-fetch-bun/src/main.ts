// Service `worker-fetch-bun` (ARCHITECTURE §5): consume fetch.bun/fetch.resume → executeFetch → fetch.result;
// + health.probe & connector.verify dari Admin API (profil MVP; pindah ke worker-health saat skala naik).
import { loadConfig } from "@smip/config";
import { ConnectorVerifyPayload, FetchRequestPayload, HealthProbePayload } from "@smip/contracts";
import { createKms } from "@smip/crypto";
import { createDb } from "@smip/db";
import { createLogger } from "@smip/observability";
import { BullMqQueue, createEnvelope } from "@smip/queue";
import { HealthMonitor, RedisReserver } from "@smip/router";
import { S3BlobStore } from "@smip/storage";
import { dbAccountLoader } from "./accounts";
import { fetchAndReport } from "./execute";
import { handleHealthProbe, handleVerify } from "./ops";
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

const ops = {
  db,
  connectors,
  accounts: deps.accounts,
  blobs,
  logger,
  monitor: new HealthMonitor(cache),
  forwardPython: (m: HealthProbePayload) =>
    queue.enqueue("fetch.py", createEnvelope({ type: "health.probe", idempotencyKey: `hp.py.${m.job_id}`, tenantId: null, payload: m })),
};

const handler = (m: { payload: FetchRequestPayload; tenant_id: string | null }, ctx: { signal: AbortSignal }) =>
  fetchAndReport(deps, queue, m.payload, m.tenant_id, ctx.signal).then(() => {});
const subs = [
  await queue.consume("fetch.bun", handler, { parse: FetchRequestPayload.parse }),
  await queue.consume("fetch.resume", handler, { parse: FetchRequestPayload.parse }),
  await queue.consume("health.probe", async (m) => void (await handleHealthProbe(ops, m.payload)), { parse: HealthProbePayload.parse }),
  await queue.consume("connector.verify", async (m) => void (await handleVerify(ops, m.payload)), { parse: ConnectorVerifyPayload.parse }),
];
logger.info("worker-fetch-bun mulai", { connectors: [...connectors.keys()] });

async function shutdown() {
  for (const s of subs) await s.close(30_000);
  await queue.close();
  cache.close();
  await close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
