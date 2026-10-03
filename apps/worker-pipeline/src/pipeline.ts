// I-14 worker-pipeline (ARCHITECTURE §4, QUEUE_SPEC §4.4): batch item canonical → filter iklan → matcher lokal AST
// (sumber kebenaran semantik; P-04, P-12) → dedupe konten & match (Redis) → geo gazetteer →
//   post cocok & match baru  → ai.enrich (≤ 64 item/batch, posts_ref berisi baris post)
//   post baru tak cocok      → sink.analytics langsung (matches = []) — disimpan untuk backfill, tanpa AI (P-17)
// Counter run: pending_batches −1 (pesan ini) + N (batch anak); run ditutup bila tak ada lagi yang tertunda.
// Mode collection stream (I-22, ADR-009): item dicocokkan ke SEMUA query anggota stream (inverted index) → batch AI
// per (tenant, topik); satu fetch melayani banyak topik lintas tenant.
import type { CanonicalItem, PipelineItemsPayload, PostRecord } from "@smip/contracts";
import { addTenantMatches, claimMessage, type Db, finalizeRunIfDone, type Tx, withSystem, writeJobOutbox } from "@smip/db";
import type { Gazetteer } from "@smip/geo";
import type { Logger } from "@smip/observability";
import { type CompiledQuery, type QueryAst, QueryIndex } from "@smip/query";
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

/** Pelanggan hasil: query aktif yang item-nya dicocokkan (satu untuk plan, banyak untuk stream). */
interface Subscriber {
  id: string; // topic_query_id
  tenantId: string;
  topicId: string;
  query: CompiledQuery;
  filterAds: boolean;
}
type QueryRow = {
  id: string;
  tenant_id: string;
  topic_id: string;
  query_ast: QueryAst;
  languages: string[] | null;
  media_tags: string[] | null;
  not_media_tags: string[] | null;
  filter_ads: boolean;
  language_hints: string[];
};

