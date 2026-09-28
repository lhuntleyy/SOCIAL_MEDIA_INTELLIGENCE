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

/** Satu putaran publish (dipanggil loop worker-ops tiap ~1 s). Aman paralel (SKIP LOCKED). */
export async function publishOutbox(db: Db, bus: PubSub, batch = 100): Promise<number> {
  return withSystem(db, async (tx) => {
    const rows = (await tx.execute(
      sql`select id, aggregate, aggregate_id, event_type, payload from outbox where published_at is null order by id limit ${batch} for update skip locked`,
    )) as unknown as { id: string | number; aggregate: string; aggregate_id: string; event_type: string; payload: unknown }[];
    if (!rows.length) return 0;
    let configChanged = false;
    for (const r of rows) {
      if (CONFIG_AGGREGATES.has(r.aggregate)) configChanged = true;
      await bus.publish(CONFIG_CHANNEL, JSON.stringify({ aggregate: r.aggregate, id: r.aggregate_id, event: r.event_type }));
    }
    if (configChanged) await bus.incr(CONFIG_VERSION_KEY);
    const ids = rows.map((r) => Number(r.id));
    await tx.execute(sql`update outbox set published_at = now() where id in ${ids}`);
    return rows.length;
  });
}
