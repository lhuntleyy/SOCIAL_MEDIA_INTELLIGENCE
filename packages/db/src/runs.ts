// Pembuatan crawl_run + job `crawl.dispatch` via outbox dalam transaksi pemanggil (scheduler tick, API backfill).
import type { CrawlDispatchPayload } from "@smip/contracts";
import { sql } from "drizzle-orm";
import { type Db, type Tx, withSystem } from "./client";
import { writeJobOutbox } from "./outbox";

export interface PlanForRun {
  id: string;
  tenant_id: string;
  topic_id: string;
  topic_query_id: string;
  platform_code: string;
  operation: CrawlDispatchPayload["operation"];
  interval_sec: number;
}

/** BullMQ priority: 1 = tertinggi. Backfill manual/celah = 10 (paling rendah, QUEUE_SPEC §3). */
export const BACKFILL_PRIORITY = 10;

export async function createCrawlRun(
  tx: Tx,
  p: PlanForRun,
  kind: "incremental" | "backfill",
  window: { since: Date; until: Date },
  now: Date,
  priority: number,
): Promise<string> {
  const id = Bun.randomUUIDv7();
  await tx.execute(sql`insert into crawl_runs (id, tenant_id, crawl_plan_id, scheduled_for, kind, status, window_from, window_to)
    values (${id}, ${p.tenant_id}, ${p.id}, ${now.toISOString()}::timestamptz, ${kind}::e_run_kind, 'queued',
            ${window.since.toISOString()}::timestamptz, ${window.until.toISOString()}::timestamptz)`);
  const payload: CrawlDispatchPayload = {
    crawl_run_id: id,
    scheduled_for: now.toISOString(),
    crawl_plan_id: p.id,
    topic_id: p.topic_id,
    topic_query_id: p.topic_query_id,
    platform: p.platform_code,
    operation: p.operation,
    run_kind: kind,
    window: { since: window.since.toISOString(), until: window.until.toISOString() },
    interval_sec: p.interval_sec,
    attempt_no: 1,
    exclude_connector_ids: [],
    exclude_account_ids: [],
  };
  await writeJobOutbox(tx, id, {
    queue: "crawl.dispatch",
    idempotencyKey: `run.${id}.attempt.1`,
    type: "crawl.dispatch",
    tenantId: p.tenant_id,
    payload,
    priority,
  });
  return id;
}

/**
 * Celah (gap_windows) milik run backfill: sukses → dibuang; gagal → `run_id` dilepas agar scheduler mencoba lagi
 * (CONNECTOR_SPEC §7; umur maksimum celah = I-24).
 */
export async function settleGap(tx: Tx, planId: string, runId: string, ok: boolean): Promise<void> {
  await tx.execute(sql`update crawl_plans set gap_windows = coalesce((
      select jsonb_agg(case when g->>'run_id' = ${runId} then g - 'run_id' else g end)
      from jsonb_array_elements(gap_windows) g
      where not (${ok} and g->>'run_id' = ${runId})), '[]'::jsonb)
    where id = ${planId} and gap_windows @> ${JSON.stringify([{ run_id: runId }])}::text::jsonb`);
}

export interface FinalizedRun {
  runId: string;
  outcome: "succeeded" | "partial";
  tenantId: string | null;
  planId: string | null;
}

/**
 * Tutup run bila semua pekerjaan hilir selesai: status `processing` & `pending_batches = 0` (di bawah row lock).
 * succeeded → high_watermark maju ke max(published_at) item diterima; partial → celah [window_from, min(published_at)]
 * masuk gap_windows dan watermark TIDAK maju (CONNECTOR_SPEC §7, P-18). Plan dibebaskan.
 */
export async function finalizeRunIfDone(tx: Tx, runId: string, now = new Date()): Promise<FinalizedRun | null> {
  const [r] =
    (await tx.execute(sql`select id, scheduled_for::text as sf, status, pending_batches, error_code, crawl_plan_id, tenant_id, kind,
      window_from, window_to, min_published_at, max_published_at
    from crawl_runs where id = ${runId} for update`)) as unknown as {
      id: string;
      sf: string;
      status: string;
      pending_batches: number;
      error_code: string | null;
      crawl_plan_id: string | null;
      tenant_id: string | null;
      kind: string;
      window_from: Date | null;
      window_to: Date | null;
      min_published_at: Date | null;
      max_published_at: Date | null;
    }[];
  if (!r || r.status !== "processing" || r.pending_batches > 0) return null;
  const outcome = r.error_code ? "partial" : "succeeded";
  // scheduled_for via teks: Date JS hanya milidetik, timestamptz Postgres mikrodetik → perbandingan Date bisa meleset
  await tx.execute(sql`update crawl_runs set status = ${outcome}::e_run_status, finished_at = ${now.toISOString()}::timestamptz
    where id = ${r.id} and scheduled_for = ${r.sf}::timestamptz`);
  if (r.crawl_plan_id) {
    if (outcome === "succeeded") {
      await tx.execute(sql`update crawl_plans set consecutive_failures = 0, updated_at = now(),
          inflight_run_id = case when inflight_run_id = ${r.id} then null else inflight_run_id end,
          high_watermark = case when ${r.kind} = 'incremental' and ${r.max_published_at?.toISOString() ?? null}::timestamptz is not null
                                then greatest(coalesce(high_watermark, '-infinity'), ${r.max_published_at?.toISOString() ?? null}::timestamptz)
                                else high_watermark end
        where id = ${r.crawl_plan_id}`);
      await settleGap(tx, r.crawl_plan_id, r.id, true);
    } else {
      // item terbaru sudah diterima; yang hilang = rentang lebih lama sampai item terlama yang diterima
      const gap = r.window_from
        ? [
            {
              since: r.window_from.toISOString(),
              until: (r.min_published_at ?? r.window_to ?? now).toISOString(),
              created_at: now.toISOString(),
            },
          ]
        : [];
      await tx.execute(sql`update crawl_plans set updated_at = now(),
          inflight_run_id = case when inflight_run_id = ${r.id} then null else inflight_run_id end,
          gap_windows = gap_windows || ${JSON.stringify(r.kind === "incremental" ? gap : [])}::text::jsonb
        where id = ${r.crawl_plan_id}`);
      await settleGap(tx, r.crawl_plan_id, r.id, false);
    }
  }
  return { runId: r.id, outcome, tenantId: r.tenant_id, planId: r.crawl_plan_id };
}

/** Baris gazetteer (geo_regions) untuk worker-pipeline. */
export async function loadGeoRegions(db: Db): Promise<{ code: string; name: string; aliases: string[] }[]> {
  return (await withSystem(db, (tx) => tx.execute(sql`select code, name, aliases from geo_regions order by code`))) as unknown as {
    code: string;
    name: string;
    aliases: string[];
  }[];
}

/** Ledger idempotensi: true = pesan ini belum pernah diproses (klaim berhasil, ikut transaksi pemanggil). */
export async function claimMessage(tx: Tx, key: string): Promise<boolean> {
  const r = (await tx.execute(
    sql`insert into processed_messages (key) values (${key}) on conflict (key) do nothing returning key`,
  )) as unknown as unknown[];
  return r.length === 1;
}
