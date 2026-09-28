// I-07: seleksi connector+akun (CONNECTOR_SPEC §6.2 `priority_weighted`, §6.3 round_robin/cost_aware).
// Fungsi murni atas snapshot; kesehatan, share traffic, dan reservasi (rate+quota+semaphore) disuntikkan.
import type { EliminationReason, NoRouteReason, RouteDecision, RouteInput } from "@smip/core";
import { type Account, type ConnectorInfo, type Policy, policyKey, type Rule, type Snapshot } from "./snapshot";

export interface HealthState {
  circuit: "closed" | "open" | "half_open";
  /** 0–100; null = belum ada data (unknown → diperlakukan sehat). */
  score: number | null;
  /** half_open: hanya 1 probe inflight (CONNECTOR_SPEC §6.2). */
  probeInflight?: boolean;
}
export interface HealthView {
  get(connectorId: string, accountId: string): HealthState;
  /** half_open → klaim slot probe tunggal secara atomik (HealthMonitor). Tanpa ini: hanya cek `probeInflight`. */
  claimProbe?(connectorId: string, accountId: string): Promise<boolean>;
  releaseProbe?(connectorId: string, accountId: string): Promise<void>;
}
export interface ShareView {
  /** Porsi traffic rule dalam window 1 jam (0–100). */
  sharePct(ruleId: string): number;
}
export type ReserveResult = { ok: true; reservationId: string } | { ok: false; reason: "THROTTLED" | "QUOTA"; retryAfterMs: number };
export interface Reserver {
  tryReserve(p: {
    snapshot: Snapshot;
    connector: ConnectorInfo;
    account: Account;
    rule: Rule;
    policy: Policy;
    input: RouteInput;
  }): Promise<ReserveResult>;
}
export interface SelectDeps {
  health: HealthView;
  share?: ShareView;
  reserver: Reserver;
  random?: () => number;
  now?: () => Date;
  /** round_robin: counter per policy (Redis INCR di produksi). */
  nextCounter?: (policyId: string) => Promise<number>;
}

export interface TraceEntry {
  connectorKey: string;
  ruleId: string;
  priority: number;
  eliminatedBy?: EliminationReason;
  effectiveWeight?: number;
  eligibleAccounts?: number;
}

interface Candidate {
  rule: Rule;
  connector: ConnectorInfo;
  accounts: Account[];
}

/** Policy tenant menang atas default global (CONNECTOR_SPEC §6.3). */
export function findPolicy(snap: Snapshot, input: Pick<RouteInput, "tenantId" | "platform" | "operation">): Policy | undefined {
  return (
    snap.policies.get(policyKey(input.tenantId, input.platform, input.operation)) ??
    snap.policies.get(policyKey(null, input.platform, input.operation))
  );
}

/** Faktor kesehatan (CONNECTOR_SPEC §6.2): healthy 1.0 · degraded 0.5 · half_open / skor < 40 → 0.1. */
export function healthFactor(h: HealthState): number {
  if (h.circuit === "half_open") return 0.1;
  if (h.score === null || h.score >= 80) return 1;
  if (h.score >= 40) return 0.5;
  return 0.1;
}

function eligibleAccounts(
  snap: Snapshot,
  c: ConnectorInfo,
  input: RouteInput,
  deps: SelectDeps,
): { accounts: Account[]; allUnhealthy: boolean } {
  const now = (deps.now?.() ?? new Date()).getTime();
  const base = (snap.accountsByProvider.get(c.providerId) ?? []).filter(
    (a) =>
      (input.sharedPoolOnly ? a.tenantId === null : a.tenantId === null || a.tenantId === input.tenantId) && // BYO tidak lintas tenant (R-13/R-15)
      a.status === "active" &&
      (!a.cooldownUntil || a.cooldownUntil.getTime() < now) &&
      !input.excludeAccountIds.includes(a.id) &&
      (!a.allowedConnectorIds || a.allowedConnectorIds.includes(c.id)),
  );
  const healthy = base.filter((a) => {
    const h = deps.health.get(c.id, a.id);
    return h.circuit === "closed" || (h.circuit === "half_open" && !h.probeInflight);
  });
  return { accounts: healthy, allUnhealthy: base.length > 0 && healthy.length === 0 };
}

