// I-14 worker-pipeline (ARCHITECTURE §4, QUEUE_SPEC §4.4): batch item canonical → filter iklan → matcher lokal AST
// (sumber kebenaran semantik; P-04, P-12) → dedupe konten & match (Redis) → geo gazetteer →
//   post cocok & match baru  → ai.enrich (≤ 64 item/batch, posts_ref berisi baris post)
//   post baru tak cocok      → sink.analytics langsung (matches = []) — disimpan untuk backfill, tanpa AI (P-17)
// Counter run: pending_batches −1 (pesan ini) + N (batch anak); run ditutup bila tak ada lagi yang tertunda.
import type { CanonicalItem, PipelineItemsPayload, PostRecord } from "@smip/contracts";
import { claimMessage, type Db, finalizeRunIfDone, type Tx, withSystem, writeJobOutbox } from "@smip/db";
import type { Gazetteer } from "@smip/geo";
import type { Logger } from "@smip/observability";
import { type CompiledQuery, matchQuery, type QueryAst } from "@smip/query";
import type { BlobStore } from "@smip/storage";
import { sql } from "drizzle-orm";
import { type Deduper, seenKey, seenMatchKey } from "./dedupe";

export interface PipelineDeps {
  db: Db;
  blobs: BlobStore;
  dedupe: Deduper;
  gazetteer: () => Promise<Gazetteer>;
  logger?: Logger;
  now?: () => Date;
  aiBatchSize?: number;
}

export interface PipelineResult {
  received: number;
  matched: number;
  newPosts: number;
  duplicateMatches: number;
  ads: number;
  aiBatches: number;
  unmatchedBatch: boolean;
  finalized: "succeeded" | "partial" | null;
  duplicateMessage?: boolean;
}

/** Model AI yang diminta per item (AI_SPEC §1); flag per tenant (psikografi) menyusul bersama worker-ai. */
const MODELS = { sentiment: "active", emotion: "active", keyphrase: "active", lang: "active" };

async function loadQuery(tx: Tx, queryId: string) {
  const [q] = (await tx.execute(sql`select q.query_ast, q.languages, q.media_tags, q.not_media_tags, q.enabled,
      t.filter_ads, t.language_hints, t.status as topic_status
    from topic_queries q join topics t on t.id = q.topic_id where q.id = ${queryId}`)) as unknown as {
    query_ast: QueryAst;
    languages: string[] | null;
    media_tags: string[] | null;
    not_media_tags: string[] | null;
    enabled: boolean;
    filter_ads: boolean;
    language_hints: string[];
    topic_status: string;
  }[];
  return q;
}

