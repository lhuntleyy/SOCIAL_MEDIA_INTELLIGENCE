// I-10: error taxonomy → keputusan failover (CONNECTOR_SPEC §7). Fungsi murni: mengembalikan keputusan +
// daftar efek (data) yang dieksekusi adapter (`applyEffects`) — mudah diuji & diaudit.
import type { ConnectorErrorCode } from "@smip/contracts";
import type { AttemptOutcome, FailoverDecision } from "@smip/core";

export interface AttemptState {
  /** Nomor attempt yang baru selesai (1-based), dihitung per run lintas connector. */
  attempt: number;
  maxAttempts: number;
  failoverEnabled: boolean;
  /** Berapa kali connector yang sama sudah di-retry untuk run ini. */
  sameRetries: number;
  /** Query sudah pernah di-compile ulang (decompose) untuk run ini. */
  recompiled: boolean;
  operation: string;
}

export interface FailoverConfig {
  /** Default Retry-After bila provider tidak memberi (RATE_LIMITED). */
  defaultThrottleMs: number;
  /** QUOTA_EXHAUSTED tanpa waktu reset dari provider → tandai penuh selama ini. */
  quotaFullMs: number;
  /** BLOCKED → cooldown panjang (config). */
  blockedCooldownMs: number;
  retrySameBaseMs: number;
  asyncPollMs: number;
}
export const DEFAULT_FAILOVER: FailoverConfig = {
  defaultThrottleMs: 60_000,
  quotaFullMs: 3_600_000,
  blockedCooldownMs: 6 * 3_600_000,
  retrySameBaseMs: 2_000,
  asyncPollMs: 30_000,
};

export type Effect =
  | { kind: "throttle"; scopeId: string; ms: number }
  | { kind: "account_attention"; accountId: string; code: ConnectorErrorCode }
  | { kind: "account_cooldown"; accountId: string; ms: number; code: ConnectorErrorCode }
  | { kind: "capability_failed"; connectorId: string; operation: string }
  | {
      kind: "alert";
      event: "account_needs_attention" | "account_blocked" | "schema_drift";
      connectorId: string;
      accountId: string;
      code: ConnectorErrorCode;
    };

export interface FailoverResult {
  decision: FailoverDecision;
  effects: Effect[];
  /** Bobot failure untuk passive health window (§8.1): 0 = tidak dihitung, PARSE_ERROR = 2. */
  healthFailure: 0 | 1 | 2;
}

const HEALTH_WEIGHT: Record<ConnectorErrorCode, 0 | 1 | 2> = {
  RATE_LIMITED: 0,
  QUOTA_EXHAUSTED: 0,
  AUTH_INVALID: 1,
  CHALLENGE_REQUIRED: 1,
  FORBIDDEN: 0,
  BLOCKED: 1,
  NOT_SUPPORTED: 0,
  INVALID_QUERY: 0,
  UPSTREAM_5XX: 1,
  TIMEOUT: 1,
  NETWORK: 1,
  PARSE_ERROR: 2,
  ASYNC_PENDING: 0,
  UNKNOWN: 1,
};

