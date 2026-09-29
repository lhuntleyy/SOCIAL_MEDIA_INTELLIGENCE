// I-12 `crawl.reaper` (QUEUE_SPEC §6, P-10): run non-final melewati scheduled_for + grace → failed/STUCK_RUN
// (compare-and-set: hanya bila status masih non-final) dan plan/stream dibebaskan agar tidak ter-coalesce selamanya.
// Review 2026-09-30: run celah (backfill) yang macet melepas `run_id` celahnya (dicoba ulang tick berikutnya, bukan
// menunggu dibuang max_gap_age), dan biaya attempt run stream yang macet tetap dialokasikan ke tenant (I-25).
import { allocateStreamRunCost, type Db, settleGap, withSystem } from "@smip/db";
import { sql } from "drizzle-orm";

export async function reapStuckRuns(db: Db, o: { graceSec: number; now?: () => Date }): Promise<string[]> {
  const cutoff = new Date((o.now?.() ?? new Date()).getTime() - o.graceSec * 1000).toISOString();
  return withSystem(db, async (tx) => {
    const stuck = (await tx.execute(sql`
      update crawl_runs set status = 'failed', error_code = 'STUCK_RUN',
             error_message = 'run non-final melewati batas waktu (reaper)', finished_at = now()
      where status in ('queued', 'dispatching', 'fetching', 'processing') and scheduled_for < ${cutoff}::timestamptz
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
