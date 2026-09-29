// I-11: health per (connector, account) — CONNECTOR_SPEC §8.
//  - passive: setiap attempt → `hw:{c}:{a}` (ring buffer, window 5 m); RATE_LIMITED/QUOTA tidak dihitung
//  - circuit breaker `cb:{c}:{a}`: closed → open (failure berbobot ≥ N atau success rate < X) → half_open setelah
//    cooldown (lazy, dihitung saat baca) → closed setelah M probe sukses / open lagi dengan cooldown ×2 (cap)
//  - half_open: maks 1 probe inflight (claimProbe atomik)
//  - HealthCache: salinan di memori untuk selector (sinkron), di-refresh worker tiap ~5–30 s.
import type { RedisLike } from "./reserve";
import type { HealthState, HealthView } from "./select";
import type { Snapshot } from "./snapshot";

export interface HealthConfig {
  failures: number; // N
  minSuccessRate: number; // X
  probeSuccesses: number; // M
  cooldownMs: number;
  cooldownCapMs: number;
  windowMs: number;
  probeLeaseMs: number;
}
export const DEFAULT_HEALTH: HealthConfig = {
  failures: 5,
  minSuccessRate: 0.5,
  probeSuccesses: 2,
  cooldownMs: 60_000,
  cooldownCapMs: 30 * 60_000,
  windowMs: 5 * 60_000,
  probeLeaseMs: 120_000,
};

const LAZY_STATE = `
local function state(key, now)
  local h = redis.call('HMGET', key, 'state', 'opened_at', 'cooldown')
  local st = h[1] or 'closed'
  local cool = tonumber(h[3] or '0')
  if st == 'open' and now >= tonumber(h[2] or '0') + cool then st = 'half_open' end
  return st, cool
end
`;

// KEYS: hw, cb · ARGV: now, ok, latency, weight, window, N, X, M, cooldown, cap
const RECORD = `${LAZY_STATE}
local now, ok, lat, w = tonumber(ARGV[1]), ARGV[2] == '1', ARGV[3], tonumber(ARGV[4])
local win, N, X, M, cd, cap = tonumber(ARGV[5]), tonumber(ARGV[6]), tonumber(ARGV[7]), tonumber(ARGV[8]), tonumber(ARGV[9]), tonumber(ARGV[10])
local st, cool = state(KEYS[2], now)
local from = st
if st == 'half_open' then redis.call('HDEL', KEYS[2], 'inflight') end
if not ok and w == 0 then return {from, st} end
redis.call('LPUSH', KEYS[1], now .. '|' .. (ok and 1 or 0) .. '|' .. lat .. '|' .. w)
redis.call('LTRIM', KEYS[1], 0, 499)
redis.call('PEXPIRE', KEYS[1], win * 2)
if st == 'half_open' then
  if ok then
    if redis.call('HINCRBY', KEYS[2], 'probe_ok', 1) >= M then
      st = 'closed'
      redis.call('DEL', KEYS[2])
      redis.call('DEL', KEYS[1])
    end
  else
    st = 'open'
    redis.call('HSET', KEYS[2], 'state', 'open', 'opened_at', now, 'cooldown', math.min(math.max(cool, cd) * 2, cap), 'probe_ok', 0)
  end
elseif st == 'closed' and not ok then
  local items = redis.call('LRANGE', KEYS[1], 0, -1)
  local fail, total, succ = 0, 0, 0
  for _, it in ipairs(items) do
    local ts, o, _, iw = string.match(it, '^(%d+)|(%d)|([%d.]+)|(%d+)$')
    if ts and tonumber(ts) >= now - win then
      total = total + 1
      if o == '1' then succ = succ + 1 else fail = fail + tonumber(iw) end
    end
  end
  if fail >= N or (total >= N and succ / total < X) then
    st = 'open'
    redis.call('HSET', KEYS[2], 'state', 'open', 'opened_at', now, 'cooldown', cd, 'probe_ok', 0)
  end
end
return {from, st}
`;

