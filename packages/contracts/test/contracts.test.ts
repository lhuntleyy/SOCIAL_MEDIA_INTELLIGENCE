import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { EXPORTED } from "../src";
import { CASES } from "./fixtures";

const ROOT = join(import.meta.dir, "../../..");
const PY = join(ROOT, ".venv/bin/python");

describe("kontrak TS (Zod)", () => {
  for (const [name, schema, data, valid] of CASES) {
    test(name, () => {
      const res = EXPORTED[schema as keyof typeof EXPORTED].safeParse(data);
      expect(res.success).toBe(valid);
    });
  }
});

describe("kontrak Python (pydantic hasil generate) sepakat dengan TS", () => {
  test("setiap kasus: hasil validasi pydantic == Zod", async () => {
    const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(join(ROOT, "workers-py"))})
from pydantic import ValidationError
import smip_contracts as c
out = []
for name, schema, data, _ in json.load(sys.stdin):
    try:
        getattr(c, schema).model_validate(data); out.append([name, True, None])
    except ValidationError as e:
        out.append([name, False, e.errors()[0]["type"]])
print(json.dumps(out))`;
    const proc = Bun.spawn([PY, "-c", script], { stdin: new TextEncoder().encode(JSON.stringify(CASES)), stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(err.slice(-600)).toBe("");
    expect(code).toBe(0);
    const py = JSON.parse(out) as [string, boolean, string | null][];
    const mismatch = py
      .filter(([name, ok]) => CASES.find((c) => c[0] === name)![3] !== ok)
      .map(([n, ok, t]) => `${n}: python=${ok} (${t})`);
    expect(mismatch).toEqual([]);
  });
});
