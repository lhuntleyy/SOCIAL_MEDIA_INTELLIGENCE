// bun run dev:workers → jalankan scheduler + worker-dispatch + worker-fetch-bun (+ worker-fetch-py bila .venv ada) + worker-pipeline + worker-ai-stub + worker-sink dengan env infra/compose/.env.dev
// (butuh `bun run dev:up` lebih dulu). Ctrl+C menghentikan semuanya (SIGTERM → graceful shutdown).
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const env = Object.fromEntries(
  (await Bun.file(join(ROOT, "infra/compose/.env.dev")).text())
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const services = [
  "apps/scheduler/src/main.ts",
  "apps/worker-dispatch/src/main.ts",
  "apps/worker-fetch-bun/src/main.ts",
  "apps/worker-pipeline/src/main.ts",
  "apps/worker-ai-stub/src/main.ts", // dev saja: label netral "stub-0" sampai worker-ai (Python) ada
  "apps/worker-sink/src/main.ts",
];
const procs = services.map((s) =>
  Bun.spawn(["bun", s], { cwd: ROOT, env: { ...env, ...process.env }, stdout: "inherit", stderr: "inherit" }),
);
// worker-fetch-py (I-16): hanya bila venv tersedia (`.venv/bin/pip install -r workers-py/requirements.txt`)
const PY = join(ROOT, ".venv/bin/python");
if (await Bun.file(PY).exists()) {
  procs.push(
    Bun.spawn([PY, "-m", "smip_fetch.worker"], {
      cwd: join(ROOT, "workers-py"),
      env: { ...env, ...process.env },
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
}
const stop = () => {
  for (const p of procs) p.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Promise.all(procs.map((p) => p.exited));
