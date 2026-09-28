// Pembuatan crawl_run + job `crawl.dispatch` via outbox dalam transaksi pemanggil (scheduler tick, API backfill).
import type { CrawlDispatchPayload } from "@smip/contracts";
import { sql } from "drizzle-orm";
import type { Tx } from "./client";
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