/** Query aktif (topik belum diarsipkan): per id (plan) atau semua anggota stream. Query/topik tak aktif → item jadi tak-match. */
async function loadSubscribers(tx: Tx, m: PipelineItemsPayload): Promise<Subscriber[]> {
  const where = m.collection_stream_id
    ? sql`q.id in (select topic_query_id from stream_topic_links where stream_id = ${m.collection_stream_id})`
    : m.topic_query_id
      ? sql`q.id = ${m.topic_query_id}`
      : null;
  if (!where) return [];
  const rows = (await tx.execute(sql`select q.id, q.tenant_id, q.topic_id, q.query_ast, q.languages, q.media_tags, q.not_media_tags,
      t.filter_ads, t.language_hints
    from topic_queries q join topics t on t.id = q.topic_id
    where ${where} and q.enabled and t.status <> 'archived' and t.deleted_at is null`)) as unknown as QueryRow[];
  return rows.map((q) => ({
    id: q.id,
    tenantId: q.tenant_id,
    topicId: q.topic_id,
    filterAds: q.filter_ads,
    query: {
      ast: q.query_ast,
      languages: q.languages ?? (q.language_hints?.length ? q.language_hints : null),
      mediaTags: q.media_tags ?? [],
      notMediaTags: q.not_media_tags ?? [],
    },
  }));
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
    if (!(await claimMessage(tx, `pipe.${m.crawl_run_id}.${m.attempt_no}${m.part ? `.${m.part}` : ""}`))) {
      res.duplicateMessage = true;
      return res;
    }
    const subs = await loadSubscribers(tx, m);
    const index = new QueryIndex(subs);

    const newContent = await d.dedupe.claim(
      items.map((i) => seenKey(i.platform, i.platform_post_id)),
      owner,
    );
    // per item: satu match per (tenant, topik) — query pertama yang cocok mewakili topik (seenm per topik)
    const hits = items.map((i) => {
      // komentar dari post teratas topik: relevan karena konteks post induk walau tidak menyebut keyword → ikut topik pemilik run
      const matched =
        run.kind === "comments"
          ? subs
          : index.match({ text: i.text ?? "", hashtags: i.hashtags, lang: i.lang_hint, author: i.author?.handle });
      const perTopic = new Map<string, Subscriber>();
      for (const sub of matched) {
        if (sub.filterAds && i.is_ad === true) {
          res.ads++; // FR-I07: is_ad null = tidak diketahui → tidak disaring
          continue;
        }
        if (!perTopic.has(`${sub.tenantId}|${sub.topicId}`)) perTopic.set(`${sub.tenantId}|${sub.topicId}`, sub);
      }
      return [...perTopic.values()];
    });
    const pairs = hits.flatMap((subsOfItem, k) => subsOfItem.map((sub) => ({ k, sub })));
    const newMatch = await d.dedupe.claim(
      pairs.map(({ k, sub }) => seenMatchKey(sub.tenantId, sub.topicId, items[k]!.platform, items[k]!.platform_post_id)),
      owner,
    );

    const toRecord = (i: CanonicalItem, matched: boolean): PostRecord => {
      const g = gaz.infer({ placeName: i.geo?.place_name, locationRaw: i.author?.location_raw });
      return { ...i, geo_region_code: g?.code ?? null, geo_confidence: g?.confidence ?? null, matched };
    };
    const groups = new Map<string, { tenantId: string; topicId: string; items: { rec: PostRecord; isNew: boolean; queryId: string }[] }>();
    const unmatched: PostRecord[] = [];
    const records = new Map<number, PostRecord>();
    pairs.forEach(({ k, sub }, j) => {
      if (!newMatch[j]) {
        res.duplicateMatches++;
        return;
      }
      const key = `${sub.tenantId}|${sub.topicId}`;
      if (!groups.has(key)) groups.set(key, { tenantId: sub.tenantId, topicId: sub.topicId, items: [] });
      if (!records.has(k)) records.set(k, toRecord(items[k]!, true));
      groups.get(key)!.items.push({ rec: records.get(k)!, isNew: newContent[k]!, queryId: sub.id });
      res.matched++;
    });
    items.forEach((i, k) => {
      if (newContent[k]) res.newPosts++;
      if (!hits[k]!.length && newContent[k]) unmatched.push(toRecord(i, false));
    });

    const suffix = m.part ? `.${m.part}` : "";
    const base = `posts/${m.crawl_run_id}/${m.attempt_no}${m.part ? `-${m.part}` : ""}`;
    const priority = run.kind === "backfill" ? "backfill" : "realtime";
    let gi = 0;
    for (const g of groups.values()) {
      for (let b = 0; b * batchSize < g.items.length; b++) {
        const chunk = g.items.slice(b * batchSize, (b + 1) * batchSize);
        const postsRef = await d.blobs.putJsonl(
          `${base}/m${gi}-${b}.jsonl.gz`,
          chunk.map((c) => c.rec),
        );
        await writeJobOutbox(tx, m.crawl_run_id, {
          queue: "ai.enrich",
          idempotencyKey: `ai.${m.crawl_run_id}.${m.attempt_no}${suffix}.${gi}.${b}`,
          type: "ai.enrich",
          tenantId: g.tenantId,
          payload: {
            batch_id: Bun.randomUUIDv7(),
            crawl_run_id: m.crawl_run_id,
            tenant_id: g.tenantId,
            topic_id: g.topicId,
            priority_class: priority,
            items: chunk.map(({ rec, isNew, queryId }) => ({
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
              match: { topic_query_id: queryId },
            })),
            items_ref: postsRef,
            models: MODELS,
          },
        });
        res.aiBatches++;
      }
      gi++;
    }
    if (unmatched.length) {
      const postsRef = await d.blobs.putJsonl(`${base}/u.jsonl.gz`, unmatched);
      await writeJobOutbox(tx, m.crawl_run_id, {
        queue: "sink.analytics",
        idempotencyKey: `sink.${m.crawl_run_id}.${m.attempt_no}${suffix}.u`,
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

    if (m.collection_stream_id) {
      // dasar atribusi biaya run stream (I-25): jumlah match baru per tenant
      const perTenant: Record<string, number> = {};
      for (const g of groups.values()) perTenant[g.tenantId] = (perTenant[g.tenantId] ?? 0) + g.items.length;
      await addTenantMatches(tx, m.crawl_run_id, perTenant);
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
