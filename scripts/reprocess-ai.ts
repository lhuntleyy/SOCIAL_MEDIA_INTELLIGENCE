// A-06 reprocess (AI_SPEC §9): label ulang match lama (stub / unlabeled / model lama) dengan model LLM aktif.
//   bun --env-file=infra/compose/.env.dev scripts/reprocess-ai.ts [--topic <uuid>] [--versions stub-0,unlabeled] [--limit 500]
// Membuat job `reprocess.ai` (batch 20 post per tenant/topik); worker-ai melabel → sink menulis koreksi sign −1/+1.
import { createClient } from "@clickhouse/client";
import { BullMqQueue, createEnvelope } from "@smip/queue";
import { S3BlobStore } from "@smip/storage";

const arg = (f: string, d?: string) => (process.argv.includes(f) ? process.argv[process.argv.indexOf(f) + 1] : d);
const versions = (arg("--versions", "stub-0,unlabeled") ?? "").split(",").filter(Boolean);
const topic = arg("--topic");
const limit = Number(arg("--limit", "500"));
const env = process.env;
const ch = createClient({
  url: env.CLICKHOUSE_URL,
  database: env.CLICKHOUSE_DB,
  username: env.CLICKHOUSE_USER,
  password: env.CLICKHOUSE_PASSWORD,
});
const rows = await ch
  .query({
    query: `SELECT m.tenant_id AS tenant_id, m.topic_id AS topic_id, m.topic_query_id AS topic_query_id, m.platform AS platform, m.post_id AS post_id,
                   p.text AS text, p.lang AS lang, p.author_id AS author_id
            FROM topic_matches AS m FINAL
            INNER JOIN (SELECT platform, post_id, text, lang, author_id FROM posts FINAL) AS p ON p.platform = m.platform AND p.post_id = m.post_id
            WHERE m.model_version IN {v:Array(String)} ${topic ? "AND m.topic_id = {topic:UUID}" : ""}
            ORDER BY m.published_at DESC LIMIT {lim:UInt32}`,
    query_params: { v: versions, lim: limit, ...(topic ? { topic } : {}) },
    format: "JSONEachRow",
  })
  .then((r) =>
    r.json<{
      tenant_id: string;
      topic_id: string;
      topic_query_id: string;
      platform: string;
      post_id: string;
      text: string;
      lang: string;
      author_id: string;
    }>(),
  );
const blobs = new S3BlobStore({
  endpoint: env.S3_ENDPOINT!,
  region: env.S3_REGION ?? "us-east-1",
  bucket: env.S3_BUCKET_RAW!,
  accessKeyId: env.S3_ACCESS_KEY_ID!,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
});
const queue = new BullMqQueue({ connection: { url: env.REDIS_URL! } });
const groups = new Map<string, typeof rows>();
for (const r of rows) groups.set(`${r.tenant_id}|${r.topic_id}`, [...(groups.get(`${r.tenant_id}|${r.topic_id}`) ?? []), r]);
let jobs = 0;
for (const [, g] of groups) {
  for (let i = 0; i < g.length; i += 20) {
    const part = g.slice(i, i + 20);
    const batchId = Bun.randomUUIDv7();
    const ref = await blobs.putJsonl(
      `reprocess/${batchId}.jsonl.gz`,
      part.map((p) => ({ platform: p.platform, platform_post_id: p.post_id, text: p.text })),
    );
    await queue.enqueue(
      "reprocess.ai",
      createEnvelope({
        type: "reprocess.ai",
        idempotencyKey: `reprocess.${batchId}`,
        tenantId: part[0]!.tenant_id,
        payload: {
          batch_id: batchId,
          crawl_run_id: "00000000-0000-0000-0000-000000000000", // relabel tidak menyentuh counter run
          tenant_id: part[0]!.tenant_id,
          topic_id: part[0]!.topic_id,
          priority_class: "backfill",
          mode: "relabel",
          items: part.map((p) => ({
            platform: p.platform,
            post_id: p.post_id,
            text: p.text,
            lang_hint: p.lang || null,
            is_new_post: false,
            author: { platform_user_id: p.author_id || "unknown", display_name: null, created_at: null },
            match: { topic_query_id: p.topic_query_id },
          })),
          items_ref: ref,
          models: {},
        },
      }),
    );
    jobs++;
  }
}
console.log(JSON.stringify({ matches: rows.length, topics: groups.size, jobs }));
await queue.close();
await ch.close();
