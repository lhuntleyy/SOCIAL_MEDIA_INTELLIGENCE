// I-12 tick scheduler (QUEUE_SPEC §6): plan jatuh tempo → crawl_runs(queued) + outbox job `crawl.dispatch`
// dalam SATU transaksi (tidak ada run "hantu"). FOR UPDATE SKIP LOCKED → aman bila dua scheduler sempat aktif.
import type { CrawlDispatchPayload } from "@smip/contracts";
import {
  BACKFILL_PRIORITY,
  type BreachedPolicy,
  createCrawlRun,
  type Db,
  EMPTY_COST_GUARD,
  evaluateCostGuard,
  isThrottled,
  jsonbValue,
  pruneGaps,
  withSystem,
} from "@smip/db";
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
  /** I-23 cost guard: false = nonaktif. Interval efektif saat soft cap tercapai (default 3600 s = maksimum plan). */
  costGuard?: false | { throttleIntervalSec?: number };
}
export interface TickResult {
  scheduled: number;
  coalesced: number;
  deferred: number;
  gapRuns: number;
  /** Celah dibuang karena melewati umur maksimum, per platform. */
  gapsAbandoned: Record<string, number>;
  streamsScheduled: number;
  streamsCoalesced: number;
  /** Plan/stream yang dijadwalkan dengan interval throttle (soft cap tercapai). */
  throttled: number;
  /** Transisi soft cap pada tick ini (untuk log/alert). */
  costGuard: { breached: BreachedPolicy[]; throttledNow: BreachedPolicy[]; released: string[] };
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
  const res: TickResult = {
    scheduled: 0,
    coalesced: 0,
    deferred: 0,
    gapRuns: 0,
    gapsAbandoned: {},
    streamsScheduled: 0,
    streamsCoalesced: 0,
    throttled: 0,
    costGuard: { breached: [], throttledNow: [], released: [] },
  };
  const throttleSec = (o.costGuard || undefined)?.throttleIntervalSec ?? 3600;
  await withSystem(db, async (tx) => {
    res.gapsAbandoned = await pruneGaps(tx, o.maxGapAgeSec ?? 86_400, now);
    const guard = o.costGuard === false ? EMPTY_COST_GUARD : await evaluateCostGuard(tx);
    res.costGuard = { breached: guard.breached, throttledNow: guard.throttled, released: guard.released };
    /** Soft cap → interval dinaikkan ke maksimum; ingestion tidak berhenti (COST_MODEL §8, P-16). */
    const interval = (base: number, throttled: boolean) => {
      if (!throttled) return base;
      res.throttled++;
      return Math.max(base, throttleSec);
    };
    const plans = (await tx.execute(sql`
      select p.id, p.tenant_id, p.topic_id, p.topic_query_id, p.platform_code, p.operation, p.interval_sec, p.high_watermark,
             p.gap_windows, p.priority, p.inflight_run_id,
             (select r.status from crawl_runs r where r.id = p.inflight_run_id limit 1) as inflight_status
      from crawl_plans p
      where p.status = 'active' and p.next_run_at <= ${iso(now)}::timestamptz
        -- dilayani collection stream aktif (I-22) → jangan fetch sendiri
        and not exists (select 1 from stream_topic_links l join collection_streams s on s.id = l.stream_id
                        where l.topic_query_id = p.topic_query_id and s.enabled and s.platform_code = p.platform_code and s.operation = p.operation)
      order by p.priority, p.next_run_at
      limit ${o.limit ?? 500}
      for update of p skip locked`)) as unknown as PlanRow[];

    for (const p of plans) {
      const iv = interval(
        p.interval_sec,
        isThrottled(guard, { platform_code: p.platform_code, tenant_id: p.tenant_id, topic_id: p.topic_id }),
      );
      // coalescing (P-07): run sebelumnya belum final → jangan antre run baru
      if (p.inflight_run_id && p.inflight_status && (NON_FINAL as readonly string[]).includes(p.inflight_status)) {
        res.coalesced++;
        await tx.execute(
          sql`update crawl_plans set next_run_at = ${iso(nextRunAt(now, iv, random))}::timestamptz, updated_at = now() where id = ${p.id}`,
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
        next_run_at = ${iso(nextRunAt(now, iv, random))}::timestamptz, gap_windows = ${jsonbValue(gaps)}, updated_at = now()
        where id = ${p.id}`);
    }

    // collection stream jatuh tempo (ADR-009): run system-owned, pola sama dengan plan
    const streams = (await tx.execute(sql`
      select s.id, s.platform_code, s.operation, s.interval_sec, s.high_watermark, s.gap_windows, s.priority, s.inflight_run_id,
             (select r.status from crawl_runs r where r.id = s.inflight_run_id limit 1) as inflight_status,
             array(select l.tenant_id::text from stream_topic_links l where l.stream_id = s.id order by l.topic_query_id) as member_tenants,
             array(select q.topic_id::text from stream_topic_links l join topic_queries q on q.id = l.topic_query_id
                   where l.stream_id = s.id order by l.topic_query_id) as member_topics
      from collection_streams s where s.enabled and s.next_run_at <= ${iso(now)}::timestamptz
      order by s.priority, s.next_run_at limit ${o.limit ?? 500}
      for update of s skip locked`)) as unknown as (Omit<PlanRow, "tenant_id" | "topic_id" | "topic_query_id"> & {
      member_tenants: string[];
      member_topics: string[];
    })[];
    for (const st of streams) {
      // stream melayani banyak tenant: throttle bila scope platform/global, atau semua anggotanya sudah lewat soft cap
      const iv = interval(
        st.interval_sec,
        isThrottled(guard, { platform_code: st.platform_code, member_tenants: st.member_tenants, member_topics: st.member_topics }),
      );
      if (st.inflight_run_id && st.inflight_status && (NON_FINAL as readonly string[]).includes(st.inflight_status)) {
        res.streamsCoalesced++;
        await tx.execute(
          sql`update collection_streams set next_run_at = ${iso(nextRunAt(now, iv, random))}::timestamptz where id = ${st.id}`,
        );
        continue;
      }
      const target = {
        stream: true as const,
        id: st.id,
        platform_code: st.platform_code,
        operation: st.operation,
        interval_sec: st.interval_sec,
      };
      const since = st.high_watermark
        ? new Date(new Date(st.high_watermark).getTime() - overlapSec(st.interval_sec) * 1000)
        : new Date(now.getTime() - (o.initialLookbackSec ?? 3600) * 1000);
      const runId = await createCrawlRun(tx, target, "incremental", { since, until: now }, now, st.priority + 1);
      res.streamsScheduled++;
      const gaps = st.gap_windows ?? [];
      const gi = gaps.findIndex((g) => !g.run_id);
      if (gi >= 0) {
        const g = gaps[gi]!;
        gaps[gi] = {
          ...g,
          run_id: await createCrawlRun(
            tx,
            target,
            "backfill",
            { since: new Date(g.since), until: new Date(g.until) },
            now,
            BACKFILL_PRIORITY,
          ),
        };
        res.gapRuns++;
      }
      await tx.execute(sql`update collection_streams set inflight_run_id = ${runId}, last_run_at = ${iso(now)}::timestamptz,
        next_run_at = ${iso(nextRunAt(now, iv, random))}::timestamptz, gap_windows = ${jsonbValue(gaps)}, updated_at = now()
        where id = ${st.id}`);
    }
  });
  return res;
}
