// I-08 + I-09: reservasi atomik satu skrip Lua (CONNECTOR_SPEC §6.2 tryReserve, §10, §11):
//   1. quota hard semua scope (global/tenant/topic/provider/connector/provider_account)
//   2. rate: override dinamis `rl:dyn:*` (Retry-After) + token bucket provider → connector → account
//   3. semaphore concurrency
// Semua cek dulu, baru semua potong → tidak ada reservasi parsial. Commit/release idempoten; sweeper me-release
// reservasi yang lewat deadline (job_timeout + 60 s). Redis-cache = sumber kebenaran live; `quota:dirty` di-flush
// ke Postgres `quota_usage` oleh worker-ops (lihat @smip/db flushQuotaUsage).
// Catatan: skrip commit/release menyentuh kunci quota yang tidak dideklarasikan di KEYS — sah di Redis single-node
// (profil MVP); untuk Redis Cluster semua kunci perlu hash tag yang sama.
import type { RouteInput } from "@smip/core";
import { type QuotaRule, type QuotaUnit, scopeKey } from "@smip/core";
import { estimatedRunCost, type Reserver, type ReserveResult } from "./select";
import type { Account, ConnectorInfo, Snapshot } from "./snapshot";

/** Subset klien Redis yang dipakai (cocok dengan Bun.RedisClient). */
export interface RedisLike {
  send(command: string, args: string[]): Promise<unknown>;
}

const RESERVE = `
local now = tonumber(ARGV[1])
local id = ARGV[2]
local ttl = tonumber(ARGV[3])
local nD, nB, nQ, nS = tonumber(ARGV[4]), tonumber(ARGV[5]), tonumber(ARGV[6]), tonumber(ARGV[7])
local kD, kB, kQ, kS = 2, 2 + nD, 2 + nD + nB, 2 + nD + nB + nQ
local aB, aQ, aS = 8, 8 + nB * 4, 8 + nB * 4 + nQ * 5
-- 1. quota hard
for i = 1, nQ do
  local key = KEYS[kQ + i]
  local a = aQ + (i - 1) * 5
  local limit, amount, hard = tonumber(ARGV[a]), tonumber(ARGV[a + 1]), ARGV[a + 2]
  if hard == '1' then
    local used = tonumber(redis.call('HGET', key, 'used') or '0')
    local reserved = tonumber(redis.call('HGET', key, 'reserved') or '0')
    if used + reserved >= limit or used + reserved + amount > limit then
      return {1, tonumber(ARGV[a + 4]), i}
    end
  end
end
-- 2a. override dinamis (Retry-After dari provider)
for i = 1, nD do
  local v = redis.call('GET', KEYS[kD + i])
  if v and tonumber(v) > now then return {2, tonumber(v) - now, i} end
end
-- 2b. token bucket
local tokens = {}
local wait = 0
for i = 1, nB do
  local a = aB + (i - 1) * 4
  local cap, refill, interval, cost = tonumber(ARGV[a]), tonumber(ARGV[a + 1]), tonumber(ARGV[a + 2]), tonumber(ARGV[a + 3])
  local h = redis.call('HMGET', KEYS[kB + i], 'tokens', 'ts')
  local t = tonumber(h[1]) or cap
  local ts = tonumber(h[2]) or now
  if refill > 0 and now > ts then t = math.min(cap, t + (now - ts) * refill / interval) end
  tokens[i] = t
  if t < cost then
    local w = refill > 0 and math.ceil((cost - t) * interval / refill) or 3600000
    if w > wait then wait = w end
  end
end
if wait > 0 then return {2, wait, 0} end
-- 3. semaphore (lease = deadline reservasi; lease kedaluwarsa dibersihkan di sini)
for i = 1, nS do
  local key = KEYS[kS + i]
  redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
  if redis.call('ZCARD', key) >= tonumber(ARGV[aS + i - 1]) then
    local first = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    return {3, math.max(1, tonumber(first[2]) - now), i}
  end
end
-- semua lolos → potong
for i = 1, nB do
  local cost = tonumber(ARGV[aB + (i - 1) * 4 + 3])
  redis.call('HSET', KEYS[kB + i], 'tokens', tostring(tokens[i] - cost), 'ts', now)
  redis.call('PEXPIRE', KEYS[kB + i], 3600000)
end
for i = 1, nS do
  redis.call('ZADD', KEYS[kS + i], now + ttl, id)
  redis.call('HSET', KEYS[1], 's:' .. KEYS[kS + i], 1)
end
for i = 1, nQ do
  local a = aQ + (i - 1) * 5
  local key, amount = KEYS[kQ + i], tonumber(ARGV[a + 1])
  if amount > 0 then redis.call('HINCRBYFLOAT', key, 'reserved', amount) end
  redis.call('EXPIRE', key, tonumber(ARGV[a + 3]))
  redis.call('HSET', KEYS[1], 'q:' .. key, amount)
end
redis.call('HSET', KEYS[1], 'at', now)
redis.call('PEXPIRE', KEYS[1], ttl * 2 + 60000)
redis.call('ZADD', KEYS[2], now + ttl, id)
return {0, 0, 0}
`;

