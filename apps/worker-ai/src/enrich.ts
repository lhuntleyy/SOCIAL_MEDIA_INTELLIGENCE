// worker-ai (Fase 3, jalur LLM — ADR-011): ai.enrich → klasifikasi sentimen + emosi per batch (model dari panel "Pengaturan AI")
// → sink.analytics. Setiap label LLM dicatat ke `nlp_labels` (A-10) + teks terpseudonim di bucket training → korpus untuk
// melatih model sendiri kelak (AI_SPEC §14). Label emas manusia (gold set S-20) TIDAK berasal dari sini.
import type { AiEnrichPayload, PostRecord, SinkAnalyticsPayload } from "@smip/contracts";
import { type Db, withSystem } from "@smip/db";
import { buildBatchCall, type ItemLabel, isShort, PROMPT_VERSION, parseBatch, pseudonymize } from "@smip/llm";
import type { Logger } from "@smip/observability";
import type { BlobStore } from "@smip/storage";
import { sql } from "drizzle-orm";
import type { LlmRuntime } from "./runtime";

export interface EnrichDeps {
  db: Db;
  llm: Pick<LlmRuntime, "call">;
  /** posts_ref (bucket raw). */
  blobs: BlobStore;
  /** bucket training (`s3://…training…`) — teks korpus tanpa lifecycle raw (DATA_MODEL §5.10). */
  training: BlobStore;
  logger?: Logger;
  now?: () => Date;
  /** Ukuran batch per panggilan LLM bila tidak diatur di panel. */
  defaultBatch?: number;
}

/** Label bila LLM tak tersedia di percobaan terakhir: netral/unknown ber-confidence 0 — ditandai agar bisa di-reprocess (A-06). */
export const UNLABELED_VERSION = "unlabeled";

export interface EnrichResult {
  payload: SinkAnalyticsPayload;
  labeled: number;
  unlabeled: number;
  llmCalls: number;
  modelVersion: string | null;
}

export async function handleEnrich(d: EnrichDeps, ai: AiEnrichPayload, opts: { lastAttempt: boolean }): Promise<EnrichResult> {
  const now = d.now?.() ?? new Date();
  const posts = ai.items_ref ? await d.blobs.getJsonl<PostRecord>(ai.items_ref) : [];
  const byId = new Map(posts.map((p) => [`${p.platform}|${p.platform_post_id}`, p]));
  const [topic] = (await withSystem(d.db, (tx) => tx.execute(sql`select name from topics where id = ${ai.topic_id}`))) as unknown as {
    name: string;
  }[];
  const texts = ai.items.map((i) => pseudonymize(i.text ?? ""));
  const labels: (ItemLabel | null)[] = texts.map(() => null);
  let modelVersion: string | null = null;
  let calls = 0;
  const idx = texts.map((t, k) => (isShort(t) ? -1 : k)).filter((k) => k >= 0);
  try {
    let batch = d.defaultBatch ?? 20;
    for (let s = 0; s < idx.length; s += batch) {
      const part = idx.slice(s, s + batch);
      const r = await d.llm.call("sentiment", (maxTok) =>
        buildBatchCall(
          topic?.name ?? "topik",
          part.map((k) => ({ text: texts[k]! })),
          maxTok,
        ),
      );
      calls++;
      batch = r.resolved.params.batch_size ?? batch;
      modelVersion = `llm:${r.resolved.providerKey}:${r.resolved.model}:${PROMPT_VERSION}`;
      const parsed = parseBatch(r.json, part.length);
      part.forEach((k, j) => {
        labels[k] = parsed[j] ?? null;
      });
    }
  } catch (e) {
    // bukan percobaan terakhir → biarkan BullMQ mengulang (backoff); terakhir → alirkan data dengan tanda unlabeled
    if (!opts.lastAttempt) throw e;
    d.logger?.warn("LLM tidak tersedia pada percobaan terakhir — batch diteruskan tanpa label (reprocess nanti)", {
      batch_id: ai.batch_id,
      error: (e as Error).message,
    });
  }

  // korpus training: teks terpseudonim + label LLM (source=llm) — hanya item yang benar-benar dilabel model
  const labeledIdx = labels.map((l, k) => (l ? k : -1)).filter((k) => k >= 0);
  if (labeledIdx.length && modelVersion) {
    const ym = now.toISOString().slice(0, 7).replace("-", "/");
    const refs = new Map<number, string>();
    for (const k of labeledIdx) {
      const it = ai.items[k]!;
      refs.set(
        k,
        await d.training.putJsonl(`${it.platform}/${ym}/${encodeURIComponent(it.post_id)}.jsonl.gz`, [
          { text: texts[k], lang: it.lang_hint },
        ]),
      );
    }
    await withSystem(d.db, async (tx) => {
      for (const k of labeledIdx) {
        const it = ai.items[k]!;
        const l = labels[k]!;
        for (const [task, label, conf] of [
          ["sentiment", l.sentiment, l.sentiment_confidence],
          ["emotion", l.emotion, l.emotion_confidence],
        ] as const) {
          await tx.execute(sql`insert into nlp_labels (id, platform, post_id, task, text_ref, label, confidence, source, model_version)
            values (${Bun.randomUUIDv7()}, ${it.platform}, ${it.post_id}, ${task}::e_model_task, ${refs.get(k)!}, ${label}, ${conf}, 'llm', ${modelVersion})`);
        }
      }
    });
  }

  const relabel = ai.mode === "relabel";
  const payload: SinkAnalyticsPayload = {
    batch_id: ai.batch_id,
    crawl_run_id: ai.crawl_run_id,
    tenant_id: ai.tenant_id,
    topic_id: ai.topic_id,
    posts_ref: ai.items_ref!,
    ...(relabel ? { mode: "relabel" as const } : {}),
    // relabel: hanya item yang BENAR-BENAR dilabel model (jangan menimpa label lama dengan "unlabeled")
    matches: ai.items
      .flatMap((i, k) => (relabel && !labels[k] ? [] : [k]))
      .map((k) => {
        const i = ai.items[k]!;
        const p = byId.get(`${i.platform}|${i.post_id}`);
        const l = labels[k];
        const short = isShort(texts[k]!);
        return {
          platform: i.platform,
          post_id: i.post_id,
          topic_query_id: i.match.topic_query_id,
          // teks sangat pendek → neutral (AI_SPEC §2.7); tanpa label LLM → neutral/unknown confidence 0 (bukan tebakan)
          sentiment: l?.sentiment ?? "neutral",
          sentiment_score: l?.sentiment_confidence ?? 0,
          emotion: l?.emotion ?? "unknown",
          emotion_score: l?.emotion_confidence ?? 0,
          author_gender: "unknown" as const,
          author_gender_conf: 0,
          author_age_range: "unknown" as const,
          author_age_conf: 0,
          author_followers: p?.author?.followers ?? null,
          model_version: l && modelVersion ? modelVersion : short ? "rule:short-text" : UNLABELED_VERSION,
          issues: [],
          hashtags: p?.hashtags ?? [],
          parent_author_id: p?.parent?.author?.platform_user_id ?? null,
          geo_region_code: p?.geo_region_code ?? null,
          media: (p?.media ?? []).map((m) => ({ type: m.type, url: m.url, thumb: m.thumb ?? null })),
          engagement: 0,
          engagement_known: false, // sink menghitung dari metrik post
        };
      }),
    run_update: null,
  };
  const labeled = labels.filter(Boolean).length;
  return { payload, labeled, unlabeled: ai.items.length - labeled, llmCalls: calls, modelVersion };
}
