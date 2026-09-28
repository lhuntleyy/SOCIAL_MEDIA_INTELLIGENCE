// Probe kontrak provider berbasis Apify (S-11..S-17 "uji kontrak", S-14 latency).
// Menjalankan actor dengan batas biaya keras (maxTotalChargeUsd) lalu mencetak ringkasan JSON.
// Token dibaca dari env APIFY_TOKEN (~/.config/smip/secrets.env) — TIDAK pernah dicetak / ditulis ke evidence.
export interface ProbeRun {
  actor: string;
  input: Record<string, unknown>;
  maxTotalChargeUsd: number;
  timeoutSecs?: number;
  /** MB. Event "apify-actor-start" ditagih PER GB memori — default actor bisa 4 GB = 4× biaya start. */
  memoryMb?: number;
}

export interface ProbeResult {
  actor: string;
  runId: string;
  status: string;
  durationMs: number;
  usageTotalUsd: number | null;
  chargedEvents: Record<string, number> | null;
  items: Record<string, unknown>[];
}

const API = "https://api.apify.com/v2";

function token(): string {
  const t = process.env.APIFY_TOKEN;
  if (!t) throw new Error("APIFY_TOKEN tidak di-set (source ~/.config/smip/secrets.env)");
  return t;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token()}`, "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok)
    throw new Error(`Apify ${init?.method ?? "GET"} ${path.split("?")[0]} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

export async function runActor(p: ProbeRun): Promise<ProbeResult> {
  const t0 = Date.now();
  const qs = new URLSearchParams({ maxTotalChargeUsd: String(p.maxTotalChargeUsd), timeout: String(p.timeoutSecs ?? 300) });
  if (p.memoryMb) qs.set("memory", String(p.memoryMb));
  const start = await api<{ data: { id: string } }>(`/acts/${p.actor.replace("/", "~")}/runs?${qs}`, {
    method: "POST",
    body: JSON.stringify(p.input),
  });
  const runId = start.data.id;
  let run: { status: string; defaultDatasetId: string; usageTotalUsd?: number; chargedEventCounts?: Record<string, number> };
  for (;;) {
    run = (await api<{ data: typeof run }>(`/actor-runs/${runId}?waitForFinish=60`)).data;
    if (!["READY", "RUNNING"].includes(run.status)) break;
  }
  const items = await api<Record<string, unknown>[]>(`/datasets/${run.defaultDatasetId}/items?clean=true&format=json`);
  return {
    actor: p.actor,
    runId,
    status: run.status,
    durationMs: Date.now() - t0,
    usageTotalUsd: run.usageTotalUsd ?? null,
    chargedEvents: run.chargedEventCounts ?? null,
    items,
  };
}

export async function accountUsage(): Promise<{ monthlyUsageUsd: number; maxMonthlyUsageUsd: number }> {
  const d = (await api<{ data: { limits: { maxMonthlyUsageUsd: number }; current: { monthlyUsageUsd: number } } }>("/users/me/limits"))
    .data;
  return { monthlyUsageUsd: d.current.monthlyUsageUsd, maxMonthlyUsageUsd: d.limits.maxMonthlyUsageUsd };
}
