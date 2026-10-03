// Planner komentar (permintaan pemilik 2026-10-03): tiap topik aktif, ambil komentar dari post ber-engagement tertinggi.
//   - hanya platform yang punya routing policy `post_comments` aktif (connector yang sanggup, mis. LamaTok TikTok, YouTube)
//   - per (topik, platform): ≤ comments.top_posts_per_day post per 24 jam; post yang sama diambil ulang setelah
//     comments.refetch_hours; hanya post ≤ comments.max_post_age_days hari
//   - run `comments` dimiliki plan topik (tenant, biaya, quota ikut topik) → dispatch: operasi post_comments atas post target;
//     pipeline: komentar langsung ditautkan ke topik (tanpa cocok keyword) → sentimen/emosi/isu seperti post biasa.
// Semua angka diatur owner di Pengaturan → Batas & jadwal (system_settings). Run + job ditulis atomik (outbox).
import type { ClickHouseClient } from "@clickhouse/client";
import type { CrawlDispatchPayload } from "@smip/contracts";
import { BACKFILL_PRIORITY, type Db, loadSettings, withSystem, writeJobOutbox } from "@smip/db";
import { sql } from "drizzle-orm";
import { chTime } from "./sink";

/** Post per run komentar (target id per request connector; LamaTok maks 50). */
export const COMMENT_POSTS_PER_RUN = 20;

export interface CommentPlanResult {
  runs: number;
  posts: number;
  byTopicPlatform: Record<string, number>;
}

interface PlanRow {
  plan_id: string;
  tenant_id: string;
  topic_id: string;
  topic_query_id: string;
  platform_code: string;
  interval_sec: number;
}

