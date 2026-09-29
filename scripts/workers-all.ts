// Profil MVP/dev "workers" (DEPLOYMENT §3a, REVIEW E2): semua service Bun dalam SATU proses → hemat RAM (runtime Bun
// dimuat sekali, bukan per service). Kode service tidak berubah: tiap `main.ts` di-import apa adanya.
// Shutdown: setiap main memasang handler SIGTERM yang diakhiri process.exit(0); di sini exit ditunda sampai SEMUA
// handler selesai (atau batas 45 s) agar tidak ada service yang terpotong saat menutup antrean/koneksi.
const SERVICES = [
  "../apps/scheduler/src/main.ts",
  "../apps/worker-dispatch/src/main.ts",
  "../apps/worker-fetch-bun/src/main.ts",
  "../apps/worker-pipeline/src/main.ts",
  ...(process.env.NODE_ENV === "production" ? [] : ["../apps/worker-ai-stub/src/main.ts"]), // label netral sampai worker-ai
  "../apps/worker-sink/src/main.ts",
];

const realExit = process.exit.bind(process);
let exits = 0;
let stopping = false;
process.exit = ((code?: number) => {
  if (!stopping) return realExit(code); // crash saat start/jalan → keluar seperti biasa
  if (++exits >= SERVICES.length) realExit(code ?? 0);
  return undefined as never;
}) as typeof process.exit;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.prependListener(sig, () => {
    stopping = true;
    setTimeout(() => realExit(0), 45_000).unref();
  });
}

for (const s of SERVICES) await import(s);
console.log(JSON.stringify({ msg: "workers (1 proses) mulai", services: SERVICES.length }));

export {}; // module ESM (top-level await)
