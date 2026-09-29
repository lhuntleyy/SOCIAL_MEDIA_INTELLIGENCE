// Verifikasi capability connector (CONNECTOR_SPEC §9, S-14) — dipakai `scripts/connectors.ts verify` DAN konsumen
// `connector.verify` (Admin API I-21). Memanggil provider SUNGGUHAN (bisa berbayar): jumlah sampel dibatasi pemanggil.
import { type Connector, type ConnectorContext, HttpClient } from "@smip/connector-sdk";
import { CanonicalItem, type Operation } from "@smip/contracts";
import type { AccountMaterial } from "./accounts";

export interface VerifyOptions {
  query: string;
  samples: number;
  maxItems: number;
  windowHours: number;
  operation?: Operation;
  /** Batas waktu per sampel (termasuk polling async). */
  sampleTimeoutMs?: number;
}

export interface VerifyReport {
  date: string;
  connector: string;
  version: string;
  operation: Operation;
  query: string;
  window_hours: number;
  max_items: number;
  samples: number;
  items_valid: number;
  items_invalid: number;
  usage_results_returned: number;
  cost_usd: number;
  since_respected: boolean;
  returns_fields_rate: Record<string, number>;
  latency_ms: { samples: number[]; p50: number | null; p95: number | null };
  status: "verified" | "failed";
  note: string | null;
}

function pathValue(o: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((a, k) => (a && typeof a === "object" ? (a as Record<string, unknown>)[k] : undefined), o);
}

export async function runVerify(c: Connector, acc: AccountMaterial, o: VerifyOptions): Promise<VerifyReport> {
  const op = o.operation ?? ((Object.keys(c.manifest.operations).find((k) => k.startsWith("search_")) ?? "search_keyword") as Operation);
  const sup = c.manifest.operations[op];
  if (!sup || !op.startsWith("search_")) throw new Error(`verify hanya untuk operation search_* (connector ${c.manifest.key}: ${op})`);
  const until = new Date();
  const since = new Date(until.getTime() - o.windowHours * 3600_000);
  const lat: number[] = [];
  const all: CanonicalItem[] = [];
  let returned = 0;
  let cost = 0;
  let invalid = 0;
  for (let i = 0; i < o.samples; i++) {
    const ctx: ConnectorContext = {
      credential: acc.credential,
      config: acc.config,
      http: new HttpClient({ allowedHosts: c.manifest.allowedHosts ?? [], timeoutMs: 90_000 }),
      logger: { debug() {}, info() {}, warn() {}, error() {}, child: () => ctx.logger } as never,
      signal: AbortSignal.timeout(o.sampleTimeoutMs ?? 300_000),
      reportRateLimit: () => {},
      archiveRaw: async () => "verify://tidak-diarsip",
    };
    const req = {
      requestId: Bun.randomUUIDv7(),
      idempotencyKey: `verify.${Date.now()}.${i}`,
      platform: c.manifest.platform,
      operation: op,
      query: { native: o.query, sourceNodeIds: [] },
      window: { since: since.toISOString(), until: until.toISOString() },
      cursor: null,
      pageLimit: 1,
      maxItems: o.maxItems,
    };
    const t0 = performance.now();
    let r = await c.fetch(req, ctx);
    while (r.asyncHandle && c.resume) {
      await Bun.sleep(r.asyncHandle.pollAfterMs);
      r = await c.resume(r.asyncHandle, ctx, req);
    }
    lat.push(Math.round(performance.now() - t0));
    returned += r.usage.results;
    cost += r.usage.costUnits ?? 0;
    for (const it of r.items) {
      if (CanonicalItem.safeParse(it).success) all.push(it);
      else invalid++;
    }
  }
  const fieldRate = Object.fromEntries(
    sup.returnsFields.map((f) => [
      f,
      all.length ? all.filter((it) => pathValue(it, f) !== null && pathValue(it, f) !== undefined).length / all.length : 0,
    ]),
  );
  const sinceOk = all.every((it) => it.published_at >= since.toISOString());
  const sorted = [...lat].sort((a, b) => a - b);
  const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] ?? null;
  const pass = all.length > 0 && invalid === 0 && sinceOk && Object.values(fieldRate).every((v) => v >= 0.8);
  return {
    date: new Date().toISOString(),
    connector: c.manifest.key,
    version: c.manifest.version,
    operation: op,
    query: o.query,
    window_hours: o.windowHours,
    max_items: o.maxItems,
    samples: o.samples,
    items_valid: all.length,
    items_invalid: invalid,
    usage_results_returned: returned,
    cost_usd: Number(cost.toFixed(6)),
    since_respected: sinceOk,
    returns_fields_rate: fieldRate,
    latency_ms: { samples: lat, p50: p(0.5), p95: p(0.95) },
    status: pass ? "verified" : "failed",
    note: o.samples < 5 ? "p95 dari < 5 sampel belum memenuhi S-14 (≥ 5)" : null,
  };
}

/** Kolom `connector_capabilities.measured` dari laporan verify. */
export const measuredOf = (r: VerifyReport) => ({
  p50_latency_ms: r.latency_ms.p50,
  p95_latency_ms: r.latency_ms.p95,
  sample_size: r.samples,
  returns_fields_rate: r.returns_fields_rate,
});
