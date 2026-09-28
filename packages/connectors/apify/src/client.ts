// Klien Apify bersama untuk semua connector berbasis actor (I-17). Fakta API: docs.apify.com/api/v2
// (run actor, `waitForFinish` ≤ 60 s, `maxTotalChargeUsd`, `memory`, dataset items). Semua HTTP lewat ctx.http
// (SSRF guard + allowlist api.apify.com). Token dari credential `{ api_token }` — tidak pernah di-log.
import { type ConnectorContext, ConnectorError } from "@smip/connector-sdk";

export const APIFY_API = "https://api.apify.com/v2";
export const APIFY_HOSTS = ["api.apify.com"];

export interface RunOptions {
  /** MB — start fee Apify ditagih PER GB memori (COST_MODEL §3): set minimum yang lolos uji. */
  memoryMb?: number;
  /** Cost guard lapis 0: Apify menghentikan run bila biaya menyentuh angka ini (config operator). */
  maxTotalChargeUsd?: number;
  timeoutSecs?: number;
  /** Detik menunggu run selesai di request start/poll (API: maks 60). */
  waitSecs: number;
}

export interface ApifyRun {
  id: string;
  status: "READY" | "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMING-OUT" | "TIMED-OUT" | "ABORTING" | "ABORTED";
  defaultDatasetId: string;
  startedAt?: string;
  usageTotalUsd?: number;
  statusMessage?: string;
}

export const RUNNING = new Set(["READY", "RUNNING", "TIMING-OUT", "ABORTING"]);

function token(ctx: ConnectorContext): string {
  const t = ctx.credential.secret.api_token;
  if (!t) throw new ConnectorError("AUTH_INVALID", "credential Apify tanpa api_token", { scope: "account" });
  return t;
}

async function call<T>(ctx: ConnectorContext, path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const res = await ctx.http.request(`${APIFY_API}${path}`, {
    ...init,
    signal: ctx.signal,
    headers: { Authorization: `Bearer ${token(ctx)}`, "content-type": "application/json", ...init.headers },
  });
  try {
    return (await res.json()) as T;
  } catch (e) {
    throw new ConnectorError("PARSE_ERROR", "respons Apify bukan JSON", { cause: e });
  }
}

const actorPath = (actorId: string) => actorId.replace("/", "~");

export async function startRun(ctx: ConnectorContext, actorId: string, input: unknown, o: RunOptions): Promise<ApifyRun> {
  const qs = new URLSearchParams({ waitForFinish: String(Math.min(60, Math.max(0, Math.floor(o.waitSecs)))) });
  if (o.memoryMb) qs.set("memory", String(o.memoryMb));
  if (o.maxTotalChargeUsd !== undefined) qs.set("maxTotalChargeUsd", String(o.maxTotalChargeUsd));
  if (o.timeoutSecs) qs.set("timeout", String(o.timeoutSecs));
  return (await call<{ data: ApifyRun }>(ctx, `/acts/${actorPath(actorId)}/runs?${qs}`, { method: "POST", body: JSON.stringify(input) }))
    .data;
}

export async function getRun(ctx: ConnectorContext, runId: string, waitSecs: number): Promise<ApifyRun> {
  const w = Math.min(60, Math.max(0, Math.floor(waitSecs)));
  return (await call<{ data: ApifyRun }>(ctx, `/actor-runs/${encodeURIComponent(runId)}?waitForFinish=${w}`)).data;
}

export async function datasetItems(ctx: ConnectorContext, datasetId: string, limit: number): Promise<unknown[]> {
  return call<unknown[]>(ctx, `/datasets/${encodeURIComponent(datasetId)}/items?clean=true&format=json&limit=${limit}`);
}

/** Status akhir non-sukses → ConnectorError terklasifikasi (router memutuskan failover). */
export function failIfBad(run: ApifyRun): void {
  if (run.status === "SUCCEEDED" || RUNNING.has(run.status)) return;
  const msg = `run Apify ${run.status}${run.statusMessage ? `: ${run.statusMessage.slice(0, 200)}` : ""}`;
  if (run.status === "TIMED-OUT") throw new ConnectorError("TIMEOUT", msg, { scope: "connector" });
  // ABORTED biasanya karena maxTotalChargeUsd tercapai / dibatalkan → bukan salah akun
  throw new ConnectorError("UPSTREAM_5XX", msg, { scope: "connector" });
}

/** Log run (gratis) — dipakai hanya untuk mendiagnosis run tanpa hasil nyata. */
export async function runLog(ctx: ConnectorContext, runId: string): Promise<string> {
  const res = await ctx.http.request(`${APIFY_API}/actor-runs/${encodeURIComponent(runId)}/log`, {
    signal: ctx.signal,
    headers: { Authorization: `Bearer ${token(ctx)}` },
  });
  return (await res.text()).slice(-20_000);
}

/** Pola log actor saat batas plan pengguna habis (teramati 2026-09-29: apidojo "Monthly run limit exceeded per user"). */
export const PLAN_LIMIT_LOG = /monthly run limit exceeded|subscribe to a paid plan on apify if you want to use it without/i;
