// Probe BENTUK output actor Apify untuk membangun normalizer tanpa mengarang (Golden Rule 1) — I-17.
//   set -a; . ~/.config/smip/secrets.env; set +a; bun scripts/provider-probe/shape.ts <actor> '<input-json>' <maxUsd> [memoryMb]
// Yang disimpan: skema input actor (gratis, dari build) + tipe/format tiap path field output + biaya run.
// TIDAK menyimpan nilai (teks, nama, id akun) — UU PDP / minimisasi.
import { mkdir } from "node:fs/promises";
import { accountUsage, runActor } from "./apify-run";

const [actor, inputJson, maxUsd, memory] = process.argv.slice(2);
if (!actor || !inputJson || !maxUsd) throw new Error("usage: shape.ts <actor> '<input-json>' <maxUsd> [memoryMb]");

function fmt(v: string): string {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v)) return "string:iso-z";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:?\d{2}$/.test(v)) return "string:iso-offset";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(v)) return "string:iso-no-zone";
  if (/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{2}:\d{2}:\d{2} [+-]\d{4} \d{4}$/.test(v)) return "string:twitter-date";
  if (/^\d{10}$/.test(v)) return "string:epoch-s";
  if (/^\d{13}$/.test(v)) return "string:epoch-ms";
  if (/^\d{15,20}$/.test(v)) return "string:numeric-id";
  if (/^https?:\/\//.test(v)) return "string:url";
  return "string";
}
function walk(v: unknown, path: string, out: Map<string, Set<string>>) {
  const add = (t: string) => {
    if (!out.has(path)) out.set(path, new Set());
    out.get(path)!.add(t);
  };
  if (v === null || v === undefined) return add("null");
  if (Array.isArray(v)) {
    add(`array(${v.length ? "…" : "empty"})`);
    for (const x of v.slice(0, 5)) walk(x, `${path}[]`, out);
    return;
  }
  if (typeof v === "object") {
    add("object");
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, path ? `${path}.${k}` : k, out);
    return;
  }
  if (typeof v === "number")
    return add(Number.isInteger(v) ? (v > 1e12 && v < 1e14 ? "int:epoch-ms?" : v > 1e9 && v < 1e11 ? "int:epoch-s?" : "int") : "float");
  if (typeof v === "string") return add(fmt(v));
  add(typeof v);
}

const API = "https://api.apify.com/v2";
const act = (await (await fetch(`${API}/acts/${actor.replace("/", "~")}?token=${process.env.APIFY_TOKEN}`)).json()) as {
  data: { taggedBuilds?: { latest?: { buildId: string } } };
};
const buildId = act.data.taggedBuilds?.latest?.buildId;
const build = buildId
  ? ((await (await fetch(`${API}/actor-builds/${buildId}?token=${process.env.APIFY_TOKEN}`)).json()) as {
      data: { inputSchema?: string; buildNumber?: string };
    })
  : null;
const inputSchema = build?.data.inputSchema ? JSON.parse(build.data.inputSchema) : null;

const before = await accountUsage();
const r = await runActor({
  actor,
  input: JSON.parse(inputJson),
  maxTotalChargeUsd: Number(maxUsd),
  memoryMb: memory ? Number(memory) : undefined,
  timeoutSecs: 180,
});
const after = await accountUsage();
const shape = new Map<string, Set<string>>();
for (const it of r.items) walk(it, "", shape);

const report = {
  date: new Date().toISOString(),
  actor,
  build: build?.data.buildNumber ?? null,
  input: JSON.parse(inputJson),
  status: r.status,
  duration_ms: r.durationMs,
  items: r.items.length,
  cost_usd: r.usageTotalUsd,
  charged_events: r.chargedEvents,
  account_usage_usd: { before: before.monthlyUsageUsd, after: after.monthlyUsageUsd, limit: after.maxMonthlyUsageUsd },
  input_schema_properties: inputSchema
    ? Object.fromEntries(
        Object.entries(inputSchema.properties ?? {}).map(([k, p]) => [
          k,
          {
            type: (p as { type?: string }).type,
            editor: (p as { editor?: string }).editor,
            enum: (p as { enum?: unknown[] }).enum,
            description: String((p as { description?: string }).description ?? "").slice(0, 200),
          },
        ]),
      )
    : null,
  output_shape: Object.fromEntries([...shape.entries()].sort().map(([k, v]) => [k, [...v].sort()])),
};
const dir = "docs/evidence/I-17";
await mkdir(dir, { recursive: true });
const file = `${dir}/shape-${actor.replace("/", "~")}.json`;
await Bun.write(file, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify({ file, status: r.status, items: r.items.length, cost_usd: r.usageTotalUsd, usage_after: after.monthlyUsageUsd }),
);
