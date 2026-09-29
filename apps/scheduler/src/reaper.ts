// I-12 `crawl.reaper` (QUEUE_SPEC §6, P-10): run non-final melewati scheduled_for + grace → failed/STUCK_RUN
// (compare-and-set: hanya bila status masih non-final) dan plan/stream dibebaskan agar tidak ter-coalesce selamanya.
// Review 2026-09-30: run celah (backfill) yang macet melepas `run_id` celahnya (dicoba ulang tick berikutnya, bukan
// menunggu dibuang max_gap_age), dan biaya attempt run stream yang macet tetap dialokasikan ke tenant (I-25).
import { allocateStreamRunCost, BACKFILL_PRIORITY, type Db, settleGap, withSystem, writeJobOutbox } from "@smip/db";
import { sql } from "drizzle-orm";

/** Berapa kali run yang belum pernah di-dispatch boleh diantrekan ulang sebelum dianggap macet. */
export const MAX_REQUEUES = 4;

/**
 * Run `queued` yang belum pernah di-dispatch (attempts = 0) dan melewati grace → job dispatch-nya kemungkinan hilang
 * (mati timeout/DLQ, Redis dipulihkan). Diantrekan ulang (job baru, idempotency key baru; handler dispatch idempoten —
 * job ganda untuk run yang sama di-ignore) maks. MAX_REQUEUES kali, bukan langsung digagalkan. Teramati live 2026-09-30:
 * 45 run backfill kehilangan job dan akan digagalkan STUCK_RUN tanpa pernah mengambil data.
 */
async function requeueUndispatched(tx: Parameters<Parameters<typeof withSystem>[1]>[0], cutoff: string): Promise<number> {
  const rows = (await tx.execute(sql`
    select r.id, r.scheduled_for::text as sf, r.kind, r.tenant_id, r.crawl_plan_id, r.collection_stream_id,
           r.window_from, r.window_to, coalesce((r.routing->>'requeues')::int, 0) as requeues,
           coalesce(p.topic_id, null) as topic_id, p.topic_query_id,
           coalesce(p.platform_code, s.platform_code) as platform, coalesce(p.operation, s.operation) as operation,
           coalesce(p.interval_sec, s.interval_sec) as interval_sec
    from crawl_runs r
    left join crawl_plans p on p.id = r.crawl_plan_id
    left join collection_streams s on s.id = r.collection_stream_id
    where r.status = 'queued' and r.attempts = 0 and r.kind in ('incremental', 'backfill')
      and coalesce((r.routing->>'requeued_at')::timestamptz, r.scheduled_for) < ${cutoff}::timestamptz
      and coalesce((r.routing->>'requeues')::int, 0) < ${MAX_REQUEUES}
      and coalesce(p.platform_code, s.platform_code) is not null
    order by r.scheduled_for
    limit 500
    for update of r skip locked`)) as unknown as {
    id: string;
    sf: string;
    kind: "incremental" | "backfill";
    tenant_id: string | null;
    crawl_plan_id: string | null;
    collection_stream_id: string | null;
    window_from: Date | string | null;
    window_to: Date | string | null;
    requeues: number;
    topic_id: string | null;
    topic_query_id: string | null;
    platform: string;
    operation: string;
    interval_sec: number;
  }[];
  for (const r of rows) {
    const n = Number(r.requeues) + 1;
    await tx.execute(sql`update crawl_runs set routing = coalesce(routing, '{}'::jsonb)
        || jsonb_build_object('requeues', ${n}::int, 'requeued_at', now()::text)
      where id = ${r.id} and scheduled_for = ${r.sf}::timestamptz`);
    const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : new Date().toISOString());
    await writeJobOutbox(tx, r.id, {
      queue: "crawl.dispatch",
      idempotencyKey: `run.${r.id}.attempt.1.requeue.${n}`,
      type: "crawl.dispatch",
      tenantId: r.tenant_id,
      priority: r.kind === "backfill" ? BACKFILL_PRIORITY : 5,
      payload: {
        crawl_run_id: r.id,
        scheduled_for: new Date(r.sf).toISOString(),
        crawl_plan_id: r.crawl_plan_id,
        ...(r.collection_stream_id ? { collection_stream_id: r.collection_stream_id } : {}),
        topic_id: r.topic_id,
        topic_query_id: r.topic_query_id,
        platform: r.platform,
        operation: r.operation,
        run_kind: r.kind,
        window: { since: iso(r.window_from), until: iso(r.window_to) },
        interval_sec: Number(r.interval_sec),
        attempt_no: 1,
        exclude_connector_ids: [],
        exclude_account_ids: [],
      },
    });
  }
  return rows.length;
}

export async function reapStuckRuns(db: Db, o: { graceSec: number; now?: () => Date }): Promise<string[]> {
  const cutoff = new Date((o.now?.() ?? new Date()).getTime() - o.graceSec * 1000).toISOString();
  return withSystem(db, async (tx) => {
    await requeueUndispatched(tx, cutoff);
    const stuck = (await tx.execute(sql`
      update crawl_runs set status = 'failed', error_code = 'STUCK_RUN',
             error_message = 'run non-final melewati batas waktu (reaper)', finished_at = now()
      where status in ('queued', 'dispatching', 'fetching', 'processing')
        and coalesce((routing->>'requeued_at')::timestamptz, scheduled_for) < ${cutoff}::timestamptz
      returning id, kind, crawl_plan_id, collection_stream_id`)) as unknown as {
      id: string;
      kind: string;
      crawl_plan_id: string | null;
      collection_stream_id: string | null;
    }[];
    if (!stuck.length) return [];
    const ids = stuck.map((r) => r.id);
    await tx.execute(sql`update crawl_plans set inflight_run_id = null, updated_at = now() where inflight_run_id in ${ids}`);
    await tx.execute(sql`update collection_streams set inflight_run_id = null where inflight_run_id in ${ids}`);
    for (const r of stuck) {
      const owner = r.crawl_plan_id ?? r.collection_stream_id;
      if (r.kind === "backfill" && owner) await settleGap(tx, owner, r.id, false, r.crawl_plan_id ? "crawl_plans" : "collection_streams");
      if (r.collection_stream_id) await allocateStreamRunCost(tx, r.id);
    }
    return ids;
  });
}