export async function planComments(db: Db, ch: ClickHouseClient, o: { now?: () => Date } = {}): Promise<CommentPlanResult> {
  const now = o.now?.() ?? new Date();
  const res: CommentPlanResult = { runs: 0, posts: 0, byTopicPlatform: {} };
  const s = await loadSettings(db);
  if (!s["comments.enabled"] || s["comments.top_posts_per_day"] <= 0) return res;
  const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
  const refetchSince = new Date(now.getTime() - s["comments.refetch_hours"] * 3_600_000).toISOString();

  // satu plan wakil per (topik, platform) — plan topik aktif pada platform yang punya policy post_comments aktif;
  // topik dengan run komentar yang masih berjalan dilewati (tidak menumpuk)
  const plans = await withSystem(
    db,
    async (tx) =>
      (await tx.execute(sql`
      select distinct on (cp.topic_id, cp.platform_code) cp.id as plan_id, cp.tenant_id, cp.topic_id, cp.topic_query_id,
             cp.platform_code, cp.interval_sec
      from crawl_plans cp join topics t on t.id = cp.topic_id
      where t.status = 'active' and t.deleted_at is null and cp.status in ('active', 'error_backoff')
        -- hanya platform dengan connector komentar yang VERIFIED & aktif di policy post_comments aktif (connector belum
        -- diverifikasi / dimatikan → tidak membuat run yang pasti gagal)
        and cp.platform_code in (
          select rp.platform_code from routing_policies rp
          join routing_rules rr on rr.policy_id = rp.id and rr.enabled
          join connectors c on c.id = rr.connector_id and c.enabled
          join connector_capabilities cc on cc.connector_id = c.id and cc.operation = 'post_comments' and cc.status = 'verified'
          where rp.enabled and rp.operation = 'post_comments')
        and not exists (select 1 from crawl_runs r join crawl_plans p2 on p2.id = r.crawl_plan_id
                        where r.kind = 'comments' and p2.topic_id = cp.topic_id and p2.platform_code = cp.platform_code
                          and r.status in ('queued', 'dispatching', 'fetching', 'processing'))
      order by cp.topic_id, cp.platform_code, cp.created_at`)) as unknown as PlanRow[],
  );

  for (const p of plans) {
    // post yang sudah diambil komentarnya: dalam 24 jam (anggaran harian) dan dalam jendela refetch (jangan diulang)
    const used = await withSystem(
      db,
      async (tx) =>
        (await tx.execute(sql`
        select pid, r.scheduled_for >= ${refetchSince}::timestamptz as recent, r.scheduled_for >= ${dayAgo}::timestamptz as today
        from crawl_runs r join crawl_plans p2 on p2.id = r.crawl_plan_id,
             jsonb_array_elements_text(r.refresh_target->'post_ids') pid
        where r.kind = 'comments' and p2.topic_id = ${p.topic_id} and p2.platform_code = ${p.platform_code}
          and r.status not in ('failed', 'skipped', 'cancelled') -- run gagal tidak memakan anggaran / jeda ambil ulang
          and r.scheduled_for >= least(${dayAgo}::timestamptz, ${refetchSince}::timestamptz)`)) as unknown as {
          pid: string;
          recent: boolean;
          today: boolean;
        }[],
    );
    const budget = s["comments.top_posts_per_day"] - used.filter((u) => u.today).length;
    if (budget <= 0) continue;
    const skip = new Set(used.filter((u) => u.recent).map((u) => u.pid));
    const cand = await ch
      .query({
        query: `SELECT post_id FROM topic_matches FINAL
                WHERE tenant_id = {t:UUID} AND topic_id = {topic:UUID} AND platform = {pl:String} AND content_type = 'post'
                  AND published_at >= {since:DateTime64(3)}
                ORDER BY engagement DESC, published_at DESC
                LIMIT {lim:UInt32}`,
        query_params: {
          t: p.tenant_id,
          topic: p.topic_id,
          pl: p.platform_code,
          since: chTime(new Date(now.getTime() - s["comments.max_post_age_days"] * 86_400_000).toISOString()),
          lim: budget + skip.size,
        },
        format: "JSONEachRow",
      })
      .then((r) => r.json<{ post_id: string }>());
    const ids = cand
      .map((c) => c.post_id)
      .filter((id) => !skip.has(id))
      .slice(0, budget);
    if (!ids.length) continue;
    await withSystem(db, async (tx) => {
      for (let i = 0; i < ids.length; i += COMMENT_POSTS_PER_RUN) {
        const postIds = ids.slice(i, i + COMMENT_POSTS_PER_RUN);
        const runId = Bun.randomUUIDv7();
        const target = { platform: p.platform_code, post_ids: postIds, max_pages: s["comments.max_pages_per_post"] };
        const [r] = (await tx.execute(sql`insert into crawl_runs (id, tenant_id, crawl_plan_id, scheduled_for, kind, status, refresh_target)
          values (${runId}, ${p.tenant_id}, ${p.plan_id}, date_trunc('milliseconds', ${now.toISOString()}::timestamptz), 'comments', 'queued',
                  ${JSON.stringify(target)}::text::jsonb)
          returning scheduled_for`)) as unknown as { scheduled_for: Date | string }[];
        const payload: CrawlDispatchPayload = {
          crawl_run_id: runId,
          scheduled_for: new Date(r!.scheduled_for).toISOString(),
          crawl_plan_id: p.plan_id,
          topic_id: p.topic_id,
          topic_query_id: p.topic_query_id,
          platform: p.platform_code,
          operation: "post_comments",
          run_kind: "comments",
          window: {},
          interval_sec: p.interval_sec,
          attempt_no: 1,
          exclude_connector_ids: [],
          exclude_account_ids: [],
        };
        await writeJobOutbox(tx, runId, {
          queue: "crawl.dispatch",
          idempotencyKey: `run.${runId}.attempt.1`,
          type: "crawl.dispatch",
          tenantId: p.tenant_id,
          payload,
          priority: BACKFILL_PRIORITY, // rendah: tidak mengganggu pengambilan post topik
        });
        res.runs++;
      }
    });
    res.posts += ids.length;
    res.byTopicPlatform[`${p.topic_id}|${p.platform_code}`] = ids.length;
  }
  return res;
}
