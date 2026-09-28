// F-11: bun run dev:up   → compose up (tunggu sehat) + bucket S3 + migrasi Postgres & ClickHouse + seed
//        bun run dev:down → compose down (volume dipertahankan; tambah --volumes untuk hapus data)
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const COMPOSE = ["docker", "compose", "-f", join(ROOT, "infra/compose/docker-compose.yml")];

async function run(cmd: string[], env: Record<string, string> = {}) {
  console.log(`$ ${cmd.join(" ")}`);
  const p = Bun.spawn(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit", env: { ...process.env, ...env } });
  if ((await p.exited) !== 0) throw new Error(`gagal: ${cmd.join(" ")}`);
}

function loadEnv(file: string): Promise<Record<string, string>> {
  return Bun.file(file)
    .text()
    .then((t) =>
      Object.fromEntries(
        t
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("#"))
          .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
      ),
    );
}

const cmd = process.argv[2] ?? "up";
if (cmd === "down") {
  await run([...COMPOSE, "down", ...process.argv.slice(3)]);
} else {
  const env = await loadEnv(join(ROOT, "infra/compose/.env.dev"));
  await run([...COMPOSE, "up", "-d", "--wait"]);
  await run([
    ...COMPOSE,
    "exec",
    "-T",
    "s3",
    "mkdir",
    "-p",
    `/data/${env.S3_BUCKET_RAW}`,
    `/data/${env.S3_BUCKET_EXPORTS}`,
    `/data/${env.S3_BUCKET_TRAINING}`,
  ]);
  await run(["bun", "run", "db:migrate", "up"], env);
  await run(["bun", "run", "ch:migrate", "up"], env);
  await run(["bun", "scripts/seed.ts"], env);
  console.log("\ndev siap. Env: infra/compose/.env.dev");
}