// KEYS: resv, pending, dirty · ARGV: id, commit(0/1), requests, results, cost_units
// Kembali: [ada(0/1), key1, usedBefore1, usedAfter1, ...] — dipakai untuk event threshold.
const SETTLE = `
local fields = redis.call('HGETALL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
if #fields == 0 then return {0} end
local actual = { requests = tonumber(ARGV[3]), results = tonumber(ARGV[4]), cost_units = tonumber(ARGV[5]) }
local out = {1}
for i = 1, #fields, 2 do
  local f, v = fields[i], fields[i + 1]
  if string.sub(f, 1, 2) == 's:' then
    redis.call('ZREM', string.sub(f, 3), ARGV[1])
  elseif string.sub(f, 1, 2) == 'q:' then
    local key = string.sub(f, 3)
    local amount = tonumber(v)
    if amount > 0 then redis.call('HINCRBYFLOAT', key, 'reserved', -amount) end
    if ARGV[2] == '1' then
      local unit = string.match(key, ':([%a_]+)$')
      local add = actual[unit] or 0
      local before = tonumber(redis.call('HGET', key, 'used') or '0')
      local after = before
      if add > 0 then after = tonumber(redis.call('HINCRBYFLOAT', key, 'used', add)) end
      table.insert(out, key)
      table.insert(out, tostring(before))
      table.insert(out, tostring(after))
    end
    redis.call('SADD', KEYS[3], key)
  end
end
redis.call('DEL', KEYS[1])
return out
`;

