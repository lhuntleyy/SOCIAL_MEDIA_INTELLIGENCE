// I-20 engagement refresh (FR-I06, QUEUE_SPEC §4.8, TESTING P-08/P-21).
//   planner (loop worker-sink, 1 pemegang lock): post ter-match ≤ maxAgeHours yang snapshot terakhirnya lebih tua dari
//            refreshEverySec → run `engagement_refresh` (≤ 50 post/run) + job `engagement.refresh` (outbox, atomik)
//   sink    : item `post_detail` → engagement_snapshots + koreksi topic_match_events: sign −1 salinan persis baris +1
//            terakhir, lalu sign +1 dengan engagement/followers baru → agregat ikut benar TANPA dobel hitung (P-08).
//            Followers ikut baris −1 & +1 (anyLast agg_author_1d = nilai terbaru, P-21). posts.author_followers diperbarui.
import type { ClickHouseClient } from "@clickhouse/client";
import { sinkInsertSettings } from "@smip/analytics";
import type { CanonicalItem, EngagementRefreshPayload, SinkAnalyticsPayload } from "@smip/contracts";
import { claimMessage, type Db, finalizeRunIfDone, withSystem, writeJobOutbox } from "@smip/db";
import { sql } from "drizzle-orm";
import { chTime, type SinkDeps, type SinkResult } from "./sink";

export interface RefreshPlanOptions {
  now?: () => Date;
  /** Post yang dipublikasikan ≤ N jam terakhir di-refresh (FR-I06). */
  maxAgeHours?: number;
  /** Jarak minimum antar refresh satu post (dari snapshot terakhir). */
  refreshEverySec?: number;
  batchSize?: number;
  /** Batas post per siklus per platform (menjaga biaya/quota provider). */
  maxPostsPerPlatform?: number;
}
export interface RefreshPlanResult {
  runs: number;
  posts: number;
  byPlatform: Record<string, number>;
  skippedPlatforms: string[];
}

/** Engagement = jumlah metrik yang DIKETAHUI (sama dengan sink ingest; null ≠ 0). */
export function engagementOfMetrics(m: CanonicalItem["metrics"]): { engagement: number; known: boolean } {
  const vals = [m.likes, m.comments, m.shares, m.quotes, m.saves].filter((v): v is number => typeof v === "number");
  return { engagement: vals.reduce((a, b) => a + b, 0), known: vals.length > 0 };
}

