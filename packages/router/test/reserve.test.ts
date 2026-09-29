// I-08 + I-09 integrasi (Redis-cache compose): R-10, R-11 + commit/release/sweeper/Retry-After/threshold,
// flush & seed ke Postgres `quota_usage`. Kunci Redis ber-prefix unik per run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { QuotaRule, RateLimit } from "@smip/core";
import { scopeKey } from "@smip/core";
import { createDb, flushQuotaUsage, loadQuotaUsage, up } from "@smip/db";
import postgres from "postgres";
import { periodInfo, RedisReserver, SEM_POLL_MS, type Snapshot, select, type ThresholdEvent } from "../src";
import { connector, input, rule, snapshot, T_A } from "./fixtures";

const PG = process.env.TEST_PG_URL ?? "postgres://smip_owner:smip_owner_dev@127.0.0.1:55432/postgres";
const REDIS = process.env.TEST_REDIS_CACHE_URL ?? "redis://127.0.0.1:56380";
const infraUp = await (async () => {
  try {
    const s = postgres(PG, { connect_timeout: 2, onnotice: () => {} });
    await s`select 1`;
    await s.end();
    const r = new Bun.RedisClient(REDIS, { connectionTimeout: 2000, autoReconnect: false });
    await r.ping();
    r.close();
    return true;
  } catch {
    return false;
  }
})();

let seq = 0;
const rl = (scopeType: RateLimit["scopeType"], scopeId: string, o: Partial<RateLimit> = {}): RateLimit => ({
  id: `rl-${++seq}`,
  scopeType,
  scopeId,
  algorithm: "token_bucket",
  capacity: 10,
  refillTokens: 0,
  refillIntervalMs: 1000,
  ...o,
});
const quota = (scopeType: QuotaRule["scopeType"], scopeId: string | null, o: Partial<QuotaRule> = {}): QuotaRule => ({
  id: `q-${++seq}`,
  scopeType,
  scopeId,
  period: "day",
  unit: "requests",
  limit: 25,
  hard: true,
  alertThresholds: [50, 80, 95],
  resetTz: "Asia/Jakarta",
  ...o,
});
function withLimits(s: Snapshot, rls: RateLimit[], qs: QuotaRule[]): Snapshot {
  for (const r of rls)
    s.rateLimits.set(scopeKey(r.scopeType, r.scopeId), [...(s.rateLimits.get(scopeKey(r.scopeType, r.scopeId)) ?? []), r]);
  for (const q of qs) s.quotas.set(scopeKey(q.scopeType, q.scopeId), [...(s.quotas.get(scopeKey(q.scopeType, q.scopeId)) ?? []), q]);
  return s;
}

