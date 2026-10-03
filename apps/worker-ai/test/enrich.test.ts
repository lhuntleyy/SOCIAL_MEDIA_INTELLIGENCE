// Fase 3 (A-03 + A-10): worker-ai jalur LLM — pengaturan dari DB (provider, multi key, tugas), batch 1 panggilan,
// label → sink.analytics, korpus nlp_labels + teks terpseudonim di bucket training; 429 → key lain; gagal di percobaan
// terakhir → diteruskan "unlabeled" (bukan tebakan). HTTP LLM di-MOCK.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HttpClient } from "@smip/connector-sdk";
import { credentialAad, LocalDevKms, seal } from "@smip/crypto";
import { createDb, up } from "@smip/db";
import { demographicsDecision, parseBatch, pseudonymize } from "@smip/llm";
import { MemoryBlobStore } from "@smip/storage";
import postgres from "postgres";
import { handleEnrich, LlmRuntime, UNLABELED_VERSION } from "../src";
import { type AuthorDemo, type DemographicsStore, type DemoRow, demoKey } from "../src/demographics";

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
        {
          i: 2,
          sentiment: "negative",
          sentiment_confidence: 1.4,
          emotion: "anger",
          emotion_confidence: 0.8,
          issues: ["Kampus Negeri!", "#UtangKopdes", "kampus negeri", "a", "satu dua tiga empat lima", "pegawai bumn", "gaji"],
        },
        { i: 1, sentiment: "angry", emotion: "joy" },
        { i: 9, sentiment: "neutral", emotion: "unknown" },
      ],
    },
    2,
  );
  // isu dibersihkan: huruf kecil, tanpa tanda baca/#, unik, 1–4 kata, maks 3
  expect(r).toEqual([
    null,
    {
      sentiment: "negative",
      sentiment_confidence: 1,
      emotion: "anger",
      emotion_confidence: 0.8,
      issues: ["kampus negeri", "utangkopdes", "pegawai bumn"],
    },
  ]);
  expect(pseudonymize("@budi cek https://x.co/a 08123456789 2026")).toBe("<user> cek <url> <num> 2026");
});

