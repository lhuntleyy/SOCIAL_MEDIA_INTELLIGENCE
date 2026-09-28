// S-01/F-01: tooling dev yang dijalankan lewat Bun (Golden Rule 8) — Biome (lint + format).
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, type Check } from "./types";

export const biome: Check = {
  id: "biome",
  task: "S-01",
  packages: ["@biomejs/biome"],
  async run() {
    const root = `${import.meta.dir}/../..`;
    const dir = await mkdtemp(join(tmpdir(), "smip-biome-"));
    try {
      await writeFile(join(dir, "bad.ts"), "export function f(a: any) { if (a == 1) { return 1 } }\n");
      await writeFile(join(dir, "biome.json"), JSON.stringify({ linter: { enabled: true, rules: { recommended: true } } }));
      const p = Bun.spawn([process.execPath, "--bun", `${root}/node_modules/.bin/biome`, "lint", "--reporter=json", "."], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, , code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      assert(code !== 0, "lint harus gagal untuk kode bermasalah");
      assert(/noExplicitAny|noDoubleEquals/.test(out), `rule noExplicitAny/noDoubleEquals terdeteksi (output: ${out.slice(0, 200)})`);
      return { status: "COMPATIBLE", notes: ["biome lint via `bun --bun` mendeteksi noExplicitAny & noDoubleEquals, exit ≠ 0"] };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