export async function planEngagementRefresh(db: Db, ch: ClickHouseClient, o: RefreshPlanOptions = {}): Promise<RefreshPlanResult> {
  const now = o.now?.() ?? new Date();
  const batch = Math.min(50, o.batchSize ?? 50);
  const res: RefreshPlanResult = { runs: 0, posts: 0, byPlatform: {}, skippedPlatforms: [] };
  // platform yang punya policy post_detail aktif; platform dengan run refresh masih berjalan dilewati (tidak menumpuk)
  const platforms = await withSystem(db, async (tx) => {
    const rows = (await tx.execute(sql`
      select distinct p.platform_code,
             exists (select 1 from crawl_runs r where r.kind = 'engagement_refresh' and r.refresh_target->>'platform' = p.platform_code
                       and r.status in ('queued', 'dispatching', 'fetching', 'processing')) as busy
      from routing_policies p where p.enabled and p.operation = 'post_detail'`)) as unknown as { platform_code: string; busy: boolean }[];
    for (const r of rows) if (r.busy) res.skippedPlatforms.push(r.platform_code);
    return rows.filter((r) => !r.busy).map((r) => r.platform_code);
  });
  if (!platforms.length) return res;
  // post yang SUDAH dicoba di jendela ini (termasuk yang tak dikembalikan provider: dihapus/privat → tanpa snapshot baru)
  // tidak dijadwalkan ulang — tanpa ini post hilang dicoba setiap siklus selamanya (review 2026-09-30)
  const freshSince = new Date(now.getTime() - (o.refreshEverySec ?? 7200) * 1000).toISOString();
  const recent = await withSystem(db, async (tx) =>
    (
      (await tx.execute(sql`select distinct (refresh_target->>'platform') || '|' || p as k
      from crawl_runs r, jsonb_array_elements_text(r.refresh_target->'post_ids') p
      where r.kind = 'engagement_refresh' and r.scheduled_for >= ${freshSince}::timestamptz`)) as unknown as { k: string }[]
    ).map((r) => r.k),
  );
  const cand = await ch
    .query({
      query: `SELECT platform, post_id FROM topic_matches FINAL
              WHERE platform IN {pl:Array(String)} AND published_at >= {since:DateTime64(3)}
                AND (platform, post_id) NOT IN (
                  SELECT platform, post_id FROM engagement_snapshots
                  WHERE platform IN {pl:Array(String)} AND captured_at >= {fresh:DateTime64(3)})
                AND concat(platform, '|', post_id) NOT IN {recent:Array(String)}
              GROUP BY platform, post_id
              ORDER BY platform, max(published_at) DESC
              LIMIT {lim:UInt32} BY platform`,
      query_params: {
        pl: platforms,
        since: chTime(new Date(now.getTime() - (o.maxAgeHours ?? 24) * 3600_000).toISOString()),
        fresh: chTime(new Date(now.getTime() - (o.refreshEverySec ?? 7200) * 1000).toISOString()),
        lim: o.maxPostsPerPlatform ?? 500,
        recent,
      },
      format: "JSONEachRow",
    })
    .then((r) => r.json<{ platform: string; post_id: string }>());
  const byPl = new Map<string, string[]>();
  for (const c of cand) byPl.set(c.platform, [...(byPl.get(c.platform) ?? []), c.post_id]);
  await withSystem(db, async (tx) => {
    for (const [platform, ids] of byPl) {
      for (let i = 0; i < ids.length; i += batch) {
        const postIds = ids.slice(i, i + batch);
        const runId = Bun.randomUUIDv7();
        const [r] = (await tx.execute(sql`insert into crawl_runs (id, scheduled_for, kind, status, refresh_target)
          values (${runId}, date_trunc('milliseconds', ${now.toISOString()}::timestamptz), 'engagement_refresh', 'queued',
                  ${JSON.stringify({ platform, post_ids: postIds })}::text::jsonb)
          returning scheduled_for`)) as unknown as { scheduled_for: Date | string }[];
        const payload: EngagementRefreshPayload = {
          crawl_run_id: runId,
          scheduled_for: new Date(r!.scheduled_for).toISOString(),
          platform,
          post_ids: postIds,
          reason: `age<${o.maxAgeHours ?? 24}h`,
        };
        await writeJobOutbox(tx, runId, {
          queue: "engagement.refresh",
          idempotencyKey: `refresh.${runId}`,
          type: "engagement.refresh",
          tenantId: null,
          payload,
          priority: 10, // rendah (QUEUE_SPEC §3)
        });
        res.runs++;
      }
      res.posts += ids.length;
      res.byPlatform[platform] = ids.length;
    }
  });
  return res;
}

type EventRow = Record<string, unknown> & {
  tenant_id: string;
  topic_id: string;
  platform: string;
  post_id: string;
  engagement: number | string;
  engagement_known: number;
  author_followers: number | string | null;
};