describe.skipIf(!infraUp)("I-08/I-09 reservasi atomik (Redis)", () => {
  let redis: Bun.RedisClient;
  const prefixes: string[] = [];
  const fresh = (o: ConstructorParameters<typeof RedisReserver>[1] = {}) => {
    const prefix = `test:${Date.now()}:${++seq}:`;
    prefixes.push(prefix);
    return new RedisReserver(redis, { prefix, ...o });
  };
  const reserveArgs = (s: Snapshot, i = input()) => ({
    snapshot: s,
    connector: s.connectors.get("c-a")!,
    account: s.accountsByProvider.get("p-a")![0]!,
    rule: s.policies.values().next().value!.rules[0]!,
    policy: s.policies.values().next().value!,
    input: i,
  });

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

  test("R-11 token bucket di bawah konkurensi 100 → tepat sebanyak kapasitas", async () => {
    const r = fresh();
    const s = withLimits(snapshot([connector("a")], [rule("a", 1, 100)]), [rl("connector", "c-a", { capacity: 10 })], []);
    const res = await Promise.all(Array.from({ length: 100 }, () => r.tryReserve(reserveArgs(s))));
    expect(res.filter((x) => x.ok)).toHaveLength(10);
    const denied = res.find((x) => !x.ok)!;
    expect(denied).toMatchObject({ ok: false, reason: "THROTTLED" });
  });

  test("R-11 quota hard di bawah konkurensi 100 → tidak pernah melebihi limit (reserved + used)", async () => {
    const r = fresh();
    const s = withLimits(snapshot([connector("a")], [rule("a", 1, 100)]), [], [quota("tenant", T_A, { limit: 25 })]);
    const res = await Promise.all(Array.from({ length: 100 }, () => r.tryReserve(reserveArgs(s))));
    const ok = res.filter((x) => x.ok) as { ok: true; reservationId: string }[];
    expect(ok).toHaveLength(25);
    expect(res.find((x) => !x.ok)).toMatchObject({ reason: "QUOTA" });
    // release 5 → 5 slot kembali; commit sisanya dengan pemakaian aktual 1 request
    for (const x of ok.slice(0, 5)) expect(await r.release(x.reservationId)).toBe(true);
    for (const x of ok.slice(5)) expect(await r.commit(x.reservationId, { requests: 1, results: 3, costUnits: null })).toBe(true);
    expect(await r.commit(ok[5]!.reservationId, { requests: 1, results: 3, costUnits: null })).toBe(false); // idempoten
    const again = await Promise.all(Array.from({ length: 20 }, () => r.tryReserve(reserveArgs(s))));
    expect(again.filter((x) => x.ok)).toHaveLength(5);
  });

  test("R-11 semaphore concurrency connector: maks N lease; release membuka slot", async () => {
    const r = fresh();
    const s = withLimits(
      snapshot([connector("a")], [rule("a", 1, 100)]),
      [rl("connector", "c-a", { algorithm: "concurrency", capacity: 3 })],
      [],
    );
    const res = await Promise.all(Array.from({ length: 50 }, () => r.tryReserve(reserveArgs(s))));
    const ok = res.filter((x) => x.ok) as { ok: true; reservationId: string }[];
    expect(ok).toHaveLength(3);
    const busy = res.find((x) => !x.ok) as { ok: false; reason: string; retryAfterMs: number };
    // penuh → coba lagi paling lambat SEM_POLL_MS, bukan menunggu lease (= TTL reservasi) habis
    expect(busy.reason).toBe("THROTTLED");
    expect(busy.retryAfterMs).toBeLessThanOrEqual(SEM_POLL_MS);
    await r.release(ok[0]!.reservationId);
    expect((await r.tryReserve(reserveArgs(s))).ok).toBe(true);
    expect((await r.tryReserve(reserveArgs(s))).ok).toBe(false);
  });

  test("gagal di satu scope → tidak ada potongan parsial di scope lain", async () => {
    const r = fresh();
    const s = withLimits(
      snapshot([connector("a")], [rule("a", 1, 100)]),
      [rl("connector", "c-a", { capacity: 100 }), rl("provider_account", "a-a", { capacity: 2 })],
      [quota("global", null, { limit: 1000 })],
    );
    for (let i = 0; i < 5; i++) await r.tryReserve(reserveArgs(s));
    const pfx = prefixes.at(-1)!;
    const conn = (await redis.send("HGET", [`${pfx}rl:connector:c-a`, "tokens"])) as string;
    expect(Number(conn)).toBe(98); // hanya 2 yang lolos; 3 yang ditolak account tidak memotong token connector
    const pi = periodInfo("day", "Asia/Jakarta", new Date());
    expect(Number(await redis.send("HGET", [`${pfx}quota:global:*:${pi.start}:requests`, "reserved"]))).toBe(2);
  });

  test("token bucket refill + retryAfter sesuai laju", async () => {
    let now = 1_000_000;
    const r = fresh({ now: () => now });
    const s = withLimits(
      snapshot([connector("a")], [rule("a", 1, 100)]),
      [rl("provider", "p-a", { capacity: 2, refillTokens: 1, refillIntervalMs: 1000 })],
      [],
    );
    expect((await r.tryReserve(reserveArgs(s))).ok).toBe(true);
    expect((await r.tryReserve(reserveArgs(s))).ok).toBe(true);
    expect(await r.tryReserve(reserveArgs(s))).toEqual({ ok: false, reason: "THROTTLED", retryAfterMs: 1000 });
    now += 500;
    expect(await r.tryReserve(reserveArgs(s))).toEqual({ ok: false, reason: "THROTTLED", retryAfterMs: 500 });
    now += 500;
    expect((await r.tryReserve(reserveArgs(s))).ok).toBe(true);
  });

  test("Retry-After provider (rl:dyn) memblok account sampai lewat; hanya memperpanjang", async () => {
    let now = 5_000_000;
    const r = fresh({ now: () => now });
    const s = snapshot([connector("a")], [rule("a", 1, 100)]);
    await r.setDynamicLimit("a-a", 30_000);
    await r.setDynamicLimit("a-a", 1_000); // lebih pendek → diabaikan
    expect(await r.tryReserve(reserveArgs(s))).toEqual({ ok: false, reason: "THROTTLED", retryAfterMs: 30_000 });
    now += 30_001;
    expect((await r.tryReserve(reserveArgs(s))).ok).toBe(true);
  });

  test("sweeper me-release reservasi lewat deadline (job crash sebelum commit)", async () => {
    let now = 9_000_000;
    const r = fresh({ now: () => now, reservationTtlMs: 60_000 });
    const s = withLimits(
      snapshot([connector("a")], [rule("a", 1, 100)]),
      [rl("connector", "c-a", { algorithm: "concurrency", capacity: 1 })],
      [quota("connector", "c-a", { limit: 1 })],
    );
    expect((await r.tryReserve(reserveArgs(s))).ok).toBe(true);
    expect((await r.tryReserve(reserveArgs(s))).ok).toBe(false);
    expect(await r.sweep()).toBe(0);
    now += 60_001;
    expect(await r.sweep()).toBe(1);
    expect((await r.tryReserve(reserveArgs(s))).ok).toBe(true);
  });

  test("threshold 50/80/95% dipicu sekali saat commit melewatinya", async () => {
    const events: ThresholdEvent[] = [];
    const r = fresh({ onThreshold: (e) => events.push(e) });
    const s = withLimits(
      snapshot([connector("a")], [rule("a", 1, 100)]),
      [],
      [quota("tenant", T_A, { unit: "results", limit: 100, hard: false })],
    );
    for (const results of [40, 20, 20, 30]) {
      const x = (await r.tryReserve(reserveArgs(s, input({ estimatedUnits: { requests: 1, results } })))) as { reservationId: string };
      await r.commit(x.reservationId, { requests: 1, results, costUnits: null }, s);
    }
    expect(events.map((e) => [e.threshold, e.used])).toEqual([
      [50, 60],
      [80, 80],
      [95, 110],
    ]);
  });

  test("R-10 hard quota habis → select() none_available(QUOTA_EXHAUSTED) dengan retryAfter = sisa periode", async () => {
    const r = fresh();
    const s = withLimits(
      snapshot([connector("a"), connector("b")], [rule("a", 1, 100), rule("b", 2, 100)]),
      [],
      [quota("tenant", T_A, { limit: 0 })],
    );
    const calls: string[] = [];
    const reserver = {
      tryReserve: (p: Parameters<RedisReserver["tryReserve"]>[0]) => {
        calls.push(p.connector.key);
        return r.tryReserve(p);
      },
    };
    const { decision } = await select(s, input(), { health: { get: () => ({ circuit: "closed", score: null }) }, reserver });
    expect(decision).toMatchObject({ kind: "none_available", reason: "QUOTA_EXHAUSTED" });
    const pi = periodInfo("day", "Asia/Jakarta", new Date());
    expect((decision as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(pi.resetInMs - 5000);
    expect(calls.sort()).toEqual(["a", "b"]); // semua kandidat dicoba reservasi, tidak ada connector yang dipanggil
    // quota tenant lain / stream shared pool tidak terkena
    expect(
      (await select(s, input({ sharedPoolOnly: true }), { health: { get: () => ({ circuit: "closed", score: null }) }, reserver: r }))
        .decision.kind,
    ).toBe("selected");
  });

  test("periodInfo: harian & bulanan di zona reset_tz", () => {
    const t = new Date("2026-09-30T18:30:00Z"); // 2026-10-01 01:30 WIB
    expect(periodInfo("day", "Asia/Jakarta", t)).toEqual({ start: "2026-10-01", startDate: "2026-10-01", resetInMs: 22.5 * 3_600_000 });
    expect(periodInfo("month", "Asia/Jakarta", t)).toMatchObject({ start: "2026-10", startDate: "2026-10-01" });
    expect(periodInfo("month", "UTC", t)).toEqual({ start: "2026-09", startDate: "2026-09-01", resetInMs: 5.5 * 3_600_000 });
  });

  describe("flush & seed Postgres", () => {
    const name = `smip_quota_${Date.now()}`;
    let admin: postgres.Sql;
    let sql: postgres.Sql;
    let created: ReturnType<typeof createDb>;
    beforeAll(async () => {
      admin = postgres(PG, { onnotice: () => {} });
      await admin.unsafe(`CREATE DATABASE ${name}`);
      const url = PG.replace(/\/[^/]*$/, `/${name}`);
      sql = postgres(url, { onnotice: () => {} });
      await up(sql);
      created = createDb(url, { max: 2 });
    });
    afterAll(async () => {
      await created?.close();
      await sql?.end();
      await admin?.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin?.end();
    });

    test("commit → quota:dirty → flush (harian & bulanan tidak bertabrakan) → Redis hilang → seed ulang dari PG", async () => {
      const r = fresh();
      const s = withLimits(
        snapshot([connector("a")], [rule("a", 1, 100)]),
        [],
        [
          quota("tenant", T_A, { limit: 10 }),
          quota("tenant", T_A, { limit: 100, period: "month" }),
          quota("global", null, { limit: 1000 }),
        ],
      );
      for (let i = 0; i < 4; i++) {
        const x = (await r.tryReserve(reserveArgs(s))) as { reservationId: string };
        await r.commit(x.reservationId, { requests: 2, results: 0, costUnits: null });
      }
      const rows = await r.drainDirty();
      expect(rows.map((x) => [x.scopeType, x.period, x.used]).sort()).toEqual([
        ["global", "day", 8],
        ["tenant", "day", 8],
        ["tenant", "month", 8],
      ]);
      expect(await flushQuotaUsage(created.db, rows)).toBe(3);
      expect(
        await flushQuotaUsage(
          created.db,
          rows.map((x) => ({ ...x, used: 1 })),
        ),
      ).toBe(3); // flush basi tidak memundurkan
      const pg = await sql`select scope_type, period, used::int from quota_usage order by scope_type, period`;
      expect(pg.map((x) => [x.scope_type, x.period, x.used])).toEqual([
        ["global", "day", 8],
        ["tenant", "day", 8],
        ["tenant", "month", 8],
      ]);

      // simulasi Redis kehilangan data: reserver baru di prefix yang sama, kunci quota dihapus
      const pfx = prefixes.at(-1)!;
      const keys = (await redis.send("KEYS", [`${pfx}quota:*`])) as string[];
      await redis.send("DEL", keys);
      const r2 = new RedisReserver(redis, { prefix: pfx, seed: (k) => loadQuotaUsage(created.db, k) });
      const res = await Promise.all(Array.from({ length: 10 }, () => r2.tryReserve(reserveArgs(s))));
      expect(res.filter((x) => x.ok)).toHaveLength(2); // limit harian 10, sudah terpakai 8 → sisa 2 (tanpa seed: 10)
    });
  });
});
