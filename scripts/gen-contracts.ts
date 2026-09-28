// F-07: generate JSON Schema (draft 2020-12) + model pydantic v2 dari packages/contracts.
//   bun run gen:contracts          # tulis ulang hasil generate
//   bun run gen:contracts --check  # gagal bila hasil generate berbeda dari yang tercommit (CI diff check)
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { EXPORTED } from "../packages/contracts/src";

const ROOT = join(import.meta.dir, "..");
const SCHEMA_DIR = join(ROOT, "packages/contracts/schemas");
const PY_OUT = join(ROOT, "workers-py/smip_contracts/generated.py");
const CODEGEN = process.env.DATAMODEL_CODEGEN ?? join(ROOT, ".venv/bin/datamodel-codegen");
const check = process.argv.includes("--check");

/**
 * Zod mengekspor datetime/uuid sebagai `format` + `pattern`. pydantic memetakan format ke tipe (`datetime`, `UUID`)
 * lalu gagal menerapkan regex ke objek itu (TypeError). Untuk paritas persis dengan Zod (mis. UTC wajib 'Z'),
 * di bundle pydantic node ber-pattern diperlakukan sebagai `str` + pattern. File JSON Schema publik tidak diubah.
 */
function forPydantic(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(forPydantic);
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (typeof o.format === "string" && typeof o.pattern === "string") delete o.format; // date-time, uuid, …
    for (const k of Object.keys(o)) o[k] = forPydantic(o[k]);
  }
  return node;
}

const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

async function main() {
  const outputs = new Map<string, string>();
  const bundle: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(EXPORTED)) {
    const js = z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }) as Record<string, unknown>;
    js.title = name;
    js.$id = `https://smip.local/contracts/${kebab(name)}.v1.json`;
    outputs.set(join(SCHEMA_DIR, `${kebab(name)}.v1.json`), `${JSON.stringify(js, null, 2)}\n`);
    const { $schema: _s, $id: _i, ...rest } = js;
    bundle[name] = forPydantic(structuredClone(rest));
  }

  // pydantic: satu file dari bundle $defs agar nama kelas stabil
  const tmp = join(tmpdir(), `smip-contracts-${process.pid}`);
  await mkdir(tmp, { recursive: true });
  const bundlePath = join(tmp, "bundle.json");
  await writeFile(
    bundlePath,
    JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", title: "SmipContracts", $defs: bundle }),
  );
  const pyTmp = join(tmp, "generated.py");
  const proc = Bun.spawn(
    [
      CODEGEN,
      "--input",
      bundlePath,
      "--input-file-type",
      "jsonschema",
      "--output",
      pyTmp,
      "--output-model-type",
      "pydantic_v2.BaseModel",
      "--target-python-version",
      "3.12",
      "--use-annotated",
      "--field-constraints",
      "--use-standard-collections",
      "--use-union-operator",
      "--disable-timestamp",
      "--use-schema-description",
      "--collapse-root-models",
      "--use-title-as-name",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`datamodel-codegen gagal (${code}): ${err.slice(-800)}`);
  const header = "# HASIL GENERATE dari packages/contracts (bun run gen:contracts). JANGAN DIEDIT MANUAL.\n";
  outputs.set(PY_OUT, header + (await readFile(pyTmp, "utf8")));
  await rm(tmp, { recursive: true, force: true });

  const drift: string[] = [];
  for (const [path, content] of outputs) {
    const current = await readFile(path, "utf8").catch(() => null);
    if (current === content) continue;
    if (check) drift.push(path.replace(`${ROOT}/`, ""));
    else {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, content);
    }
  }
  if (check && drift.length) {
    console.error(`kontrak tidak sinkron — jalankan \`bun run gen:contracts\`:\n  ${drift.join("\n  ")}`);
    process.exit(1);
  }
  console.log(check ? "kontrak sinkron" : `generate ${outputs.size} file`);
}

await main();
