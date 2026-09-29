// Service `worker-ai` (Fase 3, jalur LLM — ADR-011): consume ai.enrich & reprocess.ai (A-06) → sink.analytics. Model & API key dari panel admin.
import { loadConfig } from "@smip/config";
import { HttpClient } from "@smip/connector-sdk";
import { AiEnrichPayload } from "@smip/contracts";
import { createKms } from "@smip/crypto";
import { createDb } from "@smip/db";
import { createLogger } from "@smip/observability";
import { BullMqQueue, createEnvelope, QUEUE_POLICIES } from "@smip/queue";
import { S3BlobStore } from "@smip/storage";
import { handleEnrich } from "./enrich";
import { LlmRuntime } from "./runtime";

const cfg = loadConfig("worker-ai");
const logger = createLogger({ service: "worker-ai", version: cfg.SERVICE_VERSION, env: cfg.NODE_ENV, level: cfg.LOG_LEVEL });
const { db, close } = createDb(cfg.DATABASE_URL, { max: 2 });
const queue = new BullMqQueue({ connection: { url: cfg.REDIS_URL }, logger });
const s3 = (bucket: string) =>
  new S3BlobStore({
    endpoint: cfg.S3_ENDPOINT!,
    region: cfg.S3_REGION,
    bucket,
    accessKeyId: cfg.S3_ACCESS_KEY_ID!,
    secretAccessKey: cfg.S3_SECRET_ACCESS_KEY!,
  });
const llm = new LlmRuntime({ db, kms: createKms(cfg), http: new HttpClient({ timeoutMs: 90_000 }), logger });
const deps = { db, llm, blobs: s3(cfg.S3_BUCKET_RAW!), training: s3(cfg.S3_BUCKET_TRAINING!), logger };

const handler = (queueName: "ai.enrich" | "reprocess.ai") => async (m: { payload: AiEnrichPayload }, ctx: { attempt: number }) => {
  const r = await handleEnrich(deps, m.payload, { lastAttempt: ctx.attempt >= QUEUE_POLICIES[queueName].attempts });
  if (m.payload.mode === "relabel" && !r.payload.matches.length) return; // relabel tanpa hasil → tidak ada yang ditulis
  await queue.enqueue(
    "sink.analytics",
    createEnvelope({
      type: "sink.analytics",
      idempotencyKey: `sink.${r.payload.batch_id}`,
      tenantId: r.payload.tenant_id,
      payload: r.payload,
    }),
  );
  logger.info("enrich", {
    queue: queueName,
    batch_id: m.payload.batch_id,
    items: m.payload.items.length,
    labeled: r.labeled,
    llm_calls: r.llmCalls,
    model: r.modelVersion,
  });
};
// concurrency 1: hormati RPM tier gratis; naikkan bila kuota berbayar. reprocess.ai prioritas terendah (antrean terpisah).
const subs = [
  await queue.consume("ai.enrich", handler("ai.enrich"), { parse: AiEnrichPayload.parse, concurrency: 1 }),
  await queue.consume("reprocess.ai", handler("reprocess.ai"), { parse: AiEnrichPayload.parse, concurrency: 1 }),
];
logger.info("worker-ai mulai (jalur LLM)");
const shutdown = async () => {
  for (const sub of subs) await sub.close(30_000);
  await queue.close();
  await close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
