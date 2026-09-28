import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkDependencies } from "./check-deps";

let root: string;
async function put(rel: string, src: string) {
  await mkdir(dirname(join(root, rel)), { recursive: true });
  await writeFile(join(root, rel), src);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "smip-deps-"));
  // sah
  await put(
    "packages/core/src/topic.ts",
    `import type { Operation } from "@smip/contracts";\nimport { x } from "./util";\nexport const t: Operation | null = null;\n`,
  );
  await put("packages/core/src/util.ts", "export const x = 1;\n");
  await put(
    "packages/connectors/twitterapi-io-x/src/index.ts",
    `import { http } from "@smip/connector-sdk";\nexport const key = "twitterapi_io.x";\n`,
  );
  await put("apps/api/src/main.ts", `import "@smip/connector-twitterapi-io-x";\nimport { db } from "@smip/db";\n`);
  // pelanggaran
  await put("packages/core/src/bad-db.ts", `import { db } from "@smip/db";\n`);
  await put("packages/core/src/bad-ext.ts", `import { Hono } from "hono";\n`);
  await put("packages/core/src/bad-provider.ts", `export const primary = "twitterapi_io"; // komentar apify tidak dihitung\n`);
  await put("packages/router/src/bad.ts", `import { c } from "@smip/connector-apify-instagram";\n`);
  await put("packages/connectors/apify-x/src/bad.ts", `import { z } from "../../twitterapi-io-x/src/index";\n`);
  await put("packages/core/test/ok.test.ts", `import { db } from "@smip/db";\n`);
});
afterAll(async () => rm(root, { recursive: true, force: true }));

describe("check-deps", () => {
  test("mendeteksi semua pelanggaran dan hanya itu", async () => {
    const v = await checkDependencies(root);
    const got = v.map((x) => `${x.file}:${x.rule}`).sort();
    expect(got).toEqual(
      [
        "packages/connectors/apify-x/src/bad.ts:relative-escape",
        "packages/core/src/bad-db.ts:layer",
        "packages/core/src/bad-ext.ts:external",
        "packages/core/src/bad-provider.ts:provider-leak",
        "packages/router/src/bad.ts:connector-import",
      ].sort(),
    );
  });

  test("komentar tidak memicu provider-leak", async () => {
    const v = await checkDependencies(root);
    expect(v.filter((x) => x.rule === "provider-leak")).toHaveLength(1);
  });
});