export function evaluate(
  snap: Snapshot,
  input: RouteInput,
  deps: SelectDeps,
): { policy?: Policy; candidates: Candidate[]; trace: TraceEntry[]; unhealthyOnly: boolean } {
  const policy = findPolicy(snap, input);
  const trace: TraceEntry[] = [];
  if (!policy?.enabled) return { policy, candidates: [], trace, unhealthyOnly: false };
  const candidates: Candidate[] = [];
  let unhealthy = 0;
  for (const rule of [...policy.rules].sort((a, b) => a.priority - b.priority)) {
    const c = snap.connectors.get(rule.connectorId);
    const t: TraceEntry = { connectorKey: c?.key ?? rule.connectorId, ruleId: rule.id, priority: rule.priority };
    trace.push(t);
    const cap = c?.capabilities.get(input.operation);
    const why = ((): EliminationReason | undefined => {
      if (!rule.enabled) return "RULE_DISABLED";
      if (!c?.enabled) return "CONNECTOR_DISABLED";
      if (!c.providerEnabled) return "PROVIDER_DISABLED";
      if (input.excludeConnectorIds.includes(c.id)) return "EXCLUDED";
      if (rule.runKinds && !rule.runKinds.includes(input.runKind)) return "RUN_KIND_MISMATCH";
      if (!cap) return "CAPABILITY_MISSING";
      if (cap.status === "failed" || cap.status === "deprecated") return "CAPABILITY_FAILED";
      if (cap.status !== "verified" && !policy.allowUnverified) return "CAPABILITY_NOT_VERIFIED";
      // compiler bisa mendekomposisi apa pun ke term → cukup dukung "term" (atau semua fitur yang diminta)
      if (
        input.requiredFeatures.length &&
        !input.requiredFeatures.every((f) => cap.queryFeatures.includes(f)) &&
        !cap.queryFeatures.includes("term")
      ) {
        return "FEATURES_UNSUPPORTED";
      }
      if (cap.measured.minIntervalSec !== undefined && input.intervalSec < cap.measured.minIntervalSec) return "INTERVAL_TOO_SHORT";
      if (rule.maxSharePct !== null && (deps.share?.sharePct(rule.id) ?? 0) >= rule.maxSharePct) return "SHARE_CAP";
      return undefined;
    })();
    if (why) {
      t.eliminatedBy = why;
      continue;
    }
    const { accounts, allUnhealthy } = eligibleAccounts(snap, c!, input, deps);
    if (!accounts.length) {
      t.eliminatedBy = "NO_ELIGIBLE_ACCOUNT";
      if (allUnhealthy) unhealthy++;
      continue;
    }
    t.eligibleAccounts = accounts.length;
    t.effectiveWeight = Math.round(rule.weight * Math.max(...accounts.map((a) => healthFactor(deps.health.get(c!.id, a.id)))));
    candidates.push({ rule, connector: c!, accounts });
  }
  return { policy, candidates, trace, unhealthyOnly: candidates.length === 0 && unhealthy > 0 };
}

/** cost_aware: fixed_cost_per_run + cost_per_1k × hasil estimasi (COST_MODEL §3 — start fee actor ikut dihitung). */
export function estimatedRunCost(c: ConnectorInfo, input: RouteInput): number | undefined {
  const m = c.capabilities.get(input.operation)?.measured;
  if (!m || (m.costPer1kResults === undefined && m.fixedCostPerRun === undefined)) return undefined;
  return (m.fixedCostPerRun ?? 0) + ((m.costPer1kResults ?? 0) * input.estimatedUnits.results) / 1000;
}

