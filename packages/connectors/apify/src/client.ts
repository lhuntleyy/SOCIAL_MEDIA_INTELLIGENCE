// Klien Apify bersama untuk semua connector berbasis actor (I-17). Fakta API: docs.apify.com/api/v2
// (run actor, `waitForFinish` ≤ 60 s, `maxTotalChargeUsd`, `memory`, dataset items). Semua HTTP lewat ctx.http
// (SSRF guard + allowlist api.apify.com). Token dari credential `{ api_token }` — tidak pernah di-log.
import { type ConnectorContext, ConnectorError, codeForStatus, parseRetryAfter } from "@smip/connector-sdk";

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

/** Tipe error 402 Apify yang SEMENTARA: batas memori/run bersamaan plan (hilang saat run lain selesai) — bukan kredit habis. */
export const TRANSIENT_402 = /actor-memory-limit-exceeded|concurrent-runs-limit|memory limit/i;
/** Jeda sebelum mencoba lagi saat batas memori plan penuh (kebijakan internal; run Apify biasanya selesai < 1 menit). */
export const MEMORY_LIMIT_RETRY_MS = 30_000;

async function call<T>(ctx: ConnectorContext, path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const res = await ctx.http.request(`${APIFY_API}${path}`, {
    ...init,
    signal: ctx.signal,
    throwOnStatus: false,
    headers: { Authorization: `Bearer ${token(ctx)}`, "content-type": "application/json", ...init.headers },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const type = /"type"\s*:\s*"([^"]+)"/.exec(body)?.[1] ?? "";
    // 402 dua makna (teramati live 2026-09-30, 8 run paralel di plan FREE): batas memori → RATE_LIMITED (akun ditahan sebentar,
    // router menjadwalkan ulang); kredit habis → QUOTA_EXHAUSTED.
    if (res.status === 402 && TRANSIENT_402.test(`${type} ${body}`))
      throw new ConnectorError("RATE_LIMITED", `Apify: batas memori run bersamaan plan tercapai (${type || "402"})`, {
        httpStatus: 402,
        retryAfterMs: MEMORY_LIMIT_RETRY_MS,
        scope: "account",
      });
    // 403 = izin untuk actor/run tertentu; satu token dipakai semua actor → scope connector (akun tetap dipakai actor lain).
    // Token tidak valid = 401 (AUTH_INVALID, scope akun).
    throw new ConnectorError(codeForStatus(res.status), `HTTP ${res.status}${type ? ` ${type}` : ""}`, {
      httpStatus: res.status,
      retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
      ...(res.status === 403 ? { scope: "connector" as const } : {}),
    });
  }
  try {
    return (await res.json()) as T;
  } catch (e) {
    throw new ConnectorError("PARSE_ERROR", "respons Apify bukan JSON", { cause: e });
  }
}

const actorPath = (actorId: string) => actorId.replace("/", "~");
/** Server Apify menahan respons s/d `waitForFinish` detik → timeout HTTP harus lebih panjang (default HttpClient 30 s memutus
 * run yang sedang ditunggu — 3 connector X gagal TIMEOUT tepat 30 s, teramati live 2026-09-30). */
export const httpTimeout = (waitSecs: number) => (waitSecs + 20) * 1000;

export async function startRun(ctx: ConnectorContext, actorId: string, input: unknown, o: RunOptions): Promise<ApifyRun> {
  const qs = new URLSearchParams({ waitForFinish: String(Math.min(60, Math.max(0, Math.floor(o.waitSecs)))) });
  if (o.memoryMb) qs.set("memory", String(o.memoryMb));
  if (o.maxTotalChargeUsd !== undefined) qs.set("maxTotalChargeUsd", String(o.maxTotalChargeUsd));
  if (o.timeoutSecs) qs.set("timeout", String(o.timeoutSecs));
  const w = Number(qs.get("waitForFinish"));
  return (
    await call<{ data: ApifyRun }>(ctx, `/acts/${actorPath(actorId)}/runs?${qs}`, {
      method: "POST",
      body: JSON.stringify(input),
      timeoutMs: httpTimeout(w),
    })
  ).data;
}

export async function getRun(ctx: ConnectorContext, runId: string, waitSecs: number): Promise<ApifyRun> {
  const w = Math.min(60, Math.max(0, Math.floor(waitSecs)));
  return (await call<{ data: ApifyRun }>(ctx, `/actor-runs/${encodeURIComponent(runId)}?waitForFinish=${w}`, { timeoutMs: httpTimeout(w) }))
    .data;
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
