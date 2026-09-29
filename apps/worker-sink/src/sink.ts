// I-15 worker-sink (DATA_MODEL §6, QUEUE_SPEC §4.6): batch → ClickHouse
//   posts (global, ReplacingMergeTree) + engagement_snapshots + topic_match_events (sign +1, sumber MV agregat)
// Idempotensi berlapis:
//   1. insert_deduplication_token = batch_id + dedup di MV (sinkInsertSettings) → pesan terkirim 2× tidak dobel (P-03)
//   2. guard ClickHouse: match (tenant, topic, platform, post, model_version) yang sudah ada di topic_matches dilewati
//      → kunci Redis `seenm` hilang pun tidak menggandakan agregat (P-09)
//   3. ledger processed_messages → counter run (−1) & realtime.notify tidak diulang
// Consumer dijalankan concurrency 1 (profil MVP) — guard "cek lalu insert" tidak atomik (DATA_MODEL §6.2);
// partisi per hash(tenant, topic, post) saat skala naik.
import type { ClickHouseClient } from "@clickhouse/client";
import { sinkInsertSettings } from "@smip/analytics";
import type { PostRecord, SinkAnalyticsPayload } from "@smip/contracts";
import { claimMessage, type Db, finalizeRunIfDone, withSystem, writeJobOutbox } from "@smip/db";
import type { Logger } from "@smip/observability";
import type { BlobStore } from "@smip/storage";
import { sql } from "drizzle-orm";
import { handleRefreshSink } from "./refresh";
import { handleRelabelSink } from "./relabel";

export interface SinkDeps {
  db: Db;
  ch: ClickHouseClient;
  blobs: BlobStore;
  logger?: Logger;
  now?: () => Date;
}
export interface SinkResult {
  posts: number;
  events: number;
  skippedByGuard: number;
  finalized: "succeeded" | "partial" | null;
  duplicateMessage: boolean;
}

/** ISO-8601 → format DateTime64 ClickHouse (UTC, milidetik). */
export const chTime = (iso: string) => iso.replace("T", " ").replace("Z", "").slice(0, 23);
const chSec = (iso: string) => chTime(iso).slice(0, 19);
const fiveMin = (iso: string) => {
  const t = Date.parse(iso);
  return new Date(t - (t % 300_000)).toISOString();
};

function postRow(p: PostRecord, now: string, version: number) {
  return {
    platform: p.platform,
    post_id: p.platform_post_id,
    content_type: p.content_type,
    parent_post_id: p.parent?.platform_post_id ?? null,
    root_post_id: p.root_post_id,
    parent_author_id: p.parent?.author?.platform_user_id ?? null,
    parent_author_handle: p.parent?.author?.handle ?? null,
    url: p.url,
    text: p.text ?? "",
    lang: p.lang_hint ?? "",
    published_at: chTime(p.published_at),
    author_id: p.author.platform_user_id,
    author_handle: p.author.handle ?? "",
    author_name: p.author.display_name,
    author_created_at: p.author.created_at ? chSec(p.author.created_at) : null,
    author_followers: p.author.followers,
    author_verified: p.author.verified === null ? null : p.author.verified ? 1 : 0,
    author_location_raw: p.author.location_raw,
    hashtags: p.hashtags,
    mentions: p.mentions,
    media: JSON.stringify(p.media),
    geo_region_code: p.geo_region_code,
    geo_confidence: p.geo_confidence,
    is_ad: p.is_ad === null ? null : p.is_ad ? 1 : 0,
    matched: p.matched ? 1 : 0,
    source_connector: p.provenance.connector_key,
    raw_ref: p.provenance.raw_ref ?? "",
    ingested_at: now,
    version,
  };
}

/** Engagement = jumlah metrik yang DIKETAHUI; semua null → tidak diketahui (bukan 0, AGENTS §3a). */
function engagementOf(p: PostRecord): { engagement: number; known: boolean } {
  const m = p.metrics;
  const vals = [m.likes, m.comments, m.shares, m.quotes, m.saves].filter((v): v is number => typeof v === "number");
  return { engagement: vals.reduce((a, b) => a + b, 0), known: vals.length > 0 };
}