// KEYS: cb · ARGV: now, lease
const CLAIM = `${LAZY_STATE}
local now = tonumber(ARGV[1])
local st = state(KEYS[1], now)
if st == 'closed' then return 1 end
if st == 'open' then return 0 end
local cur = tonumber(redis.call('HGET', KEYS[1], 'inflight') or '0')
if cur > now then return 0 end
redis.call('HSET', KEYS[1], 'inflight', now + tonumber(ARGV[2]))
return 1
`;

const sha = (s: string) => new Bun.CryptoHasher("sha1").update(s).digest("hex");

export type HealthLabel = "healthy" | "degraded" | "unhealthy" | "unknown";
export interface HealthDetail extends HealthState {
  state: HealthLabel;
  successRate: number | null;
  p95LatencyMs: number | null;
  samples: number;
  openedAt: number | null;
  cooldownMs: number | null;
}
export interface Transition {
  connectorId: string;
  accountId: string;
  from: HealthState["circuit"];
  to: HealthState["circuit"];
}

export function labelOf(circuit: HealthState["circuit"], score: number | null, samples: number): HealthLabel {
  if (circuit === "open" || (score !== null && score < 40)) return "unhealthy";
  if (circuit === "half_open") return "degraded";
  if (score === null || samples === 0) return "unknown";
  return score >= 80 ? "healthy" : "degraded";
}

export class HealthMonitor {
  private readonly p: string;
  readonly cfg: HealthConfig;
  constructor(
    private readonly redis: RedisLike,
    private readonly opts: {
      prefix?: string;
      config?: Partial<HealthConfig>;
      now?: () => number;
      onTransition?: (t: Transition) => void;
    } = {},
  ) {
    this.p = opts.prefix ?? "";
    this.cfg = { ...DEFAULT_HEALTH, ...opts.config };
  }
  private now() {
    return (this.opts.now ?? Date.now)();
  }
  private async eval(script: string, keys: string[], args: (string | number)[]) {
    const argv = [String(keys.length), ...keys, ...args.map(String)];
    try {
      return await this.redis.send("EVALSHA", [sha(script), ...argv]);
    } catch (e) {
      if (!String((e as Error).message).includes("NOSCRIPT")) throw e;
      return this.redis.send("EVAL", [script, ...argv]);
    }
  }
  private keys(c: string, a: string) {
    return { hw: `${this.p}hw:${c}:${a}`, cb: `${this.p}cb:${c}:${a}` };
  }

  /** Catat outcome attempt. `failureWeight` dari decideFailover (0 = tidak dihitung). */
  async record(
    connectorId: string,
    accountId: string,
    o: { ok: boolean; latencyMs: number; failureWeight: 0 | 1 | 2 },
    /** Override per connector (snapshot `ConnectorInfo.health`); nilai tak valid diabaikan. */
    override?: Partial<HealthConfig>,
  ): Promise<Transition | null> {
    const k = this.keys(connectorId, accountId);
    const c = { ...this.cfg };
    for (const [key, v] of Object.entries(override ?? {}))
      if (typeof v === "number" && Number.isFinite(v) && v > 0 && key in c) (c as Record<string, number>)[key] = v;
    // bobot 2 (PARSE_ERROR) = "circuit open cepat, threshold 2" (§7): 2 kejadian sudah ≥ N
    const weight = o.failureWeight === 2 ? Math.ceil(c.failures / 2) : o.failureWeight;
    const [from, to] = (await this.eval(
      RECORD,
      [k.hw, k.cb],
      [
        this.now(),
        o.ok ? 1 : 0,
        Math.round(o.latencyMs),
        o.ok ? 0 : weight,
        c.windowMs,
        c.failures,
        c.minSuccessRate,
        c.probeSuccesses,
        c.cooldownMs,
        c.cooldownCapMs,
      ],
    )) as [HealthState["circuit"], HealthState["circuit"]];
    if (from === to) return null;
    const t = { connectorId, accountId, from, to };
    this.opts.onTransition?.(t);
    return t;
  }

