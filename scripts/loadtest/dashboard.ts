// H-01 load test API dashboard (NFR-04: p95 ≤ 1,5 dtk rentang 7 hari, ≤ 3 dtk rentang 90 hari). Tanpa dependency (pengganti k6).
//   bun scripts/loadtest/dashboard.ts --base http://<api>:8080 --email <user> --password-env LT_PASSWORD --topic <id>
//        [--vus 10] [--seconds 45] [--days 7] [--cold]
// --cold: tiap halaman memakai rentang waktu unik (cache respons selalu meleset) → beban ClickHouse murni (skenario terburuk).
// Tiap VU berulang "membuka dashboard": 13 request analitik paralel (sama dengan halaman Dashboard), lalu jeda 0–1 dtk.
const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1]! : d;
};
const base = arg("base")!;
const vus = Number(arg("vus", "10"));
const seconds = Number(arg("seconds", "45"));
const days = Number(arg("days", "7"));
const topic = arg("topic")!;
const login = await fetch(`${base}/v1/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-smip-client-ip": "10.9.9.9" },
  body: JSON.stringify({ email: arg("email"), password: process.env[arg("password-env", "LT_PASSWORD")!] }),
});
if (!login.ok) throw new Error(`login gagal ${login.status}`);
const token = ((await login.json()) as { data: { access_token: string } }).data.access_token;
const to = new Date();
const from = new Date(to.getTime() - days * 86_400_000);
const cold = process.argv.includes("--cold");
let pageSeq = 0;
const qsFor = () => {
  if (!cold) return `topic_id=${topic}&from=${from.toISOString()}&to=${to.toISOString()}`;
  const t = new Date(to.getTime() - ++pageSeq * 1000);
  return `topic_id=${topic}&from=${new Date(t.getTime() - days * 86_400_000).toISOString()}&to=${t.toISOString()}`;
};
const PATHS = [
  "/analytics/summary",
  "/analytics/exposure",
  "/analytics/exposure?mode=engagement",
  "/analytics/sentiment/timeline",
  "/analytics/sentiment/proportion",
  "/analytics/emotion/timeline",
  "/analytics/platforms",
  "/analytics/hashtags?limit=25",
  "/analytics/issues?limit=40",
  "/analytics/issues?limit=40&mode=engagement",
  "/analytics/accounts/top?limit=10",
  "/analytics/locations",
  "/posts?limit=20",
];
const lat: Record<string, number[]> = {};
const page: number[] = [];
let errors = 0;
let total = 0;
const end = Date.now() + seconds * 1000;
async function vu() {
  while (Date.now() < end) {
    const t0 = performance.now();
    const qs = qsFor();
    await Promise.all(
      PATHS.map(async (p) => {
        const t = performance.now();
        const r = await fetch(`${base}/v1${p}${p.includes("?") ? "&" : "?"}${qs}`, {
          headers: { authorization: `Bearer ${token}`, "x-smip-client-ip": "10.9.9.9" },
        }).catch(() => null);
        total++;
        if (!r?.ok) errors++;
        await r?.arrayBuffer().catch(() => {});
        const k = p.split("?")[0]!;
        if (!lat[k]) lat[k] = [];
        lat[k].push(performance.now() - t);
      }),
    );
    page.push(performance.now() - t0);
    await Bun.sleep(Math.random() * 1000);
  }
}
const t0 = Date.now();
await Promise.all(Array.from({ length: vus }, vu));
const q = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0);
};
const all = Object.values(lat).flat();
const out = {
  vus,
  seconds,
  range_days: days,
  cold,
  requests: total,
  rps: Math.round((total / ((Date.now() - t0) / 1000)) * 10) / 10,
  error_pct: Math.round((errors / Math.max(1, total)) * 1000) / 10,
  request_ms: { p50: q(all, 50), p95: q(all, 95), p99: q(all, 99) },
  page_load_ms: { n: page.length, p50: q(page, 50), p95: q(page, 95) },
  slowest_p95: Object.entries(lat)
    .map(([k, v]) => [k, q(v, 95)] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4),
};
console.log(JSON.stringify(out));

export {};
