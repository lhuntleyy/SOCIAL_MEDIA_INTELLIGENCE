// I-10/I-11: efek keputusan router yang menyentuh Postgres. Setiap perubahan config ditulis bersama outbox
// dalam satu transaksi → snapshot router di semua worker ter-invalidasi (I-06).
import { sql } from "drizzle-orm";
import { type Db, withSystem } from "./client";
import { writeOutbox } from "./outbox";

/** AUTH_INVALID / CHALLENGE_REQUIRED / FORBIDDEN → akun `needs_attention` (manual). */
export async function markAccountAttention(db: Db, accountId: string, reason: string): Promise<void> {
  await withSystem(db, async (tx) => {
    await tx.execute(
      sql`update provider_accounts set status = 'needs_attention', attention_reason = ${reason}, updated_at = now() where id = ${accountId} and status <> 'revoked'`,
    );
    await writeOutbox(tx, {
      aggregate: "provider_account",
      aggregateId: accountId,
      eventType: "account.needs_attention",
      payload: { reason },
    });
  });
}

/** BLOCKED → cooldown panjang; akun kembali eligible otomatis setelah `until` (router memeriksa cooldown_until). */
export async function setAccountCooldown(db: Db, accountId: string, until: Date, reason: string): Promise<void> {
  await withSystem(db, async (tx) => {
    await tx.execute(
      sql`update provider_accounts set status = 'cooling_down', cooldown_until = ${until.toISOString()}::timestamptz, attention_reason = ${reason}, updated_at = now() where id = ${accountId} and status = 'active'`,
    );
    await writeOutbox(tx, {
      aggregate: "provider_account",
      aggregateId: accountId,
      eventType: "account.cooldown",
      payload: { reason, until: until.toISOString() },
    });
  });
}

/** Sweeper: akun `cooling_down` yang cooldown-nya lewat → `active` lagi. */
export async function reactivateCooledAccounts(db: Db): Promise<number> {
  return withSystem(db, async (tx) => {
    const rows = (await tx.execute(
      sql`update provider_accounts set status = 'active', updated_at = now() where status = 'cooling_down' and cooldown_until <= now() returning id`,
    )) as unknown as { id: string }[];
    for (const r of rows) await writeOutbox(tx, { aggregate: "provider_account", aggregateId: r.id, eventType: "account.reactivated" });
    return rows.length;
  });
}

/** NOT_SUPPORTED → capability `failed` (tereliminasi di snapshot berikutnya). */
export async function markCapabilityFailed(db: Db, connectorId: string, operation: string): Promise<void> {
  await withSystem(db, async (tx) => {
    await tx.execute(
      sql`update connector_capabilities set status = 'failed' where connector_id = ${connectorId} and operation = ${operation}`,
    );
    await writeOutbox(tx, {
      aggregate: "connector_capability",
      aggregateId: connectorId,
      eventType: "capability.failed",
      payload: { operation },
    });
  });
}

export interface ProviderHealthRow {
  connectorId: string;
  accountId: string | null;
  state: "healthy" | "degraded" | "unhealthy" | "unknown";
  circuit: "closed" | "open" | "half_open";
  score: number | null;
  successRate5m: number | null;
  p95LatencyMs: number | null;
  lastErrorCode: string | null;
  openedAt: Date | null;
  nextProbeAt: Date | null;
}

const NO_ACCOUNT = "00000000-0000-0000-0000-000000000000";

/** worker-health (tiap 30 s): tulis ringkasan health; transisi circuit juga dicatat di health_checks. */
export async function upsertProviderHealth(
  db: Db,
  rows: ProviderHealthRow[],
  transitions: {
    connectorId: string;
    accountId: string | null;
    ok: boolean;
    kind: "active" | "passive_window";
    errorCode?: string;
    details?: Record<string, unknown>;
  }[] = [],
): Promise<void> {
  if (!rows.length && !transitions.length) return;
  await withSystem(db, async (tx) => {
    for (const r of rows) {
      await tx.execute(sql`
        insert into provider_health (connector_id, provider_account_key, state, circuit, score, success_rate_5m, p95_latency_ms, last_error_code, opened_at, next_probe_at, updated_at)
        values (${r.connectorId}, ${r.accountId ?? NO_ACCOUNT}, ${r.state}::e_health, ${r.circuit}::e_circuit, ${r.score}, ${r.successRate5m}, ${r.p95LatencyMs}, ${r.lastErrorCode},
                ${r.openedAt?.toISOString() ?? null}::timestamptz, ${r.nextProbeAt?.toISOString() ?? null}::timestamptz, now())
        on conflict (connector_id, provider_account_key) do update set
          state = excluded.state, circuit = excluded.circuit, score = excluded.score, success_rate_5m = excluded.success_rate_5m,
          p95_latency_ms = excluded.p95_latency_ms, last_error_code = coalesce(excluded.last_error_code, provider_health.last_error_code),
          opened_at = excluded.opened_at, next_probe_at = excluded.next_probe_at, updated_at = now()`);
    }
    for (const t of transitions) {
      await tx.execute(sql`
        insert into health_checks (id, connector_id, provider_account_id, kind, at, ok, error_code, details)
        values (${Bun.randomUUIDv7()}, ${t.connectorId}, ${t.accountId}, ${t.kind}, now(), ${t.ok}, ${t.errorCode ?? null}, ${t.details ?? {}})`);
    }
  });
}
