// I-11 integrasi (Redis-cache): R-09 circuit breaker + passive window + score + probe tunggal.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HealthCache, HealthMonitor, select, type Transition } from "../src";
import { connector, input, rule, snapshot } from "./fixtures";

const REDIS = process.env.TEST_REDIS_CACHE_URL ?? "redis://127.0.0.1:56380";
const redisUp = await (async () => {
  try {
    const r = new Bun.RedisClient(REDIS, { connectionTimeout: 2000, autoReconnect: false });
    await r.ping();
    r.close();
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!redisUp)("I-11 health & circuit breaker (Redis)", () => {
  let redis: Bun.RedisClient;
  const prefixes: string[] = [];
  let seq = 0;
  const monitor = (now: { t: number }, transitions: Transition[] = [], config = {}) => {
    const prefix = `test:${Date.now()}:${++seq}:`;
    prefixes.push(prefix);
    return new HealthMonitor(redis, { prefix, now: () => now.t, onTransition: (t) => transitions.push(t), config });
  };
  beforeAll(() => {
    redis = new Bun.RedisClient(REDIS);
  });
  afterAll(async () => {
    for (const p of prefixes) {
      const keys = (await redis.send("KEYS", [`${p}*`])) as string[];
      if (keys.length) await redis.send("DEL", keys);
    }
    redis.close();
  });

  test("R-09: 5 failure → open → cooldown → half_open → 2 sukses → closed; transisi tercatat", async () => {
    const now = { t: 1_000_000 };
    const tr: Transition[] = [];
    const m = monitor(now, tr);
    for (let i = 0; i < 4; i++) expect(await m.record("c", "a", { ok: false, latencyMs: 100, failureWeight: 1 })).toBeNull();
    expect((await m.read("c", "a")).circuit).toBe("closed");
    expect(await m.record("c", "a", { ok: false, latencyMs: 100, failureWeight: 1 })).toMatchObject({ from: "closed", to: "open" });
    expect(await m.read("c", "a")).toMatchObject({ circuit: "open", state: "unhealthy", cooldownMs: 60_000 });
    expect(await m.claimProbe("c", "a")).toBe(false); // open → tidak boleh dipakai
    now.t += 60_000;
    expect((await m.read("c", "a")).circuit).toBe("half_open");
    expect(await m.claimProbe("c", "a")).toBe(true);
    expect(await m.claimProbe("c", "a")).toBe(false); // hanya 1 probe inflight
    expect((await m.read("c", "a")).probeInflight).toBe(true);
    expect(await m.record("c", "a", { ok: true, latencyMs: 90, failureWeight: 0 })).toBeNull(); // probe sukses 1/2
    expect(await m.claimProbe("c", "a")).toBe(true);
    expect(await m.record("c", "a", { ok: true, latencyMs: 90, failureWeight: 0 })).toMatchObject({ from: "half_open", to: "closed" });
    expect(await m.read("c", "a")).toMatchObject({ circuit: "closed", probeInflight: false });
    expect(tr.map((t) => `${t.from}→${t.to}`)).toEqual(["closed→open", "half_open→closed"]);
  });

  test("review I-21: override per connector (connectors.config.health) → circuit open setelah 2 failure, cooldown 5 menit", async () => {
    const now = { t: 3_000_000 };
    const m = monitor(now);
    const o = { failures: 2, cooldownMs: 300_000, bogus: 9 } as never;
    expect(await m.record("c2", "a", { ok: false, latencyMs: 100, failureWeight: 1 }, o)).toBeNull();
    expect(await m.record("c2", "a", { ok: false, latencyMs: 100, failureWeight: 1 }, o)).toMatchObject({ to: "open" });
    expect(await m.read("c2", "a")).toMatchObject({ circuit: "open", cooldownMs: 300_000 });
    // connector lain tetap memakai default (N = 5)
    for (let i = 0; i < 2; i++) await m.record("c3", "a", { ok: false, latencyMs: 100, failureWeight: 1 });
    expect((await m.read("c3", "a")).circuit).toBe("closed");
  });

  test("probe gagal di half_open → open lagi dengan cooldown ×2 (cap)", async () => {
    const now = { t: 5_000_000 };
    const m = monitor(now, [], { cooldownMs: 60_000, cooldownCapMs: 150_000 });
    for (let i = 0; i < 5; i++) await m.record("c", "a", { ok: false, latencyMs: 1, failureWeight: 1 });
    for (const expected of [120_000, 150_000, 150_000]) {
      now.t += 200_000;
      expect(await m.record("c", "a", { ok: false, latencyMs: 1, failureWeight: 1 })).toMatchObject({ from: "half_open", to: "open" });
      expect((await m.read("c", "a")).cooldownMs).toBe(expected);
    }
  });

  test("RATE_LIMITED/QUOTA (bobot 0) tidak dihitung; PARSE_ERROR membuka circuit setelah 2; success rate < 50% membuka", async () => {
    const now = { t: 9_000_000 };
    const m = monitor(now);
    for (let i = 0; i < 20; i++) await m.record("c", "rl", { ok: false, latencyMs: 1, failureWeight: 0 });
    expect(await m.read("c", "rl")).toMatchObject({ circuit: "closed", samples: 0, state: "unknown" });
    await m.record("c", "pe", { ok: false, latencyMs: 1, failureWeight: 2 });
    expect(await m.record("c", "pe", { ok: false, latencyMs: 1, failureWeight: 2 })).toMatchObject({ to: "open" });
    // success rate: 3 sukses lalu gagal hingga < 50% dengan total ≥ N (sebelum 5 failure tercapai tidak cukup)
    const m2 = monitor(now, [], { failures: 10 });
    for (let i = 0; i < 3; i++) await m2.record("c", "sr", { ok: true, latencyMs: 1, failureWeight: 0 });
    let openedAt = 0;
    for (let i = 1; i <= 9 && !openedAt; i++) if (await m2.record("c", "sr", { ok: false, latencyMs: 1, failureWeight: 1 })) openedAt = i;
    expect(openedAt).toBe(7); // total 10 ≥ N, 3/10 < 0,5 — padahal failure baru 7 < N=10
  });

  test("window 5 menit: failure lama kedaluwarsa; score memakai penalti latensi (SLO = p95 terukur × 2)", async () => {
    const now = { t: 20_000_000 };
    const m = monitor(now);
    for (let i = 0; i < 4; i++) await m.record("c", "a", { ok: false, latencyMs: 1, failureWeight: 1 });
    now.t += 6 * 60_000;
    expect(await m.record("c", "a", { ok: false, latencyMs: 1, failureWeight: 1 })).toBeNull(); // hanya 1 di window
    const m2 = monitor(now);
    for (let i = 0; i < 10; i++) await m2.record("c", "lat", { ok: true, latencyMs: 4000, failureWeight: 0 });
    expect(await m2.read("c", "lat", 1000)).toMatchObject({ score: 50, state: "degraded", p95LatencyMs: 4000, successRate: 1 });
    expect(await m2.read("c", "lat")).toMatchObject({ score: 100, state: "healthy" });
  });

  test("HealthCache → selector: circuit open dieliminasi; half_open hanya satu pemanggil yang dapat probe", async () => {
    const now = { t: 30_000_000 };
    const m = monitor(now);
    const cache = new HealthCache(m);
    const s = snapshot([connector("a"), connector("b")], [rule("a", 1, 100), rule("b", 2, 100)]);
    for (let i = 0; i < 5; i++) await m.record("c-a", "a-a", { ok: false, latencyMs: 1, failureWeight: 1 });
    await cache.refresh(s);
    expect(cache.detail("c-a", "a-a")?.state).toBe("unhealthy");
    const reserver = { tryReserve: async () => ({ ok: true as const, reservationId: "r" }) };
    expect((await select(s, input(), { health: cache, reserver })).decision).toMatchObject({ connectorKey: "b" });
    now.t += 60_000;
    await cache.refresh(s);
    const picks = await Promise.all(Array.from({ length: 5 }, () => select(s, input(), { health: cache, reserver })));
    const keys = picks.map((p) => (p.decision.kind === "selected" ? p.decision.connectorKey : "-"));
    expect(keys.filter((k) => k === "a")).toHaveLength(1); // satu probe ke a, sisanya ke b
    expect(keys.filter((k) => k === "b")).toHaveLength(4);
  });
});
