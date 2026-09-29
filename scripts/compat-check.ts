// Fase 0 — spike kompatibilitas (TASK S-01..S-09, TESTING §5, ADR-001).
//   bun run compat              # semua check
//   bun run compat hono clickhouse
// Infra lokal: scripts/spike-infra.sh start (Redis, ClickHouse, Postgres, S3). Check yang infranya tidak ada → UNTESTED.
// Hasil: docs/evidence/compat/results.{json,md}

import { mkdir } from "node:fs/promises";
import { arch, cpus, platform, totalmem } from "node:os";
import { biome } from "./compat/s01-tooling";
import { bunBuiltins, hono, joseCheck, zod } from "./compat/s02-http";
import { bullmq, bullmqInterop } from "./compat/s03-queue";
import { otel } from "./compat/s06-otel";
import { clickhouse } from "./compat/s07-clickhouse";
import { drizzleKit, playwrightCheck, postgresCheck, s3Check, viteCheck } from "./compat/s08-data";
import { cryptoInterop } from "./compat/s09-crypto";
import { type Check, type CheckResult, Untested } from "./compat/types";

const keda: Check = {
  id: "keda-bullmq-scaler",
  task: "S-05",
  packages: ["KEDA", "kind/minikube"],
  async run() {
    throw new Untested(
      "BLOCKED: host tanpa Docker/Kubernetes. Hanya relevan untuk profil Kubernetes (DEPLOYMENT §4); profil MVP single-node tidak butuh KEDA.",
    );
  },
};

const ALL: Check[] = [
  biome,
  hono,
  zod,
  joseCheck,
  bunBuiltins,
  bullmq,
  bullmqInterop,
  keda,
  otel,
  clickhouse,
  postgresCheck,
  drizzleKit,
  s3Check,
  viteCheck,
  playwrightCheck,
  cryptoInterop,
];

const ROOT = `${import.meta.dir}/..`;
const OUT = `${ROOT}/docs/evidence/compat`;

async function pkgVersion(name: string): Promise<string | null> {
  try {
    const f = Bun.file(`${ROOT}/node_modules/${name}/package.json`);
    return (await f.json()).version ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const filter = process.argv.slice(2);
  const selected = filter.length ? ALL.filter((c) => filter.includes(c.id)) : ALL;
  const results: Array<{ id: string; task: string; packages: string[]; durationMs: number } & CheckResult> = [];

  for (const c of selected) {
    const t0 = performance.now();
    let r: CheckResult;
    try {
      r = await c.run();
    } catch (e) {
      r =
        e instanceof Untested
          ? { status: "UNTESTED", notes: [e.message] }
          : {
              status: "INCOMPATIBLE",
              notes: [
                String((e as Error).stack ?? e)
                  .split("\n")
                  .slice(0, 3)
                  .join(" | "),
              ],
            };
    }
    const durationMs = Math.round(performance.now() - t0);
    results.push({ id: c.id, task: c.task, packages: c.packages, durationMs, ...r });
    console.log(`${r.status.padEnd(12)} ${c.task.padEnd(5)} ${c.id.padEnd(26)} ${durationMs} ms`);
    for (const n of r.notes) console.log(`             - ${n}`);
  }

  const versions: Record<string, string | null> = {};
  for (const p of [
    "hono",
    "zod",
    "jose",
    "bullmq",
    "ioredis",
    "@clickhouse/client",
    "drizzle-orm",
    "postgres",
    "@opentelemetry/sdk-trace-base",
    "@opentelemetry/exporter-trace-otlp-proto",
    "@opentelemetry/context-async-hooks",
    "vite",
    "@vitejs/plugin-react",
    "react",
    "embedded-postgres",
    "drizzle-kit",
    "playwright",
    "@biomejs/biome",
  ])
    versions[p] = await pkgVersion(p);

  const env = {
    date: new Date().toISOString(),
    bun: Bun.version,
    bun_revision: Bun.revision,
    os: `${platform()} ${arch()}`,
    cpus: cpus().length,
    mem_gb: +(totalmem() / 2 ** 30).toFixed(1),
  };
  // Filter parsial tidak menimpa laporan lengkap.
  if (filter.length) {
    if (results.some((r) => r.status === "INCOMPATIBLE")) process.exitCode = 1;
    return;
  }
  await mkdir(OUT, { recursive: true });
  await Bun.write(`${OUT}/results.json`, JSON.stringify({ env, versions, results }, null, 2));

  const md = [
    "# Hasil compat-check Fase 0",
    "",
    `Dibuat otomatis oleh \`bun run compat\` — ${env.date}. Bun ${env.bun} (${env.bun_revision.slice(0, 9)}), ${env.os}, ${env.cpus} vCPU, ${env.mem_gb} GB.`,
    "Reproduksi: `scripts/spike-infra.sh start && bun run compat` (VAULT_ADDR/VAULT_TOKEN opsional untuk Vault transit).",
    "",
    "| Task | Check | Status | Durasi | Catatan |",
    "|---|---|---|---:|---|",
    ...results.map(
      (r) =>
        `| ${r.task} | \`${r.id}\` | **${r.status}** | ${r.durationMs} ms | ${r.notes.map((n) => n.replaceAll("|", "\\|")).join("<br>")} |`,
    ),
    "",
    "## Versi paket",
    "",
    ...Object.entries(versions).map(([k, v]) => `- \`${k}\`: ${v ?? "tidak terpasang"}`),
    "",
  ].join("\n");
  await Bun.write(`${OUT}/results.md`, md);
  console.log(`\n→ ${OUT}/results.md`);
  if (results.some((r) => r.status === "INCOMPATIBLE")) process.exitCode = 1;
}

await main();
// Koneksi Redis/ClickHouse dari check yang gagal di tengah bisa menahan event loop → keluar eksplisit.
process.exit(process.exitCode ?? 0);
