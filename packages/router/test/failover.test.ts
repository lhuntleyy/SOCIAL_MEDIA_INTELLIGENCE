// I-10 unit: tabel error taxonomy → keputusan (CONNECTOR_SPEC §7) + backoff R-08.
import { describe, expect, test } from "bun:test";
import type { AttemptOutcome, FailoverDecision } from "@smip/core";
import { type AttemptState, applyEffects, decideFailover, type Effect, failureBackoffSec, shouldAlertConsecutive } from "../src";

const fail = (errorCode: AttemptOutcome["errorCode"], o: Partial<AttemptOutcome> = {}): AttemptOutcome => ({
  reservationId: "r1",
  connectorId: "c1",
  accountId: "a1",
  ok: false,
  errorCode,
  latencyMs: 100,
  ...o,
});
const st = (o: Partial<AttemptState> = {}): AttemptState => ({
  attempt: 1,
  maxAttempts: 3,
  failoverEnabled: true,
  sameRetries: 0,
  recompiled: false,
  operation: "search_keyword",
  ...o,
});

describe("I-10 decideFailover", () => {
  test("sukses → done; ASYNC_PENDING → resume tanpa memakan attempt", () => {
    expect(decideFailover({ ...fail(undefined), ok: true }, st()).decision).toEqual({ action: "done" });
    expect(decideFailover(fail("ASYNC_PENDING", { retryAfterMs: 15_000 }), st({ attempt: 3 })).decision).toEqual({
      action: "resume",
      delayMs: 15_000,
    });
  });

  test("tabel aksi per kode", () => {
    const rows: [AttemptOutcome["errorCode"], Partial<AttemptOutcome>, FailoverDecision, Effect["kind"][], 0 | 1 | 2][] = [
      ["RATE_LIMITED", { retryAfterMs: 30_000 }, { action: "failover", excludeAccountId: "a1", delayMs: 0 }, ["throttle"], 0],
      ["QUOTA_EXHAUSTED", {}, { action: "failover", excludeAccountId: "a1", delayMs: 0 }, ["throttle", "account_cooldown", "alert"], 0], // saldo akun habis → jeda tercatat di DB + alert
      ["QUOTA_EXHAUSTED", { errorScope: "connector" }, { action: "failover", excludeConnectorId: "c1", delayMs: 0 }, ["throttle"], 0],
      ["AUTH_INVALID", {}, { action: "failover", excludeAccountId: "a1", delayMs: 0 }, ["account_attention", "alert"], 1],
      ["CHALLENGE_REQUIRED", {}, { action: "failover", excludeAccountId: "a1", delayMs: 0 }, ["account_attention", "alert"], 1],
      ["FORBIDDEN", {}, { action: "failover", excludeAccountId: "a1", delayMs: 0 }, ["account_attention", "alert"], 0],
      // izin per connector (token Apify dipakai banyak actor): hanya connector yang dijeda, akun tetap aktif
      ["FORBIDDEN", { errorScope: "connector" }, { action: "failover", excludeConnectorId: "c1", delayMs: 0 }, ["throttle"], 0],
      ["BLOCKED", {}, { action: "failover", excludeAccountId: "a1", delayMs: 0 }, ["account_cooldown", "alert"], 1],
      ["NOT_SUPPORTED", {}, { action: "failover", excludeConnectorId: "c1", delayMs: 0 }, ["capability_failed"], 0],
      ["INVALID_QUERY", {}, { action: "recompile" }, [], 0],
      ["UPSTREAM_5XX", {}, { action: "retry_same", delayMs: 2000 }, [], 1],
      ["NETWORK", {}, { action: "retry_same", delayMs: 2000 }, [], 1],
      ["TIMEOUT", {}, { action: "failover", excludeConnectorId: "c1", delayMs: 0 }, [], 1],
      ["PARSE_ERROR", {}, { action: "failover", excludeConnectorId: "c1", delayMs: 0 }, ["alert"], 2],
      ["UNKNOWN", {}, { action: "failover", excludeConnectorId: "c1", delayMs: 0 }, [], 1],
    ];
    for (const [code, extra, decision, effects, weight] of rows) {
      const r = decideFailover(fail(code, extra), st());
      expect({ code, decision: r.decision, effects: r.effects.map((e) => e.kind), weight: r.healthFailure }).toEqual({
        code,
        decision,
        effects,
        weight,
      });
    }
    const rl = decideFailover(fail("RATE_LIMITED", { retryAfterMs: 30_000 }), st()).effects[0];
    expect(rl).toEqual({ kind: "throttle", scopeId: "a1", ms: 30_000 });
    expect(decideFailover(fail("RATE_LIMITED"), st()).effects[0]).toMatchObject({ ms: 60_000 }); // default tanpa Retry-After
    expect(decideFailover(fail("FORBIDDEN", { errorScope: "connector" }), st()).effects[0]).toEqual({
      kind: "throttle",
      scopeId: "c1",
      ms: 3_600_000,
    });
  });

  test("5xx: retry sekali di connector sama, lalu failover; INVALID_QUERY setelah recompile → fail", () => {
    expect(decideFailover(fail("UPSTREAM_5XX"), st({ sameRetries: 1 })).decision).toMatchObject({
      action: "failover",
      excludeConnectorId: "c1",
    });
    expect(decideFailover(fail("INVALID_QUERY"), st({ recompiled: true })).decision).toEqual({ action: "fail", reason: "INVALID_QUERY" });
  });

  test("max_attempts habis / failover dimatikan → fail, efek tetap dijalankan", () => {
    const r = decideFailover(fail("AUTH_INVALID"), st({ attempt: 3 }));
    expect(r.decision).toEqual({ action: "fail", reason: "AUTH_INVALID: max_attempts (3) habis" });
    expect(r.effects.map((e) => e.kind)).toEqual(["account_attention", "alert"]);
    expect(decideFailover(fail("TIMEOUT"), st({ failoverEnabled: false })).decision).toMatchObject({ action: "fail" });
    expect(decideFailover(fail("UPSTREAM_5XX"), st({ attempt: 3 })).decision).toMatchObject({ action: "fail" });
  });

  test("applyEffects memanggil port sesuai efek", async () => {
    const calls: string[] = [];
    const effects = [
      ...decideFailover(fail("RATE_LIMITED", { retryAfterMs: 5 }), st()).effects,
      ...decideFailover(fail("BLOCKED"), st()).effects,
      ...decideFailover(fail("NOT_SUPPORTED"), st()).effects,
      ...decideFailover(fail("AUTH_INVALID"), st()).effects,
    ];
    await applyEffects(
      effects,
      {
        throttle: async (id, ms) => void calls.push(`throttle ${id} ${ms}`),
        accountAttention: async (id, code) => void calls.push(`attention ${id} ${code}`),
        accountCooldown: async (id, until, code) => void calls.push(`cooldown ${id} ${until} ${code}`),
        capabilityFailed: async (id, op) => void calls.push(`capfail ${id} ${op}`),
        alert: async (e) => void calls.push(`alert ${e.event}`),
      },
      1000,
    );
    expect(calls).toEqual([
      "throttle a1 5",
      `cooldown a1 ${1000 + 6 * 3_600_000} BLOCKED`,
      "alert account_blocked",
      "capfail c1 search_keyword",
      "attention a1 AUTH_INVALID",
      "alert account_needs_attention",
    ]);
  });

  test("R-08 backoff next_run_at eksponensial, cap 4× interval; alert ≥ 3 berturut-turut", () => {
    expect([1, 2, 3, 4, 10].map((n) => failureBackoffSec(300, n))).toEqual([300, 600, 1200, 1200, 1200]);
    expect([2, 3].map(shouldAlertConsecutive)).toEqual([false, true]);
  });
});
