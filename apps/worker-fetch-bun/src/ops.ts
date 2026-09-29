// Konsumen job operasional dari Admin API (I-21) — review 2026-09-30: sebelumnya job di-enqueue tanpa konsumen.
//   health.probe     → healthProbe() connector untuk ≤ 5 akun aktif → HealthMonitor (circuit) → provider_health via refresh
//   connector.verify → runVerify (provider SUNGGUHAN) → laporan JSON di blob `verify/…` + (apply) capability status/measured
// Connector di luar registry worker ini (runtime python) → dilaporkan NOT_SUPPORTED (probe unofficial = pasif, CONNECTOR_SPEC §8.2).
import { type Connector, ConnectorError, HttpClient } from "@smip/connector-sdk";
import type { ConnectorVerifyPayload, HealthProbePayload } from "@smip/contracts";
import { type Db, withSystem, writeOutbox } from "@smip/db";
import type { Logger } from "@smip/observability";
import type { HealthMonitor } from "@smip/router";
import type { BlobStore } from "@smip/storage";
import { sql } from "drizzle-orm";
import type { AccountLoader } from "./accounts";
import { measuredOf, runVerify, type VerifyReport } from "./verify";

export interface OpsDeps {
  db: Db;
  connectors: Map<string, Connector>;
  accounts: AccountLoader;
  blobs: BlobStore;
  monitor: Pick<HealthMonitor, "record">;
  logger?: Logger;
  verify?: typeof runVerify;
}

type ConnRow = { id: string; key: string; provider_id: string };
async function connectorAndAccounts(db: Db, connectorId: string, limit: number) {
  return withSystem(db, async (tx) => {
    const [c] = (await tx.execute(sql`select id, key, provider_id from connectors where id = ${connectorId}`)) as unknown as ConnRow[];
    if (!c) return null;
    const accs = (await tx.execute(sql`select id from provider_accounts
      where provider_id = ${c.provider_id} and status = 'active'
        and (allowed_connector_ids is null or ${connectorId}::uuid = any(allowed_connector_ids))
      order by tenant_id nulls first, created_at limit ${limit}`)) as unknown as { id: string }[];
    return { c, accounts: accs.map((a) => a.id) };
  });
}

async function audit(db: Db, action: string, targetId: string, after: unknown) {
  await withSystem(db, (tx) =>
    tx.execute(sql`insert into audit_logs (id, tenant_id, actor_type, actor_id, action, target_type, target_id, after)
      values (${Bun.randomUUIDv7()}, null, 'system', null, ${action}, 'connector', ${targetId}, ${JSON.stringify(after)}::text::jsonb)`),
  );
}

export async function handleHealthProbe(d: OpsDeps, m: HealthProbePayload) {
  const found = await connectorAndAccounts(d.db, m.connector_id, 5);
  if (!found) return { status: "not_found" as const, results: [] };
  const conn = d.connectors.get(found.c.key);
  const results: { account_id: string; ok: boolean; latency_ms: number; error_code?: string }[] = [];
  if (!conn) {
    await audit(d.db, "connector.health_check.result", m.connector_id, { job_id: m.job_id, status: "NOT_SUPPORTED_BY_RUNTIME" });
    return { status: "unsupported" as const, results };
  }
  for (const accountId of found.accounts) {
    try {
      const acc = await d.accounts(accountId, m.connector_id);
      const r = await conn.healthProbe({
        credential: acc.credential,
        config: acc.config,
        http: new HttpClient({ allowedHosts: conn.manifest.allowedHosts ?? [], timeoutMs: 20_000 }),
        logger: d.logger ?? ({ debug() {}, info() {}, warn() {}, error() {}, child: () => d.logger } as never),
        signal: AbortSignal.timeout(30_000),
        reportRateLimit: () => {},
        archiveRaw: async () => "probe://tidak-diarsip",
      });
      results.push({ account_id: accountId, ok: r.ok, latency_ms: r.latencyMs, ...(r.errorCode ? { error_code: r.errorCode } : {}) });
      // hasil probe masuk circuit breaker yang sama dgn trafik nyata (half_open → closed setelah M probe sukses)
      await d.monitor.record(m.connector_id, accountId, { ok: r.ok, latencyMs: r.latencyMs, failureWeight: r.ok ? 0 : 1 });
    } catch (e) {
      const code = e instanceof ConnectorError ? e.code : "UNKNOWN";
      results.push({ account_id: accountId, ok: false, latency_ms: 0, error_code: code });
    }
  }
  await audit(d.db, "connector.health_check.result", m.connector_id, { job_id: m.job_id, results });
  d.logger?.info("health probe", { connector: found.c.key, results: results.length, ok: results.filter((r) => r.ok).length });
  return { status: "done" as const, results };
}

export async function handleVerify(
  d: OpsDeps,
  m: ConnectorVerifyPayload,
): Promise<{ status: string; report?: VerifyReport; ref?: string }> {
  const found = await connectorAndAccounts(d.db, m.connector_id, 1);
  if (!found) return { status: "not_found" };
  const conn = d.connectors.get(found.c.key);
  if (!conn || !found.accounts[0]) {
    const status = !conn ? "NOT_SUPPORTED_BY_RUNTIME" : "NO_ACTIVE_ACCOUNT";
    await audit(d.db, "connector.verify.result", m.connector_id, { job_id: m.job_id, status });
    return { status };
  }
  const acc = await d.accounts(found.accounts[0], m.connector_id);
  const report = await (d.verify ?? runVerify)(conn, acc, {
    query: m.query,
    samples: m.samples,
    maxItems: m.max_items,
    windowHours: m.window_hours,
    operation: m.operation,
  });
  const ref = await d.blobs.putJsonl(`verify/${found.c.key}/${m.job_id}.jsonl.gz`, [report]);
  await withSystem(d.db, async (tx) => {
    if (m.apply) {
      await tx.execute(sql`update connector_capabilities set status = ${report.status}::e_verify_status,
        measured = measured || ${JSON.stringify(measuredOf(report))}::text::jsonb, verified_at = now(), evidence_ref = ${ref}
        where connector_id = ${m.connector_id} and operation = ${report.operation}`);
      await writeOutbox(tx, {
        aggregate: "connector_capability",
        aggregateId: m.connector_id,
        eventType: "capability.verified",
        payload: { status: report.status },
      });
    }
  });
  await audit(d.db, "connector.verify.result", m.connector_id, {
    job_id: m.job_id,
    status: report.status,
    applied: m.apply,
    evidence_ref: ref,
    items_valid: report.items_valid,
    cost_usd: report.cost_usd,
  });
  return { status: report.status, report, ref };
}