  /** half_open: klaim satu-satunya slot probe. closed → selalu true; open → false. */
  async claimProbe(connectorId: string, accountId: string): Promise<boolean> {
    const k = this.keys(connectorId, accountId);
    return Number(await this.eval(CLAIM, [k.cb], [this.now(), this.cfg.probeLeaseMs])) === 1;
  }
  async releaseProbe(connectorId: string, accountId: string): Promise<void> {
    await this.redis.send("HDEL", [this.keys(connectorId, accountId).cb, "inflight"]);
  }

  /** Hitung detail health: score = round(100 × success_rate × min(1, SLO / p95)), SLO = measured p95 × 2. */
  async read(connectorId: string, accountId: string, measuredP95Ms?: number): Promise<HealthDetail> {
    const k = this.keys(connectorId, accountId);
    const now = this.now();
    const [[st, openedAt, cooldown, inflight], items] = (await Promise.all([
      this.redis.send("HMGET", [k.cb, "state", "opened_at", "cooldown", "inflight"]),
      this.redis.send("LRANGE", [k.hw, "0", "-1"]),
    ])) as [(string | null)[], string[]];
    let circuit = (st ?? "closed") as HealthState["circuit"];
    if (circuit === "open" && now >= Number(openedAt) + Number(cooldown)) circuit = "half_open";
    const recent = items
      .map((s) => s.split("|").map(Number) as [number, number, number, number])
      .filter(([ts]) => ts >= now - this.cfg.windowMs);
    const samples = recent.length;
    const okLat = recent
      .filter(([, ok]) => ok === 1)
      .map(([, , lat]) => lat)
      .sort((a, b) => a - b);
    const successRate = samples ? okLat.length / samples : null;
    const p95 = okLat.length ? okLat[Math.min(okLat.length - 1, Math.ceil(okLat.length * 0.95) - 1)]! : null;
    const penalty = measuredP95Ms && p95 ? Math.min(1, (measuredP95Ms * 2) / p95) : 1;
    const score = successRate === null ? null : Math.round(100 * successRate * penalty);
    return {
      circuit,
      score,
      probeInflight: Number(inflight ?? 0) > now,
      state: labelOf(circuit, score, samples),
      successRate,
      p95LatencyMs: p95,
      samples,
      openedAt: openedAt ? Number(openedAt) : null,
      cooldownMs: cooldown ? Number(cooldown) : null,
    };
  }
}

/** HealthView sinkron untuk selector; `refresh(snapshot)` membaca semua pasangan (connector × akun) dari Redis. */
export class HealthCache implements HealthView {
  private map = new Map<string, HealthDetail>();
  constructor(private readonly monitor: HealthMonitor) {}

  get(connectorId: string, accountId: string): HealthState {
    return this.map.get(`${connectorId}/${accountId}`) ?? { circuit: "closed", score: null };
  }
  detail(connectorId: string, accountId: string): HealthDetail | undefined {
    return this.map.get(`${connectorId}/${accountId}`);
  }
  claimProbe(connectorId: string, accountId: string) {
    return this.monitor.claimProbe(connectorId, accountId);
  }
  releaseProbe(connectorId: string, accountId: string) {
    return this.monitor.releaseProbe(connectorId, accountId);
  }

  async refresh(snap: Snapshot): Promise<Map<string, HealthDetail>> {
    const jobs: Promise<[string, HealthDetail]>[] = [];
    for (const c of snap.connectors.values()) {
      const p95 = [...c.capabilities.values()].map((x) => x.measured.p95LatencyMs).find((x) => x !== undefined);
      for (const a of snap.accountsByProvider.get(c.providerId) ?? []) {
        jobs.push(this.monitor.read(c.id, a.id, p95).then((d) => [`${c.id}/${a.id}`, d]));
      }
    }
    this.map = new Map(await Promise.all(jobs));
    return this.map;
  }
}
