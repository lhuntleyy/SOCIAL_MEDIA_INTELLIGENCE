// I-06: pemuat snapshot routing dari Postgres (sebagai smip_system — lintas tenant: policy global + tenant,
// akun shared pool + BYO). Dipakai router lewat port `SnapshotLoader` (router tidak mengimpor @smip/db).
import type { Account, ConnectorInfo, Policy, QuotaRule, RateLimit, RoutingSnapshot } from "@smip/core";
import { policyKey, scopeKey } from "@smip/core";
import { sql } from "drizzle-orm";
import { type Db, withSystem } from "./client";

type Row = Record<string, unknown>;
const q = async (db: Db, query: ReturnType<typeof sql>) => (await withSystem(db, (tx) => tx.execute(query))) as unknown as Row[];
const num = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));

export async function loadRoutingSnapshot(db: Db, version: number): Promise<RoutingSnapshot> {
  const [providers, connectors, caps, policies, rules, accounts, rls, quotas] = await Promise.all([
    q(db, sql`select id, enabled from providers`),
    q(db, sql`select id, key, provider_id, platform_code, runtime, enabled from connectors`),
    q(db, sql`select connector_id, operation, status, declared, measured from connector_capabilities`),
    q(
      db,
      sql`select id, tenant_id, platform_code, operation, strategy, failover_enabled, max_attempts, allow_unverified, enabled, version from routing_policies`,
    ),
    q(db, sql`select id, policy_id, connector_id, priority, weight, enabled, max_share_pct, conditions from routing_rules`),
    q(db, sql`select id, tenant_id, provider_id, label, status, cooldown_until, allowed_connector_ids from provider_accounts`),
    q(
      db,
      sql`select id, scope_type, scope_id, algorithm, capacity, refill_tokens, refill_interval_ms from rate_limit_policies where enabled`,
    ),
    q(
      db,
      sql`select id, scope_type, scope_id, period, unit, limit_value, hard, alert_thresholds, reset_tz from quota_policies where enabled`,
    ),
  ]);
  const provEnabled = new Map(providers.map((p) => [String(p.id), Boolean(p.enabled)]));
  const cmap = new Map<string, ConnectorInfo>();
  for (const c of connectors) {
    cmap.set(String(c.id), {
      id: String(c.id),
      key: String(c.key),
      providerId: String(c.provider_id),
      providerEnabled: provEnabled.get(String(c.provider_id)) ?? false,
      platform: String(c.platform_code),
      runtime: c.runtime as "bun" | "python",
      enabled: Boolean(c.enabled),
      capabilities: new Map(),
    });
  }
  for (const cap of caps) {
    const d = (cap.declared ?? {}) as { query_features?: string[] };
    const m = (cap.measured ?? {}) as {
      min_interval_sec?: number;
      p95_latency_ms?: number;
      cost_per_1k_results?: number;
      fixed_cost_per_run?: number;
    };
    cmap.get(String(cap.connector_id))?.capabilities.set(String(cap.operation), {
      status: cap.status as "declared",
      queryFeatures: (d.query_features ?? []) as never,
      measured: {
        minIntervalSec: num(m.min_interval_sec),
        p95LatencyMs: num(m.p95_latency_ms),
        costPer1kResults: num(m.cost_per_1k_results),
      },
    });
  }
  const pmap = new Map<string, Policy>();
  const byId = new Map<string, Policy>();
  for (const p of policies) {
    const pol: Policy = {
      id: String(p.id),
      tenantId: (p.tenant_id as string | null) ?? null,
      platform: String(p.platform_code),
      operation: String(p.operation),
      strategy: p.strategy as Policy["strategy"],
      failoverEnabled: Boolean(p.failover_enabled),
      maxAttempts: Number(p.max_attempts),
      allowUnverified: Boolean(p.allow_unverified),
      enabled: Boolean(p.enabled),
      version: Number(p.version),
      rules: [],
    };
    pmap.set(policyKey(pol.tenantId, pol.platform, pol.operation), pol);
    byId.set(pol.id, pol);
  }
  for (const r of rules) {
    const cond = (r.conditions ?? {}) as { run_kinds?: string[] };
    byId.get(String(r.policy_id))?.rules.push({
      id: String(r.id),
      connectorId: String(r.connector_id),
      priority: Number(r.priority),
      weight: Number(r.weight),
      enabled: Boolean(r.enabled),
      maxSharePct: num(r.max_share_pct) ?? null,
      runKinds: cond.run_kinds ?? null,
    });
  }
  const accountsByProvider = new Map<string, Account[]>();
  for (const a of accounts) {
    const acc: Account = {
      id: String(a.id),
      tenantId: (a.tenant_id as string | null) ?? null,
      providerId: String(a.provider_id),
      label: String(a.label),
      status: a.status as Account["status"],
      cooldownUntil: a.cooldown_until ? new Date(a.cooldown_until as string) : null,
      allowedConnectorIds: (a.allowed_connector_ids as string[] | null) ?? null,
    };
    accountsByProvider.set(acc.providerId, [...(accountsByProvider.get(acc.providerId) ?? []), acc]);
  }
  const rateLimits = new Map<string, RateLimit[]>();
  for (const r of rls) {
    const rl: RateLimit = {
      id: String(r.id),
      scopeType: r.scope_type as RateLimit["scopeType"],
      scopeId: String(r.scope_id),
      algorithm: r.algorithm as RateLimit["algorithm"],
      capacity: Number(r.capacity),
      refillTokens: Number(r.refill_tokens),
      refillIntervalMs: Number(r.refill_interval_ms),
    };
    const k = scopeKey(rl.scopeType, rl.scopeId);
    rateLimits.set(k, [...(rateLimits.get(k) ?? []), rl]);
  }
  const quotaMap = new Map<string, QuotaRule[]>();
  for (const r of quotas) {
    const qr: QuotaRule = {
      id: String(r.id),
      scopeType: r.scope_type as QuotaRule["scopeType"],
      scopeId: (r.scope_id as string | null) ?? null,
      period: r.period as QuotaRule["period"],
      unit: r.unit as QuotaRule["unit"],
      limit: Number(r.limit_value),
      hard: Boolean(r.hard),
      alertThresholds: ((r.alert_thresholds as number[] | null) ?? []).map(Number),
      resetTz: String(r.reset_tz),
    };
    const k = scopeKey(qr.scopeType, qr.scopeId);
    quotaMap.set(k, [...(quotaMap.get(k) ?? []), qr]);
  }
  return { version, loadedAt: new Date(), policies: pmap, connectors: cmap, accountsByProvider, rateLimits, quotas: quotaMap };
}
