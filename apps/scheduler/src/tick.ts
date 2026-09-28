// I-12 tick scheduler (QUEUE_SPEC §6): plan jatuh tempo → crawl_runs(queued) + outbox job `crawl.dispatch`
// dalam SATU transaksi (tidak ada run "hantu"). FOR UPDATE SKIP LOCKED → aman bila dua scheduler sempat aktif.
import type { CrawlDispatchPayload } from "@smip/contracts";
import { BACKFILL_PRIORITY, createCrawlRun, type Db, jsonbValue, pruneGaps, withSystem } from "@smip/db";
import { sql } from "drizzle-orm";

export const NON_FINAL = ["queued", "dispatching", "fetching", "processing"] as const;

export interface TickOptions {
  now?: () => Date;
  limit?: number;
  initialLookbackSec?: number;
  /** true = antrean hilir penuh → plan prioritas rendah (priority ≥ 5) ditunda. */
  backpressure?: (platform: string) => Promise<boolean> | boolean;
  random?: () => number;
  /** Umur maksimum celah (detik) sebelum dibuang; default 24 jam. */
  maxGapAgeSec?: number;
}
export interface TickResult {
  scheduled: number;
  coalesced: number;
  deferred: number;
  gapRuns: number;
  /** Celah dibuang karena melewati umur maksimum, per platform. */
  gapsAbandoned: Record<string, number>;
}

interface PlanRow {
  id: string;
  tenant_id: string;
  topic_id: string;
  topic_query_id: string;
  platform_code: string;
  operation: CrawlDispatchPayload["operation"];
  interval_sec: number;
  high_watermark: string | Date | null;
  gap_windows: { since: string; until: string; created_at?: string; run_id?: string }[];
  priority: number;
  inflight_run_id: string | null;
  inflight_status: string | null;
}

const iso = (d: Date) => d.toISOString();
const DEFER_MS = 60_000;

/** overlap = max(60 s, 0.2 × interval) — provider bisa terlambat mengindeks (QUEUE_SPEC §6). */
export const overlapSec = (intervalSec: number) => Math.max(60, Math.round(0.2 * intervalSec));
/** next_run_at = now + interval ± 5% (jitter mencegah semua topik 5m menembak di detik yang sama). */
export const nextRunAt = (now: Date, intervalSec: number, random = Math.random) =>
  new Date(now.getTime() + intervalSec * 1000 * (1 + (random() * 2 - 1) * 0.05));

export async function schedulerTick(db: Db, o: TickOptions = {}): Promise<TickResult> {
  const now = o.now?.() ?? new Date();
  const random = o.random ?? Math.random;
  const res: TickResult = { scheduled: 0, coalesced: 0, deferred: 0, gapRuns: 0, gapsAbandoned: {} };
  await withSystem(db, async (tx) => {
    res.gapsAbandoned = await pruneGaps(tx, o.maxGapAgeSec ?? 86_400, now);
    const plans = (await tx.execute(sql`
      select p.id, p.tenant_id, p.topic_id, p.topic_query_id, p.platform_code, p.operation, p.interval_sec, p.high_watermark,
             p.gap_windows, p.priority, p.inflight_run_id,
             (select r.status from crawl_runs r where r.id = p.inflight_run_id limit 1) as inflight_status
      from crawl_plans p
      where p.status = 'active' and p.next_run_at <= ${iso(now)}::timestamptz
      order by p.priority, p.next_run_at
      limit ${o.limit ?? 500}
      for update of p skip locked`)) as unknown as PlanRow[];

    for (const p of plans) {
      // coalescing (P-07): run sebelumnya belum final → jangan antre run baru
      if (p.inflight_run_id && p.inflight_status && (NON_FINAL as readonly string[]).includes(p.inflight_status)) {
        res.coalesced++;
        await tx.execute(
          sql`update crawl_plans set next_run_at = ${iso(nextRunAt(now, p.interval_sec, random))}::timestamptz, updated_at = now() where id = ${p.id}`,
        );
        continue;
      }
      const pressured = p.priority >= 5 && o.backpressure ? await o.backpressure(p.platform_code) : false;
      if (pressured) {
        res.deferred++;
        await tx.execute(
          sql`update crawl_plans set next_run_at = ${iso(new Date(now.getTime() + DEFER_MS))}::timestamptz, updated_at = now() where id = ${p.id}`,
        );
        continue;
      }
      const since = p.high_watermark
        ? new Date(new Date(p.high_watermark).getTime() - overlapSec(p.interval_sec) * 1000)
        : new Date(now.getTime() - (o.initialLookbackSec ?? 3600) * 1000);
      const runId = await createCrawlRun(tx, p, "incremental", { since, until: now }, now, p.priority + 1);
      res.scheduled++;

      // celah dari run partial (CONNECTOR_SPEC §7): satu run backfill per tick, prioritas rendah; dilepas saat run celah sukses (I-24)
      const gaps = p.gap_windows ?? [];
      const gi = gaps.findIndex((g) => !g.run_id);
      if (gi >= 0) {
        const g = gaps[gi]!;
        gaps[gi] = {
          ...g,
          run_id: await createCrawlRun(tx, p, "backfill", { since: new Date(g.since), until: new Date(g.until) }, now, BACKFILL_PRIORITY),
        };
        res.gapRuns++;
      }
      await tx.execute(sql`update crawl_plans set inflight_run_id = ${runId}, last_run_at = ${iso(now)}::timestamptz,
        next_run_at = ${iso(nextRunAt(now, p.interval_sec, random))}::timestamptz, gap_windows = ${jsonbValue(gaps)}, updated_at = now()
        where id = ${p.id}`);
    }
  });
  return res;
}
