// Fase 3 (A-03 + A-10): worker-ai jalur LLM — pengaturan dari DB (provider, multi key, tugas), batch 1 panggilan,
// label → sink.analytics, korpus nlp_labels + teks terpseudonim di bucket training; 429 → key lain; gagal di percobaan
// terakhir → diteruskan "unlabeled" (bukan tebakan). HTTP LLM di-MOCK.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HttpClient } from "@smip/connector-sdk";
import { credentialAad, LocalDevKms, seal } from "@smip/crypto";
import { createDb, up } from "@smip/db";
import { parseBatch, pseudonymize } from "@smip/llm";
import { MemoryBlobStore } from "@smip/storage";
import postgres from "postgres";
import { handleEnrich, LlmRuntime, UNLABELED_VERSION } from "../src";

const PG = process.env.TEST_PG_URL ?? "postgres://smip_owner:smip_owner_dev@127.0.0.1:55432/postgres";
const pgUp = await (async () => {
  try {
    const s = postgres(PG, { connect_timeout: 2, onnotice: () => {} });
    await s`select 1`;
    await s.end();
    return true;
  } catch {
    return false;
  }
})();
const id = (n: number) => `0192f000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const [T, TOPIC, Q, RUN, PROV, K1, K2, C1, C2] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => id(0x700 + n)) as [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

test("parseBatch: indeks 1-based, label tak dikenal / duplikat / di luar rentang diabaikan; pseudonimisasi", () => {
  const r = parseBatch(
    {
      results: [
        { i: 2, sentiment: "negative", sentiment_confidence: 1.4, emotion: "anger", emotion_confidence: 0.8 },
        { i: 1, sentiment: "angry", emotion: "joy" },
        { i: 9, sentiment: "neutral", emotion: "unknown" },
      ],
    },
    2,
  );
  expect(r).toEqual([null, { sentiment: "negative", sentiment_confidence: 1, emotion: "anger", emotion_confidence: 0.8 }]);
  expect(pseudonymize("@budi cek https://x.co/a 08123456789 2026")).toBe("<user> cek <url> <num> 2026");
});

describe.skipIf(!pgUp)("worker-ai jalur LLM (integrasi)", () => {
  const name = `smip_ai_${Date.now()}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  let created: ReturnType<typeof createDb>;
  const kms = new LocalDevKms({ v1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64") });
  const blobs = new MemoryBlobStore();
  // meniru bucket training S3 (CHECK DB: text_ref LIKE 's3://%training%')
  const mem = new MemoryBlobStore();
  const training = {
    putJsonl: async (k: string, rows: unknown[]) => (await mem.putJsonl(k, rows)).replace("mem://", "s3://smip-training/"),
    getJsonl: <T>(ref: string) => mem.getJsonl<T>(ref.replace("s3://smip-training/", "mem://")),
    delete: (ref: string) => mem.delete(ref.replace("s3://smip-training/", "mem://")),
  };
  let mode: "ok" | "429-first" | "down" = "ok";
  const used: string[] = [];
  let first429: string | null = null;
  const json = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
  const http = new HttpClient({
    resolver: async () => ["142.250.4.95"],
    timeoutMs: 2000,
    fetchImpl: async (_u, init) => {
      const key = ((init?.headers ?? {}) as Record<string, string>)["x-goog-api-key"]!;
      used.push(key);
      if (mode === "down") return json(503, { error: { message: "overloaded" } });
      // key yang dipakai PERTAMA di mode ini kena 429 (round-robin bisa mulai dari key mana pun)
      if (mode === "429-first" && (first429 === null || first429 === key)) {
        first429 = key;
        return json(429, { error: { status: "RESOURCE_EXHAUSTED" } });
      }
      const body = JSON.parse(String(init?.body)) as { contents: { parts: { text: string }[] }[] };
      const n = (body.contents[0]!.parts[0]!.text.match(/^\[\d+\]/gm) ?? []).length;
      const results = Array.from({ length: n }, (_, k) => ({
        i: k + 1,
        sentiment: k === 0 ? "negative" : "positive",
        sentiment_confidence: 0.9,
        emotion: k === 0 ? "anger" : "joy",
        emotion_confidence: 0.7,
      }));
      return json(200, {
        candidates: [{ content: { parts: [{ text: JSON.stringify({ results }) }] } }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 40 },
      });
    },
  });
  let runtime: LlmRuntime;
  const deps = () => ({ db: created.db, llm: runtime, blobs, training });
  const payload = async () => {
    const posts = [
      {
        platform: "x",
        platform_post_id: "p1",
        text: "hebat banget @budi, gaji pengurus kopdes belum cair 👏",
        author: { followers: 10 },
        hashtags: ["kopdes"],
        media: [],
        parent: null,
        geo_region_code: null,
      },
      {
        platform: "x",
        platform_post_id: "p2",
        text: "alhamdulillah kopdes di desa kami sudah jalan dan warga terbantu",
        author: { followers: 5 },
        hashtags: [],
        media: [],
        parent: null,
        geo_region_code: "ID-JB",
      },
      {
        platform: "x",
        platform_post_id: "p3",
        text: "ok",
        author: { followers: null },
        hashtags: [],
        media: [],
        parent: null,
        geo_region_code: null,
      },
    ];
    const ref = await blobs.putJsonl(`posts/${Date.now()}.jsonl.gz`, posts);
    return {
      batch_id: Bun.randomUUIDv7(),
      crawl_run_id: RUN,
      tenant_id: T,
      topic_id: TOPIC,
      priority_class: "realtime" as const,
      items: posts.map((p) => ({
        platform: "x",
        post_id: p.platform_post_id,
        text: p.text,
        lang_hint: "id",
        is_new_post: true,
        author: { platform_user_id: "u", display_name: null, created_at: null },
        match: { topic_query_id: Q },
      })),
      items_ref: ref,
      models: {},
    };
  };

  beforeAll(async () => {
    admin = postgres(PG, { onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const url = PG.replace(/\/[^/]*$/, `/${name}`);
    sql = postgres(url, { onnotice: () => {} });
    await up(sql);
    await sql`insert into tenants (id, slug, name) values (${T}, 't', 'T')`;
    await sql`insert into topics (id, tenant_id, name) values (${TOPIC}, ${T}, 'Koperasi Desa Merah Putih')`;
    await sql`insert into llm_providers (id, key, name, kind) values (${PROV}, 'gemini', 'Gemini', 'gemini')`;
    for (const [k, c, secret] of [
      [K1, C1, "AIzaKEY-SATU-0000000000"],
      [K2, C2, "AIzaKEY-DUA-00000000000"],
    ] as const) {
      const s = await seal(kms, credentialAad(c, null), { api_key: secret });
      await sql`insert into credentials (id, kind, ciphertext, iv, wrapped_dek, kek_id, aad, fingerprint) values (${c}, 'api_key', ${Buffer.from(s.ciphertext)}, ${Buffer.from(s.iv)}, ${Buffer.from(s.wrapped_dek)}, ${s.kek_id}, ${s.aad}, ${Buffer.from(c)})`;
      await sql`insert into llm_api_keys (id, provider_id, label, credential_id) values (${k}, ${PROV}, ${k.slice(-2)}, ${c})`;
    }
    await sql`insert into llm_task_settings (task, provider_id, model_id, enabled, params) values ('default', ${PROV}, 'gemini-3.5-flash-lite', true, '{"batch_size": 10}')`;
    created = createDb(url, { max: 2 });
    runtime = new LlmRuntime({ db: created.db, kms, http, ttlMs: 0 });
  });
  afterAll(async () => {
    await created?.close();
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin?.end();
  });

  test("label nyata ke sink + korpus nlp_labels (teks terpseudonim di bucket training); teks pendek → aturan, tanpa LLM", async () => {
    const r = await handleEnrich(deps(), await payload(), { lastAttempt: false });
    expect([r.labeled, r.llmCalls, r.modelVersion]).toEqual([2, 1, "llm:gemini:gemini-3.5-flash-lite:sent-emo-v1"]);
    expect(r.payload.matches.map((m) => [m.post_id, m.sentiment, m.emotion, m.model_version])).toEqual([
      ["p1", "negative", "anger", r.modelVersion!],
      ["p2", "positive", "joy", r.modelVersion!],
      ["p3", "neutral", "unknown", "rule:short-text"],
    ]);
    const rows = await sql`select post_id, task, label, source, text_ref from nlp_labels order by post_id, task::text`;
    expect(rows.map((x) => [x.post_id, x.task, x.label, x.source])).toEqual([
      ["p1", "emotion", "anger", "llm"],
      ["p1", "sentiment", "negative", "llm"],
      ["p2", "emotion", "joy", "llm"],
      ["p2", "sentiment", "positive", "llm"],
    ]);
    expect(rows[0]!.text_ref).toStartWith("s3://smip-training/x/");
    const [t] = await training.getJsonl<{ text: string }>(rows[0]!.text_ref);
    expect(t!.text).toBe("hebat banget <user>, gaji pengurus kopdes belum cair 👏"); // mention tak pernah masuk korpus/LLM
  });

  test("429 di key pertama → key kedua dipakai & key pertama dijeda; provider down: retry, percobaan terakhir → unlabeled", async () => {
    mode = "429-first";
    used.length = 0;
    const r = await handleEnrich(deps(), await payload(), { lastAttempt: false });
    expect(r.labeled).toBe(2);
    expect(new Set(used).size).toBe(2);
    const [k1] =
      await sql`select last_error_code, cooldown_until is not null as cd from llm_api_keys where id = ${first429 === "AIzaKEY-SATU-0000000000" ? K1 : K2}`;
    expect(k1).toEqual({ last_error_code: "RATE_LIMITED", cd: true });
    mode = "down";
    await expect(handleEnrich(deps(), await payload(), { lastAttempt: false })).rejects.toBeDefined();
    const last = await handleEnrich(deps(), await payload(), { lastAttempt: true });
    expect(last.payload.matches.slice(0, 2).map((m) => [m.sentiment, m.sentiment_score, m.model_version])).toEqual([
      ["neutral", 0, UNLABELED_VERSION],
      ["neutral", 0, UNLABELED_VERSION],
    ]);
    mode = "ok";
  });
});
