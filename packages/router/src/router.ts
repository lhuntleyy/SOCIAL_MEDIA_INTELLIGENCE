// Implementasi port ProviderRouter (CONNECTOR_SPEC §6): snapshot (I-06) → select (I-07) → reservasi (I-08/I-09);
// outcome → settle reservasi → decideFailover (I-10) → efek → health (I-11).
import type { AttemptContext, AttemptOutcome, FailoverDecision, ProviderRouter, RouteDecision, RouteInput } from "@smip/core";
import type { Logger } from "@smip/observability";
import { applyEffects, DEFAULT_FAILOVER, decideFailover, type EffectSink, type FailoverConfig } from "./failover";
import type { HealthCache, HealthMonitor, Transition } from "./health";
import type { RedisReserver } from "./reserve";
import { evaluate, type ShareView, select, type TraceEntry } from "./select";
import type { Snapshot } from "./snapshot";

export interface RouterDeps {
  snapshots: { get(): Promise<Snapshot> };
  reserver: RedisReserver;
  health: HealthCache;
  monitor: HealthMonitor;
  /** Efek ke Postgres/alert (dirangkai app: @smip/db markAccountAttention dll.). `throttle` default → rl:dyn. */
  effects: Omit<EffectSink, "throttle"> & Partial<Pick<EffectSink, "throttle">>;
  share?: ShareView;
  nextCounter?: (policyId: string) => Promise<number>;
  failover?: FailoverConfig;
  logger?: Logger;
  onTransition?: (t: Transition) => void;
}

export class Router implements ProviderRouter {
  constructor(private readonly d: RouterDeps) {}

  async plan(input: RouteInput): Promise<RouteDecision> {
    return (await this.planWithTrace(input)).decision;
  }

  async planWithTrace(input: RouteInput): Promise<{ decision: RouteDecision; trace: TraceEntry[] }> {
    const snap = await this.d.snapshots.get();
    const out = await select(snap, input, {
      health: this.d.health,
      reserver: this.d.reserver,
      share: this.d.share,
      nextCounter: this.d.nextCounter,
    });
    this.d.logger?.debug("route", {
      platform: input.platform,
      operation: input.operation,
      decision: out.decision.kind === "selected" ? out.decision.connectorKey : out.decision.reason,
      trace: out.trace,
    });
    return out;
  }

  /** Simulator admin (API_SPEC §9 routing simulate): alasan eliminasi tanpa reservasi. */
  async simulate(input: RouteInput): Promise<{ policyId?: string; trace: TraceEntry[] }> {
    const snap = await this.d.snapshots.get();
    const r = evaluate(snap, input, { health: this.d.health, reserver: this.d.reserver, share: this.d.share });
    return { policyId: r.policy?.id, trace: r.trace };
  }

  async reportOutcome(o: AttemptOutcome, ctx: AttemptContext): Promise<FailoverDecision> {
    const snap = await this.d.snapshots.get();
    // ASYNC_PENDING = eksekusi provider masih berjalan: attempt BELUM selesai → reservasi (slot semaphore, quota)
    // tetap dipegang sampai hasil akhir; health tidak dicatat. Pemakaian di-commit sekali di hasil akhir.
    if (!o.ok && o.errorCode === "ASYNC_PENDING") {
      return { action: "resume", delayMs: o.retryAfterMs ?? (this.d.failover ?? DEFAULT_FAILOVER).asyncPollMs };
    }
    // Request sudah terkirim (sukses atau error dari provider) → commit pemakaian; default konservatif 1 request.
    await this.d.reserver.commit(o.reservationId, o.usage ?? { requests: 1, results: 0, costUnits: null }, snap);
    const policy = [...snap.policies.values()].find((p) => p.id === ctx.policyId);
    const res = decideFailover(
      o,
      {
        attempt: ctx.attempt,
        maxAttempts: policy?.maxAttempts ?? 1,
        failoverEnabled: policy?.failoverEnabled ?? false,
        sameRetries: ctx.sameRetries,
        recompiled: ctx.recompiled,
        operation: ctx.operation,
      },
      this.d.failover ?? DEFAULT_FAILOVER,
    );
    await applyEffects(res.effects, {
      throttle: this.d.effects.throttle ?? ((scopeId, ms) => this.d.reserver.setDynamicLimit(scopeId, ms)),
      accountAttention: this.d.effects.accountAttention,
      accountCooldown: this.d.effects.accountCooldown,
      capabilityFailed: this.d.effects.capabilityFailed,
      alert: this.d.effects.alert,
    });
    // bobot 0 (RATE_LIMITED dll.) tidak masuk window, tapi tetap melepas slot probe half_open
    const t = await this.d.monitor.record(o.connectorId, o.accountId, {
      ok: o.ok,
      latencyMs: o.latencyMs,
      failureWeight: res.healthFailure,
    });
    if (t) this.d.onTransition?.(t);
    if (!o.ok) this.d.logger?.info("attempt gagal", { code: o.errorCode, action: res.decision.action, attempt: ctx.attempt });
    return res.decision;
  }

  /** Reservasi lolos tapi request tidak terkirim (mis. job dibatalkan) → kembalikan token/quota/slot. */
  release(reservationId: string): Promise<boolean> {
    return this.d.reserver.release(reservationId);
  }
}
