// Outbox transaksional (ARCHITECTURE §9): perubahan config ditulis BERSAMA baris outbox dalam satu transaksi;
// publisher (worker-ops, loop) mengirimnya ke Redis pub/sub `config.changed` + INCR `cfg:version`
// → semua worker meng-invalidate cache (FR-P02: berlaku ≤ 30 s tanpa restart).
import { sql } from "drizzle-orm";
import type { Db, Tx } from "./client";
import { withSystem } from "./client";

export const CONFIG_CHANNEL = "config.changed";
export const CONFIG_VERSION_KEY = "cfg:version";
/** Aggregate yang memengaruhi snapshot router/worker. */
export const CONFIG_AGGREGATES = new Set([
  "provider",
  "connector",
  "connector_capability",
  "provider_account",
  "routing_policy",
  "rate_limit_policy",
  "quota_policy",
  "tenant", // settings.deny_high_risk_providers (I-19)
]);

export interface OutboxEvent {
  aggregate: string;
  aggregateId: string;
  eventType: string;
  payload?: Record<string, unknown>;
}

/** Payload dikirim sebagai objek mentah — Bun.SQL meng-encode jsonb sendiri (stringify di sini = encode ganda, F14). */
export async function writeOutbox(tx: Tx, e: OutboxEvent): Promise<void> {
  await tx.execute(
    sql`insert into outbox (aggregate, aggregate_id, event_type, payload) values (${e.aggregate}, ${e.aggregateId}, ${e.eventType}, ${e.payload ?? {}})`,
  );
}

export interface PubSub {
  publish(channel: string, message: string): Promise<unknown>;
  incr(key: string): Promise<number>;
}

/** Job yang harus di-enqueue ATOMIK bersama perubahan DB (mis. crawl_runs baru → crawl.dispatch; QUEUE_SPEC §6). */
export interface OutboxJob {
  queue: string;
  /** = jobId BullMQ → publish ulang setelah crash tidak menggandakan job. */
  idempotencyKey: string;
  type: string;
  tenantId: string | null;
  payload: unknown;
  priority?: number;
  delayMs?: number;
}
export const JOB_AGGREGATE = "job";

export async function writeJobOutbox(tx: Tx, aggregateId: string, job: OutboxJob): Promise<void> {
  await writeOutbox(tx, {
    aggregate: JOB_AGGREGATE,
    aggregateId,
    eventType: `enqueue.${job.queue}`,
    payload: job as unknown as Record<string, unknown>,
  });
}

export interface PublishOptions {
  batch?: number;
  /** Relay job ke queue. Tanpa ini baris `job` DIBIARKAN (tidak ditandai published) untuk relay lain. */
  enqueue?: (jobs: OutboxJob[]) => Promise<void>;
}

/**
 * Satu putaran publish (loop scheduler/worker-ops tiap ~1 s). Aman paralel (SKIP LOCKED).
 * Enqueue terjadi sebelum commit penanda published: crash di antaranya → publish ulang → jobId sama → diabaikan BullMQ.
 */
export async function publishOutbox(db: Db, bus: PubSub, opts: PublishOptions | number = {}): Promise<number> {
  const o = typeof opts === "number" ? { batch: opts } : opts;
  return withSystem(db, async (tx) => {
    const rows = (await tx.execute(
      sql`select id, aggregate, aggregate_id, event_type, payload from outbox
          where published_at is null ${o.enqueue ? sql`` : sql`and aggregate <> ${JOB_AGGREGATE}`}
          order by id limit ${o.batch ?? 100} for update skip locked`,
    )) as unknown as { id: string | number; aggregate: string; aggregate_id: string; event_type: string; payload: unknown }[];
    if (!rows.length) return 0;
    const jobs = rows.filter((r) => r.aggregate === JOB_AGGREGATE);
    if (jobs.length) await o.enqueue!(jobs.map((r) => r.payload as OutboxJob));
    let configChanged = false;
    for (const r of rows) {
      if (r.aggregate === JOB_AGGREGATE) continue;
      if (CONFIG_AGGREGATES.has(r.aggregate)) configChanged = true;
      await bus.publish(CONFIG_CHANNEL, JSON.stringify({ aggregate: r.aggregate, id: r.aggregate_id, event: r.event_type }));
    }
    if (configChanged) await bus.incr(CONFIG_VERSION_KEY);
    const ids = rows.map((r) => Number(r.id));
    await tx.execute(sql`update outbox set published_at = now() where id in ${ids}`);
    return rows.length;
  });
}