function weightedPick<T>(pool: { item: T; w: number }[], random: () => number): number {
  const total = pool.reduce((a, p) => a + p.w, 0);
  if (total <= 0) return Math.floor(random() * pool.length);
  let r = random() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= pool[i]!.w;
    if (r < 0) return i;
  }
  return pool.length - 1;
}

export async function select(
  snap: Snapshot,
  input: RouteInput,
  deps: SelectDeps,
): Promise<{ decision: RouteDecision; trace: TraceEntry[] }> {
  const { policy, candidates, trace, unhealthyOnly } = evaluate(snap, input, deps);
  const none = (reason: NoRouteReason, retryAfterMs = 0) => ({
    decision: { kind: "none_available" as const, reason, retryAfterMs },
    trace,
  });
  if (!policy) return none("NO_POLICY");
  if (!policy.enabled) return none("POLICY_DISABLED");
  if (!candidates.length) return none(unhealthyOnly ? "ALL_UNHEALTHY" : "NO_CANDIDATE");

  const random = deps.random ?? Math.random;
  let sawQuota = false;
  let sawThrottle = false;
  let minRetry = Number.POSITIVE_INFINITY;
  const groups = [...new Set(candidates.map((c) => c.rule.priority))].sort((a, b) => a - b);
  for (const prio of groups) {
    const group = candidates.filter((c) => c.rule.priority === prio);
    const pairs = group.flatMap((c) =>
      c.accounts.map((a) => ({ c, a, w: c.rule.weight * healthFactor(deps.health.get(c.connector.id, a.id)) })),
    );
    // weight 0 = standby: hanya dicoba bila semua weight > 0 di grup gagal reservasi
    const tiers = [pairs.filter((p) => p.c.rule.weight > 0), pairs.filter((p) => p.c.rule.weight === 0)];
    for (let pool of tiers) {
      if (policy.strategy === "cost_aware" && pool.every((p) => estimatedRunCost(p.c.connector, input) !== undefined)) {
        pool = [...pool].sort((x, y) => estimatedRunCost(x.c.connector, input)! - estimatedRunCost(y.c.connector, input)!);
      } else if (policy.strategy === "round_robin" && deps.nextCounter && pool.length) {
        const n = await deps.nextCounter(policy.id);
        pool = [...pool.slice(n % pool.length), ...pool.slice(0, n % pool.length)];
      }
      const deterministic = policy.strategy !== "priority_weighted";
      const remaining = pool.map((p) => ({ item: p, w: p.w }));
      while (remaining.length) {
        const idx = deterministic ? 0 : weightedPick(remaining, random);
        const pick = remaining.splice(idx, 1)[0]!.item;
        const halfOpen = deps.health.get(pick.c.connector.id, pick.a.id).circuit === "half_open";
        if (halfOpen && deps.health.claimProbe && !(await deps.health.claimProbe(pick.c.connector.id, pick.a.id))) continue;
        const r = await deps.reserver.tryReserve({
          snapshot: snap,
          connector: pick.c.connector,
          account: pick.a,
          rule: pick.c.rule,
          policy,
          input,
        });
        if (r.ok) {
          return {
            decision: {
              kind: "selected",
              connectorId: pick.c.connector.id,
              connectorKey: pick.c.connector.key,
              runtime: pick.c.connector.runtime,
              accountId: pick.a.id,
              reservationId: r.reservationId,
              ruleId: pick.c.rule.id,
              policyId: policy.id,
            },
            trace,
          };
        }
        if (halfOpen) await deps.health.releaseProbe?.(pick.c.connector.id, pick.a.id);
        if (r.reason === "QUOTA") sawQuota = true;
        else sawThrottle = true;
        minRetry = Math.min(minRetry, r.retryAfterMs);
      }
    }
  }
  const retry = Number.isFinite(minRetry) ? minRetry : 0;
  return none(sawThrottle ? "ALL_THROTTLED" : sawQuota ? "QUOTA_EXHAUSTED" : "NO_CANDIDATE", retry);
}
