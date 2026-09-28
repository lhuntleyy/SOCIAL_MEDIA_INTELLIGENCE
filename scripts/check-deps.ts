// Dependency-rule check (ARCHITECTURE §6, AGENTS Golden Rule 2–3). Dipakai `bun run check`.
// Ditulis sendiri (bukan dependency-cruiser) agar tidak menambah paket yang harus lolos compat Bun.
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export interface Violation {
  file: string;
  line: number;
  rule: string;
  detail: string;
}

type Zone = { name: string; match: (rel: string) => string | null };

// Zona ditentukan dari path; nilai kembali = nama zona (connector menyertakan nama connector-nya).
const ZONES: Zone[] = [
  { name: "core", match: (r) => (r.startsWith("packages/core/") ? "core" : null) },
  { name: "contracts", match: (r) => (r.startsWith("packages/contracts/") ? "contracts" : null) },
  { name: "router", match: (r) => (r.startsWith("packages/router/") ? "router" : null) },
  { name: "query", match: (r) => (r.startsWith("packages/query/") ? "query" : null) },
  { name: "connector-sdk", match: (r) => (r.startsWith("packages/connector-sdk/") ? "connector-sdk" : null) },
  { name: "connector", match: (r) => /^packages\/connectors\/([^/]+)\//.exec(r)?.[1] ?? null },
  { name: "infra", match: (r) => (r.startsWith("packages/") ? r.split("/")[1]! : null) },
  { name: "app", match: (r) => (r.startsWith("apps/") ? "app" : null) },
];

// Paket internal yang BOLEH diimpor per zona. null = semua boleh.
const ALLOWED_INTERNAL: Record<string, string[] | null> = {
  core: ["@smip/contracts"],
  contracts: [],
  query: ["@smip/core", "@smip/contracts"],
  router: ["@smip/core", "@smip/contracts", "@smip/connector-sdk", "@smip/observability", "@smip/config"],
  "connector-sdk": ["@smip/contracts", "@smip/observability"],
  connector: ["@smip/connector-sdk", "@smip/contracts"],
  infra: ["@smip/core", "@smip/contracts", "@smip/config", "@smip/observability", "@smip/crypto"],
  app: null,
};

// core & contracts tidak boleh bergantung pada paket npm eksternal (domain murni). "zod" diizinkan di contracts.
const ALLOWED_EXTERNAL: Record<string, string[] | null> = {
  core: [],
  contracts: ["zod"],
};

// Golden Rule 3: nama provider hanya boleh ada di connector (dan app registry/test).
const PROVIDER_WORDS =
  /\b(twitterapi(_io)?|apify|instagrapi|meta_graph|threads_api|x_api|youtube_data_api|scrapecreators|brightdata|ensembledata)\b/i;
const PROVIDER_FREE_ZONES = new Set(["core", "router", "query", "connector-sdk"]);
const PROVIDER_FREE_PATHS = [/^apps\/api\/src\/routes\//];

const IMPORT_RE =
  /(?:^|[\s;])(?:import|export)\s[^'"`]*?from\s*["']([^"']+)["']|(?:^|[\s(;])import\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm;

function zoneOf(rel: string): { zone: string; id: string } | null {
  for (const z of ZONES) {
    const id = z.match(rel);
    if (id) return { zone: z.name, id };
  }
  return null;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|mts)$/.test(e.name) && !e.name.endsWith(".d.ts")) yield p;
  }
}

export async function checkDependencies(root: string): Promise<Violation[]> {
  const out: Violation[] = [];
  for (const top of ["packages", "apps"]) {
    for await (const abs of walk(join(root, top))) {
      const rel = relative(root, abs).split(sep).join("/");
      const z = zoneOf(rel);
      if (!z) continue;
      const src = stripComments(await readFile(abs, "utf8"));
      const lineOf = (idx: number) => src.slice(0, idx).split("\n").length;
      const isTest = /\/test\/|\.test\.ts$/.test(rel);

      for (const m of src.matchAll(IMPORT_RE)) {
        const spec = m[1] ?? m[2] ?? m[3]!;
        const line = lineOf(m.index ?? 0);
        if (spec.startsWith(".")) {
          // relatif: tidak boleh keluar dari paket/connector sendiri
          const target = join(abs, "..", spec);
          const targetRel = relative(root, target).split(sep).join("/");
          const tz = zoneOf(targetRel);
          if (!tz || tz.zone !== z.zone || tz.id !== z.id) {
            out.push({ file: rel, line, rule: "relative-escape", detail: `import relatif "${spec}" keluar dari ${z.zone}:${z.id}` });
          }
          continue;
        }
        if (spec.startsWith("@smip/")) {
          const pkg = spec.split("/").slice(0, 2).join("/");
          const allowed = ALLOWED_INTERNAL[z.zone];
          const self = `@smip/${z.id}`;
          if (pkg === self) continue;
          if (pkg.startsWith("@smip/connector-") && pkg !== "@smip/connector-sdk" && z.zone !== "app") {
            out.push({ file: rel, line, rule: "connector-import", detail: `${z.zone}:${z.id} tidak boleh mengimpor connector ${pkg}` });
            continue;
          }
          if (allowed && !allowed.includes(pkg) && !isTest) {
            out.push({
              file: rel,
              line,
              rule: "layer",
              detail: `${z.zone}:${z.id} tidak boleh mengimpor ${pkg} (izin: ${allowed.join(", ") || "tidak ada"})`,
            });
          }
          continue;
        }
        const ext = ALLOWED_EXTERNAL[z.zone];
        if (ext && !isTest) {
          const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
          if (!ext.includes(name) && name !== "bun:test") {
            out.push({ file: rel, line, rule: "external", detail: `${z.zone} harus murni; paket eksternal "${name}" dilarang` });
          }
        }
      }

      const providerFree = PROVIDER_FREE_ZONES.has(z.zone) || PROVIDER_FREE_PATHS.some((r) => r.test(rel));
      if (providerFree && !isTest) {
        // specifier import sudah ditangani aturan connector-import/layer → kosongkan agar tidak dihitung ganda
        const body = src.replace(IMPORT_RE, (m) => m.replace(/[^\n]/g, " "));
        for (const m of body.matchAll(new RegExp(PROVIDER_WORDS.source, "gi"))) {
          out.push({
            file: rel,
            line: lineOf(m.index ?? 0),
            rule: "provider-leak",
            detail: `nama provider "${m[0]}" di luar connector (Golden Rule 3)`,
          });
        }
      }
    }
  }
  return out;
}

if (import.meta.main) {
  const root = `${import.meta.dir}/..`;
  const v = await checkDependencies(root);
  for (const x of v) console.error(`${x.file}:${x.line}  [${x.rule}] ${x.detail}`);
  console.log(v.length === 0 ? "dependency-rule: OK" : `dependency-rule: ${v.length} pelanggaran`);
  process.exit(v.length === 0 ? 0 : 1);
}