export async function handlePipelineItems(d: PipelineDeps, m: PipelineItemsPayload): Promise<PipelineResult> {
  const now = d.now?.() ?? new Date();
  const batchSize = d.aiBatchSize ?? 64;
  const owner = `${m.crawl_run_id}.${m.attempt_no}`;
  const res: PipelineResult = {
    received: 0,
    matched: 0,
    newPosts: 0,
    duplicateMatches: 0,
    ads: 0,
    aiBatches: 0,
    unmatchedBatch: false,
    finalized: null,
  };
  const items = await d.blobs.getJsonl<CanonicalItem>(m.items_ref);
  res.received = items.length;
  const gaz = await d.gazetteer();

  return withSystem(d.db, async (tx) => {
    const [run] = (await tx.execute(sql`select kind, status from crawl_runs where id = ${m.crawl_run_id} for update`)) as unknown as {
      kind: string;
      status: string;
    }[];
    if (!run) return res;
    // terkirim ulang setelah commit → efek (counter, batch anak) sudah ada; jangan diulang
    if (!(await claimMessage(tx, `pipe.${m.crawl_run_id}.${m.attempt_no}`))) {
      res.duplicateMessage = true;
      return res;
    }
    const q = m.topic_query_id ? await loadQuery(tx, m.topic_query_id) : undefined;
    // query/topik dihapus/diarsipkan setelah fetch: item tetap disimpan sebagai post tak-match
    const active = !!q && q.enabled && q.topic_status !== "archived";
    const compiled: CompiledQuery | null = active
      ? {
          ast: q.query_ast,
          languages: q.languages ?? (q.language_hints?.length ? q.language_hints : null),
          mediaTags: q.media_tags ?? [],
          notMediaTags: q.not_media_tags ?? [],
        }
      : null;

    const newContent = await d.dedupe.claim(
      items.map((i) => seenKey(i.platform, i.platform_post_id)),
      owner,
    );
    const decisions = items.map((i) => {
      const isAd = active && q!.filter_ads && i.is_ad === true; // FR-I07: is_ad null = tidak diketahui → tidak disaring
      if (isAd) res.ads++;
      const ok = !!compiled && !isAd && matchQuery(compiled, { text: i.text ?? "", hashtags: i.hashtags, lang: i.lang_hint }).match;
      return ok;
    });
    const matchedIdx = items.map((_, k) => k).filter((k) => decisions[k]);
    const newMatch = await d.dedupe.claim(
      matchedIdx.map((k) => seenMatchKey(m.tenant_id ?? "-", m.topic_id ?? "-", items[k]!.platform, items[k]!.platform_post_id)),
      owner,
    );

    const toRecord = (i: CanonicalItem, matched: boolean): PostRecord => {
      const g = gaz.infer({ placeName: i.geo?.place_name, locationRaw: i.author?.location_raw });
      return { ...i, geo_region_code: g?.code ?? null, geo_confidence: g?.confidence ?? null, matched };
    };
    const aiItems: { rec: PostRecord; isNew: boolean }[] = [];
    const unmatched: PostRecord[] = [];
    items.forEach((i, k) => {
      if (newContent[k]) res.newPosts++;
      if (decisions[k]) {
        const pos = matchedIdx.indexOf(k);
        if (newMatch[pos]) aiItems.push({ rec: toRecord(i, true), isNew: newContent[k]! });
        else res.duplicateMatches++;
      } else if (newContent[k]) {
        unmatched.push(toRecord(i, false));
      }
    });
    res.matched = aiItems.length;

    const base = `posts/${m.crawl_run_id}/${m.attempt_no}`;
    const priority = run.kind === "backfill" ? "backfill" : "realtime";
    for (let b = 0; b * batchSize < aiItems.length; b++) {
      const chunk = aiItems.slice(b * batchSize, (b + 1) * batchSize);
      const batchId = Bun.randomUUIDv7();
      const postsRef = await d.blobs.putJsonl(
        `${base}/m${b}.jsonl.gz`,
        chunk.map((c) => c.rec),
      );
      await writeJobOutbox(tx, m.crawl_run_id, {
        queue: "ai.enrich",
        idempotencyKey: `ai.${m.crawl_run_id}.${m.attempt_no}.${b}`,
        type: "ai.enrich",
        tenantId: m.tenant_id,
        payload: {
          batch_id: batchId,
          crawl_run_id: m.crawl_run_id,
          tenant_id: m.tenant_id,
          topic_id: m.topic_id,
          priority_class: priority,
          items: chunk.map(({ rec, isNew }) => ({
            platform: rec.platform,
            post_id: rec.platform_post_id,
            text: rec.text ?? "",
            lang_hint: rec.lang_hint,
            is_new_post: isNew,
            author: {
              platform_user_id: rec.author.platform_user_id,
              display_name: rec.author.display_name,
              created_at: rec.author.created_at,
            },
            match: { topic_query_id: m.topic_query_id },
          })),
          items_ref: postsRef,
          models: MODELS,
        },
      });
      res.aiBatches++;
    }
    if (unmatched.length) {
      const postsRef = await d.blobs.putJsonl(`${base}/u.jsonl.gz`, unmatched);
      await writeJobOutbox(tx, m.crawl_run_id, {
        queue: "sink.analytics",
        idempotencyKey: `sink.${m.crawl_run_id}.${m.attempt_no}.u`,
        type: "sink.analytics",
        tenantId: null,
        payload: {
          batch_id: Bun.randomUUIDv7(),
          crawl_run_id: m.crawl_run_id,
          tenant_id: null,
          topic_id: null,
          posts_ref: postsRef,
          matches: [],
          run_update: null,
        },
      });
      res.unmatchedBatch = true;
    }

    const times = items.map((i) => Date.parse(i.published_at)).filter((t) => !Number.isNaN(t));
    const minP = times.length ? new Date(Math.min(...times)).toISOString() : null;
    const maxP = times.length ? new Date(Math.max(...times)).toISOString() : null;
    const children = res.aiBatches + (res.unmatchedBatch ? 1 : 0);
    await tx.execute(sql`update crawl_runs set
        pending_batches = greatest(0, pending_batches - 1 + ${children}),
        items_matched = items_matched + ${res.matched},
        items_new = items_new + ${res.newPosts},
        min_published_at = least(coalesce(min_published_at, ${minP}::timestamptz), ${minP}::timestamptz),
        max_published_at = greatest(coalesce(max_published_at, ${maxP}::timestamptz), ${maxP}::timestamptz)
      where id = ${m.crawl_run_id}`);
    const fin = await finalizeRunIfDone(tx, m.crawl_run_id, now);
    res.finalized = fin?.outcome ?? null;
    d.logger?.info("pipeline", { crawl_run_id: m.crawl_run_id, ...res });
    return res;
  });
}

/** Loader gazetteer ber-cache (refresh berkala; alias bisa ditambah operator di DB tanpa deploy). */
export function cachedGazetteer(load: () => Promise<Gazetteer>, ttlMs = 10 * 60_000): () => Promise<Gazetteer> {
  let cur: { g: Gazetteer; at: number } | null = null;
  return async () => {
    if (!cur || Date.now() - cur.at > ttlMs) cur = { g: await load(), at: Date.now() };
    return cur.g;
  };
}