export async function handleSink(d: SinkDeps, m: SinkAnalyticsPayload): Promise<SinkResult> {
  if (m.mode === "engagement_refresh") return handleRefreshSink(d, m); // I-20
  if (m.mode === "relabel") return handleRelabelSink(d, m); // A-06
  const now = d.now?.() ?? new Date();
  const nowCh = chTime(now.toISOString());
  const res: SinkResult = { posts: 0, events: 0, skippedByGuard: 0, finalized: null, duplicateMessage: false };
  const posts = await d.blobs.getJsonl<PostRecord>(m.posts_ref);
  const byId = new Map(posts.map((p) => [`${p.platform}|${p.platform_post_id}`, p]));

  if (posts.length) {
    await d.ch.insert({
      table: "posts",
      format: "JSONEachRow",
      values: posts.map((p) => postRow(p, nowCh, now.getTime())),
      clickhouse_settings: sinkInsertSettings(`${m.batch_id}.posts`),
    });
    await d.ch.insert({
      table: "engagement_snapshots",
      format: "JSONEachRow",
      values: posts.map((p) => ({
        platform: p.platform,
        post_id: p.platform_post_id,
        captured_at: chTime(p.metrics.captured_at ?? now.toISOString()),
        likes: p.metrics.likes,
        comments: p.metrics.comments,
        shares: p.metrics.shares,
        views: p.metrics.views,
        quotes: p.metrics.quotes,
        saves: p.metrics.saves,
        source_connector: p.provenance.connector_key,
      })),
      clickhouse_settings: sinkInsertSettings(`${m.batch_id}.eng`),
    });
    res.posts = posts.length;
  }

  if (m.matches.length && m.tenant_id && m.topic_id) {
    // guard P-09: match yang sudah tercatat (model sama) → lewati
    const existing = await d.ch
      .query({
        query: `SELECT platform, post_id, model_version FROM topic_matches FINAL
                WHERE tenant_id = {t:UUID} AND topic_id = {topic:UUID} AND post_id IN {ids:Array(String)}`,
        query_params: { t: m.tenant_id, topic: m.topic_id, ids: [...new Set(m.matches.map((x) => x.post_id))] },
        format: "JSONEachRow",
      })
      .then((r) => r.json<{ platform: string; post_id: string; model_version: string }>());
    const seen = new Set(existing.map((e) => `${e.platform}|${e.post_id}|${e.model_version}`));
    const rows = [];
    for (const x of m.matches) {
      if (seen.has(`${x.platform}|${x.post_id}|${x.model_version}`)) {
        res.skippedByGuard++;
        continue;
      }
      const p = byId.get(`${x.platform}|${x.post_id}`);
      if (!p) {
        d.logger?.warn("match tanpa post di posts_ref — dilewati", { batch_id: m.batch_id, post_id: x.post_id });
        continue;
      }
      const eng = engagementOf(p);
      rows.push({
        tenant_id: m.tenant_id,
        topic_id: m.topic_id,
        topic_query_id: x.topic_query_id,
        platform: x.platform,
        post_id: x.post_id,
        content_type: p.content_type,
        published_at: chTime(p.published_at),
        author_id: p.author.platform_user_id,
        author_handle: p.author.handle ?? "",
        author_created_year: p.author.created_at ? new Date(p.author.created_at).getUTCFullYear() : null,
        author_followers: x.author_followers ?? p.author.followers,
        sentiment: x.sentiment,
        sentiment_score: x.sentiment_score,
        emotion: x.emotion,
        emotion_score: x.emotion_score,
        author_gender: x.author_gender,
        author_gender_conf: x.author_gender_conf,
        author_age_range: x.author_age_range,
        author_age_conf: x.author_age_conf,
        model_version: x.model_version,
        issues: x.issues,
        hashtags: x.hashtags,
        parent_author_id: x.parent_author_id ?? p.parent?.author?.platform_user_id ?? null,
        parent_author_handle: p.parent?.author?.handle ?? null,
        geo_region_code: x.geo_region_code ?? p.geo_region_code,
        media: x.media.map((md) => ({ type: md.type, url: md.url, thumb: md.thumb })),
        // nilai dari AI hanya bila ia MENGETAHUI; selain itu hitung dari metrik post (null ≠ 0)
        engagement: x.engagement_known ? x.engagement : eng.engagement,
        engagement_known: x.engagement_known || eng.known ? 1 : 0,
        sign: 1,
        event_at: nowCh,
      });
    }
    if (rows.length) {
      await d.ch.insert({
        table: "topic_match_events",
        format: "JSONEachRow",
        values: rows,
        clickhouse_settings: sinkInsertSettings(m.batch_id),
      });
    }
    res.events = rows.length;
  }

  await withSystem(d.db, async (tx) => {
    if (!(await claimMessage(tx, `sink.${m.batch_id}`))) {
      res.duplicateMessage = true;
      return;
    }
    await tx.execute(sql`update crawl_runs set pending_batches = greatest(0, pending_batches - 1) where id = ${m.crawl_run_id}`);
    const fin = await finalizeRunIfDone(tx, m.crawl_run_id, now);
    res.finalized = fin?.outcome ?? null;
    if (res.events && m.tenant_id && m.topic_id) {
      const buckets = [
        ...new Set(
          m.matches
            .map((x) => byId.get(`${x.platform}|${x.post_id}`)?.published_at)
            .filter(Boolean)
            .map((t) => fiveMin(t!)),
        ),
      ].sort();
      await writeJobOutbox(tx, m.crawl_run_id, {
        queue: "realtime.notify",
        idempotencyKey: `rt.${m.batch_id}`,
        type: "realtime.notify",
        tenantId: m.tenant_id,
        payload: {
          tenant_id: m.tenant_id,
          topic_id: m.topic_id,
          buckets,
          platforms: [...new Set(m.matches.map((x) => x.platform))].sort(),
        },
      });
    }
  });
  d.logger?.info("sink", { batch_id: m.batch_id, crawl_run_id: m.crawl_run_id, ...res });
  return res;
}
