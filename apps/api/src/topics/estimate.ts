// FR-T05 cost estimate (CONNECTOR_SPEC §5, COST_MODEL §3): per platform memakai connector UTAMA policy.
//   requests/hari = Σ_query sub_query × (86400 / interval) × halaman_rata2
//   hasil/hari    = estimasi_match_per_hari (preview) × overhead platform
//   usd/hari      = hasil × tarif/hasil + requests × minimum/request + run × biaya tetap/run
// Tarif hanya dari `connector_capabilities.measured` (TESTED/DOCS via verify) — tanpa tarif → `unverified_rates`.
import type { QueryFeature } from "@smip/contracts";
import { type CompiledQuery, compileGeneric, coverHashtags } from "@smip/query";

export interface ConnectorRates {
  queryFeatures: QueryFeature[];
  maxQueryLength: number | null;
  avgPages?: number;
  costPer1kResults?: number;
  minCostPerRequest?: number;
  fixedCostPerRun?: number;
  minIntervalSec?: number;
}

/** COST_MODEL §3: overhead fetch inkremental (overlap window / filter timestamp lokal). */
export const PLATFORM_OVERHEAD: Record<string, number> = { x: 1.1, youtube: 1.1 };
const DEFAULT_OVERHEAD = 1.4;

export interface EstimatePlatform {
  code: string;
  intervalSec: number;
  operations: string[];
  queries: CompiledQuery[];
}

export interface PlatformEstimate {
  requests: number;
  results: number | null;
  usd: number | null;
  runs: number;
}
export interface CostEstimate {
  requests_per_day: number;
  results_per_day: number | null;
  usd_per_day: number | null;
  unverified_rates: string[];
  by_platform: Record<string, PlatformEstimate>;
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export function estimateCost(
  platforms: EstimatePlatform[],
  primary: (platform: string, operation: string) => ConnectorRates | undefined,
  matchesPerDay: (platform: string) => number | null,
): CostEstimate {
  const by: Record<string, PlatformEstimate> = {};
  const unverified = new Set<string>();
  let reqTotal = 0;
  let resTotal: number | null = 0;
  let usdTotal: number | null = 0;
  for (const p of platforms) {
    const perDay = 86_400 / p.intervalSec;
    let requests = 0;
    let runs = 0;
    let usd: number | null = 0;
    let anyRate = false;
    const matches = matchesPerDay(p.code);
    const results = matches === null ? null : Math.round(matches * (PLATFORM_OVERHEAD[p.code] ?? DEFAULT_OVERHEAD));
    for (const op of p.operations) {
      const c = primary(p.code, op);
      const caps = { queryFeatures: c?.queryFeatures ?? ["term"], maxQueryLength: c?.maxQueryLength ?? null };
      const subq = p.queries.reduce((a, q) => {
        const { version: _v, ...ast } = q.ast;
        return a + (op === "search_hashtag" ? coverHashtags(ast).length : compileGeneric(ast, caps).length);
      }, 0);
      const opRuns = p.queries.length * perDay;
      const opReq = subq * perDay * (c?.avgPages ?? 1);
      runs += opRuns;
      requests += opReq;
      if (!c || (c.costPer1kResults === undefined && c.minCostPerRequest === undefined && c.fixedCostPerRun === undefined)) {
        unverified.add(p.code);
        usd = null;
        continue;
      }
      anyRate = true;
      if (usd !== null) {
        usd += opReq * (c.minCostPerRequest ?? 0) + opRuns * (c.fixedCostPerRun ?? 0);
        // hasil dibagi rata antar operation platform (estimasi kasar; preview tidak membedakan operation)
        if (results !== null) usd += ((results / p.operations.length) * (c.costPer1kResults ?? 0)) / 1000;
      }
    }
    if (!anyRate) usd = null;
    by[p.code] = { requests: Math.round(requests), results, usd: usd === null ? null : round(usd), runs: Math.round(runs) };
    reqTotal += requests;
    resTotal = resTotal === null || results === null ? null : resTotal + results;
    usdTotal = usdTotal === null || usd === null ? null : usdTotal + usd;
  }
  return {
    requests_per_day: Math.round(reqTotal),
    results_per_day: resTotal,
    usd_per_day: usdTotal === null ? null : round(usdTotal),
    unverified_rates: [...unverified].sort(),
    by_platform: by,
  };
}

export const INTERVALS = [300, 900, 1800, 2700, 3600] as const;

/** Clamp ke atas ke interval yang didukung (plan & capability tidak boleh dilanggar). */
export function clampInterval(requested: number, floors: (number | undefined)[]): { effective: number; clamped: boolean } {
  const need = Math.max(requested, ...floors.filter((x): x is number => x !== undefined));
  const effective = INTERVALS.find((i) => i >= need) ?? 3600;
  return { effective, clamped: effective !== requested };
}
