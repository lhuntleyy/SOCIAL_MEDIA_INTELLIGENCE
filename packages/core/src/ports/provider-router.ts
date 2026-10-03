// Port router provider (CONNECTOR_SPEC §6.1). Core hanya kenal platform + operation (Golden Rule 2);
// implementasi (policy, health, rate limit, quota) di packages/router.
import type { ConnectorErrorCode, Operation, QueryFeature } from "@smip/contracts";

export type RunKind = "incremental" | "backfill" | "engagement_refresh" | "verify" | "comments";

export interface RouteInput {
  tenantId: string;
  platform: string;
  operation: Operation;
  runKind: RunKind;
  requiredFeatures: QueryFeature[];
  intervalSec: number;
  excludeConnectorIds: string[];
  excludeAccountIds: string[];
  /** Estimasi untuk reservasi kuota (dikoreksi saat commit). */
  estimatedUnits: { requests: number; results: number };
  /** Untuk quota scope `topic` (null pada run collection stream). */
  topicId?: string | null;
  /** Collection stream lintas tenant: hanya akun shared pool (R-15). */
  sharedPoolOnly?: boolean;
  /** true = connector provider berisiko tinggi dilarang (run shared yang melayani tenant opt-out, I-19). */
  denyHighRisk?: boolean;
}

export type NoRouteReason = "NO_POLICY" | "POLICY_DISABLED" | "NO_CANDIDATE" | "ALL_THROTTLED" | "ALL_UNHEALTHY" | "QUOTA_EXHAUSTED";

/** Alasan eliminasi per kandidat — dipakai routing simulator (API_SPEC §9 simulate). */
export type EliminationReason =
  | "RULE_DISABLED"
  | "CONNECTOR_DISABLED"
  | "PROVIDER_DISABLED"
  | "RUN_KIND_MISMATCH"
  | "EXCLUDED"
  | "CAPABILITY_MISSING"
  | "CAPABILITY_NOT_VERIFIED"
  | "CAPABILITY_FAILED"
  | "FEATURES_UNSUPPORTED"
  | "INTERVAL_TOO_SHORT"
  | "SHARE_CAP"
  | "NO_ELIGIBLE_ACCOUNT"
  | "STANDBY"
  | "TENANT_RISK_OPT_OUT";

export type RouteDecision =
  | {
      kind: "selected";
      connectorId: string;
      connectorKey: string;
      runtime: "bun" | "python";
      accountId: string;
      reservationId: string;
      ruleId: string;
      policyId: string;
    }
  | { kind: "none_available"; reason: NoRouteReason; retryAfterMs: number };

export interface AttemptOutcome {
  reservationId: string;
  connectorId: string;
  accountId: string;
  ok: boolean;
  errorCode?: ConnectorErrorCode;
  /** `ConnectorError.scope` — menentukan exclude account vs connector (mis. QUOTA_EXHAUSTED). */
  errorScope?: "request" | "account" | "connector";
  retryAfterMs?: number;
  latencyMs: number;
  usage?: { requests: number; results: number; costUnits: number | null };
}

export type FailoverDecision =
  | { action: "done" }
  | { action: "failover"; excludeConnectorId?: string; excludeAccountId?: string; delayMs: number }
  | { action: "retry_same"; delayMs: number }
  | { action: "recompile" }
  | { action: "fail"; reason: string }
  | { action: "resume"; delayMs: number };

/** Konteks run untuk keputusan failover (dilacak worker-dispatch per run). */
export interface AttemptContext {
  policyId: string;
  operation: Operation;
  /** Nomor attempt yang baru selesai (1-based), lintas connector dalam satu run. */
  attempt: number;
  /** Retry pada connector yang sama untuk run ini. */
  sameRetries: number;
  recompiled: boolean;
}

export interface ProviderRouter {
  plan(input: RouteInput): Promise<RouteDecision>;
  reportOutcome(o: AttemptOutcome, ctx: AttemptContext): Promise<FailoverDecision>;
}