// KEYS: rl:dyn · ARGV: until(ms epoch), ttlMs — hanya memperpanjang, tidak memperpendek.
const DYN = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
if tonumber(ARGV[1]) > cur then redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2]) end
return 1
`;

const sha = (s: string) => new Bun.CryptoHasher("sha1").update(s).digest("hex");

/** Awal periode di zona `tz` + sisa ms sampai reset. Bulanan ditulis `YYYY-MM` agar kunci tidak bentrok dengan harian. */
export function periodInfo(period: "day" | "month", tz: string, now: Date): { start: string; startDate: string; resetInMs: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const [y, m, d] = [Number(parts.year), Number(parts.month), Number(parts.day)];
  const intoDay = ((Number(parts.hour) * 60 + Number(parts.minute)) * 60 + Number(parts.second)) * 1000 + now.getUTCMilliseconds();
  const DAY = 86_400_000;
  if (period === "day") {
    const start = `${parts.year}-${parts.month}-${parts.day}`;
    return { start, startDate: start, resetInMs: DAY - intoDay };
  }
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    start: `${parts.year}-${parts.month}`,
    startDate: `${parts.year}-${parts.month}-01`,
    resetInMs: (daysInMonth - d + 1) * DAY - intoDay,
  };
}

export interface QuotaUsageRow {
  scopeType: string;
  scopeId: string | null;
  period: "day" | "month";
  periodStart: string;
  unit: QuotaUnit;
  used: number;
  reserved: number;
}
export interface ThresholdEvent {
  rule: QuotaRule;
  key: string;
  threshold: number;
  used: number;
}

export interface RedisReserverOptions {
  /** Prefix kunci (test / multi-env). Default "". */
  prefix?: string;
  /** Deadline reservasi = job_timeout + 60 s (CONNECTOR_SPEC §11). Default 10 menit. */
  reservationTtlMs?: number;
  now?: () => number;
  /** Seed ulang counter dari Postgres bila kunci quota hilang (Redis restart/evict). */
  seed?: (rows: Omit<QuotaUsageRow, "used" | "reserved">[]) => Promise<({ used: number } | null)[]>;
  onThreshold?: (e: ThresholdEvent) => void;
}

interface QuotaCheck {
  key: string;
  rule: QuotaRule;
  amount: number;
  retryMs: number;
  row: Omit<QuotaUsageRow, "used" | "reserved">;
}

export class RedisReserver implements Reserver {
  private readonly p: string;
  private readonly ttl: number;
  private readonly seeded = new Set<string>();

  constructor(
    private readonly redis: RedisLike,
    private readonly opts: RedisReserverOptions = {},
  ) {
    this.p = opts.prefix ?? "";
    this.ttl = opts.reservationTtlMs ?? 600_000;
  }

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  private async eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown> {
    const argv = [String(keys.length), ...keys, ...args.map(String)];
    try {
      return await this.redis.send("EVALSHA", [sha(script), ...argv]);
    } catch (e) {
      if (!String((e as Error).message).includes("NOSCRIPT")) throw e;
      return this.redis.send("EVAL", [script, ...argv]);
    }
  }

  /** Quota yang berlaku untuk pasangan (connector, account) + estimasi unit. */
  quotaChecks(snap: Snapshot, c: ConnectorInfo, a: Account, input: RouteInput): QuotaCheck[] {
    const now = new Date(this.now());
    const scopes: [QuotaRule["scopeType"], string | null][] = [
      ["global", null],
      ["provider", c.providerId],
      ["connector", c.id],
      ["provider_account", a.id],
    ];
    // run collection stream = system-owned → quota tenant/topic diatribusikan belakangan (ADR-009, I-25)
    if (!input.sharedPoolOnly) scopes.push(["tenant", input.tenantId]);
    if (!input.sharedPoolOnly && input.topicId) scopes.push(["topic", input.topicId]);
    const amounts: Record<QuotaUnit, number> = {
      requests: input.estimatedUnits.requests,
      results: input.estimatedUnits.results,
      cost_units: estimatedRunCost(c, input) ?? 0,
    };
    const out: QuotaCheck[] = [];
    for (const [type, id] of scopes) {
      for (const rule of snap.quotas.get(scopeKey(type, id)) ?? []) {
        const pi = periodInfo(rule.period, rule.resetTz, now);
        out.push({
          key: `${this.p}quota:${type}:${id ?? "*"}:${pi.start}:${rule.unit}`,
          rule,
          amount: amounts[rule.unit],
          retryMs: pi.resetInMs,
          row: { scopeType: type, scopeId: id, period: rule.period, periodStart: pi.startDate, unit: rule.unit },
        });
      }
    }
    return out;
  }

  private async ensureSeeded(checks: QuotaCheck[]): Promise<void> {
    const missing = checks.filter((q) => !this.seeded.has(q.key));
    if (!missing.length) return;
    if (this.opts.seed) {
      const exists = await Promise.all(missing.map((q) => this.redis.send("EXISTS", [q.key])));
      const absent = missing.filter((_, i) => Number(exists[i]) === 0);
      if (absent.length) {
        const rows = await this.opts.seed(absent.map((q) => q.row));
        await Promise.all(
          absent.map((q, i) => (rows[i] && rows[i]!.used > 0 ? this.redis.send("HSETNX", [q.key, "used", String(rows[i]!.used)]) : null)),
        );
      }
    }
    for (const q of missing) this.seeded.add(q.key);
  }

  async tryReserve(p: Parameters<Reserver["tryReserve"]>[0]): Promise<ReserveResult> {
    const { snapshot: snap, connector: c, account: a, input } = p;
    const quotas = this.quotaChecks(snap, c, a, input);
    await this.ensureSeeded(quotas);
    const limits = [
      ...(snap.rateLimits.get(scopeKey("provider", c.providerId)) ?? []),
      ...(snap.rateLimits.get(scopeKey("connector", c.id)) ?? []),
      ...(snap.rateLimits.get(scopeKey("provider_account", a.id)) ?? []),
    ];
    const buckets = limits.filter((l) => l.algorithm !== "concurrency");
    const sems = limits.filter((l) => l.algorithm === "concurrency");
    const dyn = [c.providerId, c.id, a.id].map((id) => `${this.p}rl:dyn:${id}`);
    const id = Bun.randomUUIDv7();
    const cost = (cap: number) => Math.max(1, Math.min(cap, input.estimatedUnits.requests));
    const keys = [
      `${this.p}resv:${id}`,
      `${this.p}resv:pending`,
      ...dyn,
      ...buckets.map((b) => `${this.p}rl:${b.scopeType}:${b.scopeId}`),
      ...quotas.map((q) => q.key),
      ...sems.map((s) => `${this.p}sem:${s.scopeId}`),
    ];
    const args: (string | number)[] = [this.now(), id, this.ttl, dyn.length, buckets.length, quotas.length, sems.length];
    for (const b of buckets) args.push(b.capacity, b.refillTokens, b.refillIntervalMs, cost(b.capacity));
    for (const q of quotas)
      args.push(q.rule.limit, q.amount, q.rule.hard ? 1 : 0, Math.ceil((q.retryMs + 7 * 86_400_000) / 1000), q.retryMs);
    for (const s of sems) args.push(s.capacity);
    const [status, retry] = ((await this.eval(RESERVE, keys, args)) as number[]).map(Number) as [number, number];
    if (status === 0) return { ok: true, reservationId: id };
    return { ok: false, reason: status === 1 ? "QUOTA" : "THROTTLED", retryAfterMs: Math.max(0, retry) };
  }

  private async settle(reservationId: string, commit: boolean, usage = { requests: 0, results: 0, costUnits: 0 }, snap?: Snapshot) {
    const out = (await this.eval(
      SETTLE,
      [`${this.p}resv:${reservationId}`, `${this.p}resv:pending`, `${this.p}quota:dirty`],
      [reservationId, commit ? 1 : 0, usage.requests, usage.results, usage.costUnits],
    )) as (string | number)[];
    if (Number(out[0]) !== 1) return false;
    if (commit && snap && this.opts.onThreshold) {
      for (let i = 1; i < out.length; i += 3) this.emitThresholds(snap, String(out[i]), Number(out[i + 1]), Number(out[i + 2]));
    }
    return true;
  }

  private emitThresholds(snap: Snapshot, key: string, before: number, after: number) {
    const [scopeType, scopeId, start, unit] = key.slice(this.p.length + "quota:".length).split(":") as [string, string, string, QuotaUnit];
    const period = start.length === 7 ? "month" : "day";
    for (const rule of snap.quotas.get(scopeKey(scopeType, scopeId === "*" ? null : scopeId)) ?? []) {
      if (rule.unit !== unit || rule.period !== period || rule.limit <= 0) continue;
      for (const t of rule.alertThresholds) {
        const at = (rule.limit * t) / 100;
        if (before < at && after >= at) this.opts.onThreshold!({ rule, key, threshold: t, used: after });
      }
    }
  }

  /** Setelah call: potong `reserved` estimasi, tambah `used` aktual. Idempoten (false bila sudah di-settle). */
  commit(reservationId: string, usage: { requests: number; results: number; costUnits: number | null }, snap?: Snapshot): Promise<boolean> {
    return this.settle(reservationId, true, { ...usage, costUnits: usage.costUnits ?? 0 }, snap);
  }

  /** Reservasi lolos tapi request tidak terkirim → kembalikan semuanya. Idempoten. */
  release(reservationId: string): Promise<boolean> {
    return this.settle(reservationId, false);
  }

  /**
   * I-25: biaya run stream yang dialokasikan ke tenant → counter quota tenant (semua periode/unit yang berlaku),
   * supaya hard quota & cost guard per tenant ikut menghitung biaya stream. Idempoten per (run, tenant) lewat penanda.
   */
  async applyTenantUsage(
    snap: Snapshot,
    a: { runId: string; tenantId: string; requests: number; results: number; costUnits: number },
  ): Promise<boolean> {
    const marker = `${this.p}alloc:${a.runId}:${a.tenantId}`;
    if ((await this.redis.send("SET", [marker, "1", "NX", "EX", String(14 * 86_400)])) !== "OK") return false;
    const now = new Date(this.now());
    const amounts: Record<QuotaUnit, number> = { requests: a.requests, results: a.results, cost_units: a.costUnits };
    for (const rule of snap.quotas.get(scopeKey("tenant", a.tenantId)) ?? []) {
      const amount = amounts[rule.unit];
      if (!(amount > 0)) continue;
      const pi = periodInfo(rule.period, rule.resetTz, now);
      const key = `${this.p}quota:tenant:${a.tenantId}:${pi.start}:${rule.unit}`;
      const before = Number((await this.redis.send("HGET", [key, "used"])) ?? 0);
      const after = Number(await this.redis.send("HINCRBYFLOAT", [key, "used", String(amount)]));
      await this.redis.send("EXPIRE", [key, String(Math.ceil((pi.resetInMs + 7 * 86_400_000) / 1000))]);
      await this.redis.send("SADD", [`${this.p}quota:dirty`, key]);
      if (this.opts.onThreshold) this.emitThresholds(snap, key, before, after);
    }
    return true;
  }

  /** Sweeper (worker-ops tiap ~30 s): release reservasi yang lewat deadline. */
  async sweep(limit = 500): Promise<number> {
    const ids = (await this.redis.send("ZRANGEBYSCORE", [
      `${this.p}resv:pending`,
      "-inf",
      String(this.now()),
      "LIMIT",
      "0",
      String(limit),
    ])) as string[];
    let n = 0;
    for (const id of ids) if (await this.release(id)) n++;
    return n;
  }

  /** Retry-After / header provider → `rl:dyn:{scopeId}` (CONNECTOR_SPEC §10). Hanya memperpanjang. */
  async setDynamicLimit(scopeId: string, retryAfterMs: number): Promise<void> {
    if (retryAfterMs <= 0) return;
    await this.eval(DYN, [`${this.p}rl:dyn:${scopeId}`], [this.now() + retryAfterMs, retryAfterMs]);
  }

  /** Ambil kunci quota yang berubah + nilainya untuk di-flush ke Postgres (SPOP → at-most-once; gagal flush → panggil markDirty). */
  async drainDirty(max = 500): Promise<QuotaUsageRow[]> {
    const keys = ((await this.redis.send("SPOP", [`${this.p}quota:dirty`, String(max)])) as string[] | null) ?? [];
    const rows: QuotaUsageRow[] = [];
    for (const key of keys) {
      const [used, reserved] = (await this.redis.send("HMGET", [key, "used", "reserved"])) as (string | null)[];
      const [scopeType, scopeId, start, unit] = key.slice(this.p.length + "quota:".length).split(":") as [
        string,
        string,
        string,
        QuotaUnit,
      ];
      const month = start.length === 7;
      rows.push({
        scopeType,
        scopeId: scopeId === "*" ? null : scopeId,
        period: month ? "month" : "day",
        periodStart: month ? `${start}-01` : start,
        unit,
        used: Number(used ?? 0),
        reserved: Math.max(0, Number(reserved ?? 0)),
      });
    }
    return rows;
  }

  async markDirty(rows: QuotaUsageRow[]): Promise<void> {
    if (!rows.length) return;
    const keys = rows.map(
      (r) =>
        `${this.p}quota:${r.scopeType}:${r.scopeId ?? "*"}:${r.period === "month" ? r.periodStart.slice(0, 7) : r.periodStart}:${r.unit}`,
    );
    await this.redis.send("SADD", [`${this.p}quota:dirty`, ...keys]);
  }
}
