// Snapshot konfigurasi routing (I-06): DTO murni yang dimuat adapter DB (packages/db routing-snapshot.ts)
// dan dibaca router di memori. Ditaruh di core agar router tidak bergantung pada @smip/db (ARCHITECTURE §6).
import type { QueryFeature } from "@smip/contracts";

export type CapabilityStatus = "declared" | "verified" | "failed" | "deprecated";

export interface Capability {
  status: CapabilityStatus;
  queryFeatures: QueryFeature[];
  /** declared.max_query_length (batas teknis compiler); null = tak diketahui. */
  maxQueryLength: number | null;
  /** Diukur connector.verify: min_interval_sec, p95_latency_ms, fixed_cost_per_run, cost_per_1k_results. */
  measured: { minIntervalSec?: number; p95LatencyMs?: number; costPer1kResults?: number; fixedCostPerRun?: number };
}

export interface ConnectorInfo {
  id: string;
  key: string;
  providerId: string;
  providerEnabled: boolean;
  /** providers.risk_level = high (unofficial) — tenant yang opt-out tidak pernah dilayani connector ini (I-19). */
  providerHighRisk?: boolean;
  platform: string;
  runtime: "bun" | "python";
  version: string;
  enabled: boolean;
  capabilities: Map<string, Capability>;
}

export interface Rule {
  id: string;
  connectorId: string;
  priority: number;
  weight: number;
  enabled: boolean;
  maxSharePct: number | null;
  runKinds: string[] | null;
}

export interface Policy {
  id: string;
  tenantId: string | null;
  platform: string;
  operation: string;
  strategy: "priority_weighted" | "round_robin" | "cost_aware";
  failoverEnabled: boolean;
  maxAttempts: number;
  allowUnverified: boolean;
  enabled: boolean;
  version: number;
  rules: Rule[];
}

export interface Account {
  id: string;
  tenantId: string | null;
  providerId: string;
  label: string;
  status: "active" | "disabled" | "cooling_down" | "needs_attention" | "revoked";
  cooldownUntil: Date | null;
  allowedConnectorIds: string[] | null;
}

/** rate_limit_policies (DATA_MODEL §4). `concurrency` → semaphore; `fixed_window` diperlakukan sebagai token bucket (batas atas sama: ≤ 2×capacity per jendela). */
export interface RateLimit {
  id: string;
  scopeType: "provider" | "connector" | "provider_account";
  scopeId: string;
  algorithm: "token_bucket" | "fixed_window" | "concurrency";
  capacity: number;
  refillTokens: number;
  refillIntervalMs: number;
}

export type QuotaScope = "global" | "tenant" | "topic" | "provider" | "connector" | "provider_account";
export type QuotaUnit = "requests" | "results" | "cost_units";
export interface QuotaRule {
  id: string;
  scopeType: QuotaScope;
  /** null hanya untuk scope global. */
  scopeId: string | null;
  period: "day" | "month";
  unit: QuotaUnit;
  limit: number;
  hard: boolean;
  alertThresholds: number[];
  resetTz: string;
}

export const scopeKey = (scopeType: string, scopeId: string | null) => `${scopeType}:${scopeId ?? GLOBAL}`;

export interface RoutingSnapshot {
  version: number;
  loadedAt: Date;
  policies: Map<string, Policy>;
  connectors: Map<string, ConnectorInfo>;
  accountsByProvider: Map<string, Account[]>;
  /** Kunci `scopeKey(scopeType, scopeId)`. Hanya policy enabled. */
  rateLimits: Map<string, RateLimit[]>;
  quotas: Map<string, QuotaRule[]>;
  /** Tenant dengan `settings.deny_high_risk_providers = true` (PROVIDER_MATRIX §3: unofficial bisa dimatikan per tenant). */
  highRiskOptOut?: Set<string>;
}

export const GLOBAL = "*";
export const policyKey = (tenantId: string | null, platform: string, operation: string) => `${tenantId ?? GLOBAL}|${platform}|${operation}`;