export function decideFailover(o: AttemptOutcome, s: AttemptState, cfg: FailoverConfig = DEFAULT_FAILOVER): FailoverResult {
  if (o.ok) return { decision: { action: "done" }, effects: [], healthFailure: 0 };
  const code: ConnectorErrorCode = o.errorCode ?? "UNKNOWN";
  const effects: Effect[] = [];
  const acct = { excludeAccountId: o.accountId, delayMs: 0 };
  const conn = { excludeConnectorId: o.connectorId, delayMs: 0 };
  let next: FailoverDecision;

  switch (code) {
    case "ASYNC_PENDING":
      // bukan error: tidak memakan attempt
      return { decision: { action: "resume", delayMs: o.retryAfterMs ?? cfg.asyncPollMs }, effects, healthFailure: 0 };
    case "RATE_LIMITED":
      effects.push({ kind: "throttle", scopeId: o.accountId, ms: o.retryAfterMs ?? cfg.defaultThrottleMs });
      next = { action: "failover", ...acct };
      break;
    case "QUOTA_EXHAUSTED": {
      const scopeId = o.errorScope === "connector" ? o.connectorId : o.accountId;
      effects.push({ kind: "throttle", scopeId, ms: o.retryAfterMs ?? cfg.quotaFullMs });
      next = { action: "failover", ...(o.errorScope === "connector" ? conn : acct) };
      break;
    }
    case "AUTH_INVALID":
    case "CHALLENGE_REQUIRED":
    case "FORBIDDEN":
      // CHALLENGE: manual, tidak ada retry otomatis pada akun ini
      effects.push({ kind: "account_attention", accountId: o.accountId, code });
      if (code !== "FORBIDDEN")
        effects.push({ kind: "alert", event: "account_needs_attention", connectorId: o.connectorId, accountId: o.accountId, code });
      next = { action: "failover", ...acct };
      break;
    case "BLOCKED":
      effects.push({ kind: "account_cooldown", accountId: o.accountId, ms: cfg.blockedCooldownMs, code });
      effects.push({ kind: "alert", event: "account_blocked", connectorId: o.connectorId, accountId: o.accountId, code });
      next = { action: "failover", ...acct };
      break;
    case "NOT_SUPPORTED":
      effects.push({ kind: "capability_failed", connectorId: o.connectorId, operation: s.operation });
      next = { action: "failover", ...conn };
      break;
    case "INVALID_QUERY":
      if (!s.recompiled) return { decision: { action: "recompile" }, effects, healthFailure: 0 };
      return { decision: { action: "fail", reason: "INVALID_QUERY" }, effects, healthFailure: 0 };
    case "UPSTREAM_5XX":
    case "NETWORK":
      next =
        s.sameRetries < 1 ? { action: "retry_same", delayMs: cfg.retrySameBaseMs * 2 ** s.sameRetries } : { action: "failover", ...conn };
      break;
    case "PARSE_ERROR":
      effects.push({ kind: "alert", event: "schema_drift", connectorId: o.connectorId, accountId: o.accountId, code });
      next = { action: "failover", ...conn };
      break;
    default: // TIMEOUT, UNKNOWN
      next = { action: "failover", ...conn };
  }

  if (next.action === "failover" && !s.failoverEnabled) next = { action: "fail", reason: `${code}: failover dimatikan` };
  if ((next.action === "failover" || next.action === "retry_same") && s.attempt >= s.maxAttempts) {
    next = { action: "fail", reason: `${code}: max_attempts (${s.maxAttempts}) habis` };
  }
  return { decision: next, effects, healthFailure: HEALTH_WEIGHT[code] };
}

/** R-08: backoff eksponensial `next_run_at` setelah run gagal, cap 4× interval (CONNECTOR_SPEC §7). */
export function failureBackoffSec(intervalSec: number, consecutiveFailures: number): number {
  const n = Math.max(1, consecutiveFailures);
  return Math.min(intervalSec * 2 ** (n - 1), intervalSec * 4);
}
/** Alert bila gagal ≥ 3 kali berturut-turut. */
export const shouldAlertConsecutive = (consecutiveFailures: number) => consecutiveFailures >= 3;

/** Port eksekusi efek (diisi adapter: Redis rl:dyn, Postgres provider_accounts/connector_capabilities, event alert). */
export interface EffectSink {
  throttle(scopeId: string, ms: number): Promise<void>;
  accountAttention(accountId: string, code: ConnectorErrorCode): Promise<void>;
  accountCooldown(accountId: string, untilMs: number, code: ConnectorErrorCode): Promise<void>;
  capabilityFailed(connectorId: string, operation: string): Promise<void>;
  alert(e: Extract<Effect, { kind: "alert" }>): Promise<void>;
}

export async function applyEffects(effects: Effect[], sink: EffectSink, now = Date.now()): Promise<void> {
  for (const e of effects) {
    if (e.kind === "throttle") await sink.throttle(e.scopeId, e.ms);
    else if (e.kind === "account_attention") await sink.accountAttention(e.accountId, e.code);
    else if (e.kind === "account_cooldown") await sink.accountCooldown(e.accountId, now + e.ms, e.code);
    else if (e.kind === "capability_failed") await sink.capabilityFailed(e.connectorId, e.operation);
    else await sink.alert(e);
  }
}
