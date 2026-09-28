// bun run dev:workers → jalankan scheduler + worker-dispatch + worker-fetch-bun + worker-pipeline dengan env infra/compose/.env.dev
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
];
const procs = services.map((s) =>
  Bun.spawn(["bun", s], { cwd: ROOT, env: { ...env, ...process.env }, stdout: "inherit", stderr: "inherit" }),
);
const stop = () => {
  for (const p of procs) p.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Promise.all(procs.map((p) => p.exited));
