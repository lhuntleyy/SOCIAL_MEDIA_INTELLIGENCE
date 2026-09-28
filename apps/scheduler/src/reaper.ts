// I-12 `crawl.reaper` (QUEUE_SPEC §6, P-10): run non-final melewati scheduled_for + grace → failed/STUCK_RUN
// (compare-and-set: hanya bila status masih non-final) dan plan/stream dibebaskan agar tidak ter-coalesce selamanya.
import { type Db, withSystem } from "@smip/db";
import { sql } from "drizzle-orm";

export async function reapStuckRuns(db: Db, o: { graceSec: number; now?: () => Date }): Promise<string[]> {
  const cutoff = new Date((o.now?.() ?? new Date()).getTime() - o.graceSec * 1000).toISOString();
  return withSystem(db, async (tx) => {
    const stuck = (await tx.execute(sql`
      update crawl_runs set status = 'failed', error_code = 'STUCK_RUN',
             error_message = 'run non-final melewati batas waktu (reaper)', finished_at = now()
      where status in ('queued', 'dispatching', 'fetching', 'processing') and scheduled_for < ${cutoff}::timestamptz
      returning id`)) as unknown as { id: string }[];
    if (!stuck.length) return [];
    const ids = stuck.map((r) => r.id);
    await tx.execute(sql`update crawl_plans set inflight_run_id = null, updated_at = now() where inflight_run_id in ${ids}`);
    await tx.execute(sql`update collection_streams set inflight_run_id = null where inflight_run_id in ${ids}`);
    return ids;
  });
}