test("demografi: di bawah ambang → unknown; below_18 tidak pernah disimpan per akun (ADR-007)", () => {
  expect(demographicsDecision({ gender: "female", gender_confidence: 0.9, age_range: "22_30", age_confidence: 0.8 })).toMatchObject({
    gender: "female",
    age_range: "22_30",
    minorSuppressed: false,
  });
  expect(demographicsDecision({ gender: "male", gender_confidence: 0.5, age_range: "31_45", age_confidence: 0.4 })).toMatchObject({
    gender: "unknown",
    age_range: "unknown",
  });
  expect(demographicsDecision({ gender: "male", gender_confidence: 0.95, age_range: "below_18", age_confidence: 0.99 })).toEqual({
    gender: "male",
    gender_conf: 0.95,
    age_range: "unknown",
    age_conf: 0,
    minorSuppressed: true,
  });
  expect(demographicsDecision(null).gender).toBe("unknown");
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
    expect([r.labeled, r.llmCalls, r.modelVersion]).toEqual([2, 1, "llm:gemini:gemini-3.5-flash-lite:sent-emo-iss-v2"]);
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

  test("A-08/A-09: gender/usia per akun → payload sink (agregat); cache dipakai ulang; anak disensor; LLM demografi gagal → unknown", async () => {
    const store = new Map<string, AuthorDemo>();
    const saved: DemoRow[] = [];
    const demographics: DemographicsStore = {
      get: async (keys) =>
        new Map(
          keys.flatMap((k) =>
            store.has(demoKey(k.platform, k.authorId))
              ? [[demoKey(k.platform, k.authorId), store.get(demoKey(k.platform, k.authorId))!]]
              : [],
          ),
        ),
      put: async (rows) => {
        for (const r of rows) {
          saved.push(r);
          store.set(demoKey(r.platform, r.author_id), r);
        }
      },
    };
    let demoCalls = 0;
    let demoFail = false;
    const llm = {
      call: async (task: string, build: (n: number) => { system: string; user: string }) => {
        const c = build(4096);
        const n = (c.user.match(/^\[\d+\]/gm) ?? []).length;
        const resolved = { providerKey: "fake", model: "m1", params: {} };
        if (c.system.includes("statistik AGREGAT")) {
          demoCalls++;
          if (demoFail) throw new Error("kuota habis");
          // urutan akun mengikuti urutan post: a1 Budi (yakin), a2 anak (disensor), a3 ragu
          const ans = [
            { gender: "male", gender_confidence: 0.95, age_range: "31_45", age_confidence: 0.8 },
            { gender: "female", gender_confidence: 0.9, age_range: "below_18", age_confidence: 0.9 },
            { gender: "female", gender_confidence: 0.4, age_range: "22_30", age_confidence: 0.3 },
          ];
          return { json: { results: ans.slice(0, n).map((a, k) => ({ i: k + 1, ...a })) }, resolved } as never;
        }
        expect(task).toBe("sentiment");
        return {
          json: {
            results: Array.from({ length: n }, (_, k) => ({
              i: k + 1,
              sentiment: "neutral",
              sentiment_confidence: 0.9,
              emotion: "unknown",
              emotion_confidence: 0.5,
              issues: [],
            })),
          },
          resolved,
        } as never;
      },
    };
    const mk = async (authors: { id: string; name: string }[]) => {
      const posts = authors.map((a, k) => ({
        platform: "x",
        platform_post_id: `d${a.id}${k}${Date.now()}`,
        text: "kopdes di desa kami sudah berjalan dengan baik sekali",
        author: { platform_user_id: a.id, handle: a.id, display_name: a.name, created_at: null, followers: null },
        hashtags: [],
        media: [],
        parent: null,
        geo_region_code: null,
      }));
      const ref = await blobs.putJsonl(`posts/demo-${Date.now()}.jsonl.gz`, posts);
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
          author: { platform_user_id: p.author.platform_user_id, display_name: p.author.display_name, created_at: null },
          match: { topic_query_id: Q },
        })),
        items_ref: ref,
        models: {},
      };
    };
    const d = { db: created.db, llm, blobs, training, demographics };
    const r1 = await handleEnrich(
      d,
      await mk([
        { id: "a1", name: "Budi Santoso" },
        { id: "a2", name: "Adik" },
        { id: "a3", name: "Kiki" },
      ]),
      {
        lastAttempt: false,
      },
    );
    expect(r1.payload.matches.map((m) => [m.author_gender, m.author_age_range])).toEqual([
      ["male", "31_45"],
      ["female", "unknown"], // below_18 → unknown
      ["unknown", "unknown"], // di bawah ambang
    ]);
    expect(saved.map((x) => [x.author_id, x.method, x.age_range])).toEqual([
      ["a1", "llm", "31_45"],
      ["a2", "minor_suppressed", "unknown"],
      ["a3", "llm", "unknown"],
    ]);
    expect(saved.every((x) => x.model_version === "llm:fake:m1:demo-v1")).toBe(true);
    // akun yang sama lagi → dari cache, tanpa panggilan LLM demografi
    const r2 = await handleEnrich(d, await mk([{ id: "a1", name: "Budi Santoso" }]), { lastAttempt: false });
    expect([demoCalls, r2.payload.matches[0]!.author_gender]).toEqual([1, "male"]);
    // LLM demografi gagal → akun baru unknown, batch sentimen tetap jalan
    demoFail = true;
    const r3 = await handleEnrich(d, await mk([{ id: "a9", name: "Rina" }]), { lastAttempt: false });
    expect([r3.labeled, r3.payload.matches[0]!.author_gender]).toEqual([1, "unknown"]);
    // fitur dimatikan di Pengaturan → tidak memanggil LLM demografi sama sekali
    await sql`insert into system_settings (key, value) values ('demographics.enabled', 'false')`;
    demoFail = false;
    const before = demoCalls;
    await handleEnrich(d, await mk([{ id: "a10", name: "Agus" }]), { lastAttempt: false });
    expect(demoCalls).toBe(before);
  });
});