export async function handleRefreshSink(d: SinkDeps, m: SinkAnalyticsPayload): Promise<SinkResult> {
  const now = d.now?.() ?? new Date();
  const nowCh = chTime(now.toISOString());
  const res: SinkResult = { posts: 0, events: 0, skippedByGuard: 0, finalized: null, duplicateMessage: false };
  const items = await d.blobs.getJsonl<CanonicalItem>(m.posts_ref);
  const byKey = new Map(items.map((p) => [`${p.platform}|${p.platform_post_id}`, p]));
  if (items.length) {
    await d.ch.insert({
      table: "engagement_snapshots",
      format: "JSONEachRow",
      values: items.map((p) => ({
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
    res.posts = items.length;

    // followers terbaru → posts (salinan baris terkini, versi baru); hanya bila provider MENGETAHUI (null ≠ 0)
    const fol = items.filter((p) => p.author.followers !== null);
    if (fol.length) {
      await d.ch.command({
        query: `INSERT INTO posts SELECT * REPLACE (
                  transform(post_id, {ids:Array(String)}, {vals:Array(Nullable(UInt64))}, author_followers) AS author_followers,
                  {ver:UInt64} AS version, {now:DateTime64(3)} AS ingested_at)
                FROM posts FINAL WHERE platform = {pl:String} AND post_id IN {ids:Array(String)}`,
        query_params: {
          ids: fol.map((p) => p.platform_post_id),
          vals: fol.map((p) => p.author.followers),
          ver: now.getTime(),
          now: nowCh,
          pl: fol[0]!.platform,
        },
        clickhouse_settings: sinkInsertSettings(`${m.batch_id}.posts`),
      });
    }

    // baris +1 terakhir per (tenant, topic, post) = keadaan yang sedang dihitung agregat
    const platform = items[0]!.platform;
    const current = await d.ch
      .query({
        query: `SELECT * FROM topic_match_events
                WHERE platform = {pl:String} AND post_id IN {ids:Array(String)} AND sign = 1
                ORDER BY event_at DESC
                LIMIT 1 BY tenant_id, topic_id, platform, post_id`,
        query_params: { pl: platform, ids: items.map((p) => p.platform_post_id) },
        format: "JSONEachRow",
      })
      .then((r) => r.json<EventRow>());
    const rows: Record<string, unknown>[] = [];
    for (const cur of current) {
      const p = byKey.get(`${cur.platform}|${cur.post_id}`);
      if (!p) continue;
      const eng = engagementOfMetrics(p.metrics);
      // metrik baru tak diketahui → pertahankan nilai lama (jangan menimpa angka dengan "tidak tahu")
      const newEng = eng.known ? eng.engagement : Number(cur.engagement);
      const newKnown = eng.known ? 1 : Number(cur.engagement_known);
      const newFol = p.author.followers ?? (cur.author_followers === null ? null : Number(cur.author_followers));
      const oldFol = cur.author_followers === null ? null : Number(cur.author_followers);
      if (newEng === Number(cur.engagement) && newKnown === Number(cur.engagement_known) && newFol === oldFol) {
        res.skippedByGuard++; // tak berubah (atau pesan diulang setelah koreksi tertulis) → tidak ada pasangan
        continue;
      }
      // salinan persis kecuali sign/event_at (dimensi agregat identik → saling meniadakan); followers = terbaru (anyLast)
      rows.push({ ...cur, author_followers: newFol, sign: -1, event_at: nowCh });
      rows.push({ ...cur, author_followers: newFol, engagement: newEng, engagement_known: newKnown, sign: 1, event_at: nowCh });
    }
    if (rows.length) {
      await d.ch.insert({
        table: "topic_match_events",
        format: "JSONEachRow",
        values: rows,
        clickhouse_settings: sinkInsertSettings(m.batch_id),
      });
    }
    res.events = rows.length / 2;
  }

  await withSystem(d.db, async (tx) => {
    if (!(await claimMessage(tx, `sink.${m.batch_id}`))) {
      res.duplicateMessage = true;
      return;
    }
    await tx.execute(sql`update crawl_runs set pending_batches = greatest(0, pending_batches - 1) where id = ${m.crawl_run_id}`);
    res.finalized = (await finalizeRunIfDone(tx, m.crawl_run_id, now))?.outcome ?? null;
  });
  d.logger?.info("sink refresh", { batch_id: m.batch_id, crawl_run_id: m.crawl_run_id, ...res });
  return res;
}
