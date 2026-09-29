// S-08: drizzle + Bun.sql / postgres-js (transaksi, SET LOCAL, RLS, FK ke tabel partisi), Bun.s3 ke server S3-compatible,
// Vite build via bun. Playwright: tidak diuji di host ini (lihat catatan).

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { drizzle as drizzleBun } from "drizzle-orm/bun-sql";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { assert, type Check, INFRA, reachable, Untested } from "./types";

const TA = "0192f000-0000-7000-8000-00000000000a";
const TB = "0192f000-0000-7000-8000-00000000000b";

export const postgresCheck: Check = {
  id: "postgres-drizzle-rls",
  task: "S-08",
  packages: ["drizzle-orm", "postgres (porsager)", "Bun.SQL", "PostgreSQL 16"],
  async run() {
    if (!(await reachable(`tcp://${INFRA.postgresHost}:${INFRA.postgresPort}`))) throw new Untested("Postgres tidak jalan");
    const notes: string[] = [];
    const admin = postgres({
      host: INFRA.postgresHost,
      port: INFRA.postgresPort,
      user: "postgres",
      database: "postgres",
      onnotice: () => {},
    });
    await admin.unsafe("DROP DATABASE IF EXISTS compat_s08");
    await admin.unsafe("CREATE DATABASE compat_s08");
    await admin.unsafe(
      "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_rw') THEN CREATE ROLE app_rw LOGIN NOBYPASSRLS; END IF; END $$",
    );
    await admin.end();

    const su = postgres({
      host: INFRA.postgresHost,
      port: INFRA.postgresPort,
      user: "postgres",
      database: "compat_s08",
      onnotice: () => {},
    });
    await su.unsafe(`
      CREATE TABLE topics (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, name text NOT NULL);
      ALTER TABLE topics ENABLE ROW LEVEL SECURITY;
      ALTER TABLE topics FORCE ROW LEVEL SECURITY;
      -- v0.3 (naif): current_setting(...)::uuid
      CREATE POLICY p_naive ON topics USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
      GRANT SELECT, INSERT ON topics TO app_rw;
      INSERT INTO topics VALUES ('${TA.replace("a", "1")}', '${TA}', 'topik A'), ('${TB.replace("b", "2")}', '${TB}', 'topik B');

      CREATE TABLE crawl_runs (id uuid NOT NULL, scheduled_for timestamptz NOT NULL, status text,
        PRIMARY KEY (id, scheduled_for)) PARTITION BY RANGE (scheduled_for);
      CREATE TABLE crawl_runs_2026_09 PARTITION OF crawl_runs FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
      CREATE TABLE provider_attempts (id uuid PRIMARY KEY, crawl_run_id uuid NOT NULL, crawl_run_scheduled_for timestamptz NOT NULL,
        FOREIGN KEY (crawl_run_id, crawl_run_scheduled_for) REFERENCES crawl_runs(id, scheduled_for));
    `);

    // FK hanya ke id (tanpa kolom partisi) harus gagal
    const fkIdOnly = await su.unsafe(`CREATE TABLE bad_fk (x uuid REFERENCES crawl_runs(id))`).then(
      () => "diterima",
      (e: Error) => e.message,
    );
    assert(fkIdOnly !== "diterima", "FK ke crawl_runs(id) saja harus ditolak");
    notes.push(
      `FK ke tabel partisi wajib menyertakan kolom partisi: FK (id) ditolak ("${fkIdOnly.slice(0, 70)}…"); FK (id, scheduled_for) OK`,
    );

    // SET LOCAL tidak bisa diparameterisasi
    const setLocalParam = await su
      .begin(async (tx) => tx`SET LOCAL app.tenant_id = ${TA}`)
      .then(
        () => "diterima",
        (e: Error) => e.message,
      );
    assert(setLocalParam !== "diterima", "SET LOCAL dengan parameter $1 seharusnya ditolak");
    notes.push(
      `\`SET LOCAL app.tenant_id = $1\` DITOLAK Postgres ("${setLocalParam.slice(0, 50)}") → pakai \`SELECT set_config('app.tenant_id', $1, true)\` (efek sama, transaction-scoped)`,
    );

    const url = `postgres://app_rw@${INFRA.postgresHost}:${INFRA.postgresPort}/compat_s08`;
    // drizzle + postgres-js sebagai app_rw (tanpa BYPASSRLS)
    const pj = postgres(url, { max: 1, onnotice: () => {} });
    const db = drizzlePg(pj);
    const rowsA = await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${TA}, true)`);
      return tx.execute<{ name: string }>(sql`select name from topics`);
    });
    assert(rowsA.length === 1 && rowsA[0]!.name === "topik A", `RLS tenant A melihat 1 baris (dapat ${JSON.stringify(rowsA)})`);
    notes.push("drizzle(postgres-js) transaksi + set_config(local) + RLS: tenant A hanya melihat datanya");

    // Gotcha: setelah transaksi selesai di koneksi yang sama (pool), setting menjadi '' bukan NULL → cast uuid meledak
    const afterTx = await db.execute(sql`select count(*)::int as c from topics`).then(
      (r) => `ok:${JSON.stringify(r)}`,
      (e: Error & { cause?: Error }) => `error:${e.cause?.message ?? e.message}`,
    );
    notes.push(
      `GOTCHA koneksi pool: query di luar transaksi setelah set_config lokal → ${afterTx.startsWith("error") ? `ERROR "${afterTx.slice(6, 70)}"` : afterTx} — policy naif \`current_setting(...)::uuid\` gagal karena nilai kembali '' (bukan NULL)`,
    );
    await su.unsafe(`DROP POLICY p_naive ON topics;
      CREATE POLICY p_tenant ON topics USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);`);
    const fixed = await db.execute<{ c: number }>(sql`select count(*)::int as c from topics`);
    assert(fixed[0]!.c === 0, "policy nullif: tanpa tenant → 0 baris (deny), bukan error");
    notes.push(
      "fix: `nullif(current_setting('app.tenant_id', true), '')::uuid` → tanpa konteks tenant = 0 baris (default deny), bukan error",
    );
    await pj.end();

    // Bun.SQL builtin + drizzle bun-sql
    const bsql = new Bun.SQL(url, { max: 1 });
    const bunRows = await bsql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${TB}, true)`;
      return tx`select name from topics`;
    });
    assert(bunRows.length === 1 && bunRows[0].name === "topik B", `Bun.SQL RLS tenant B (dapat ${JSON.stringify(bunRows)})`);
    const dbb = drizzleBun({ client: bsql });
    const viaDrizzleBun = await dbb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${TA}, true)`);
      return tx.execute(sql`select name from topics`);
    });
    const n = Array.isArray(viaDrizzleBun) ? viaDrizzleBun.length : (viaDrizzleBun as { length?: number }).length;
    assert(n === 1, `drizzle(bun-sql) RLS 1 baris (dapat ${JSON.stringify(viaDrizzleBun)})`);
    await bsql.close();
    notes.push("Bun.SQL builtin (begin + set_config + RLS) OK; drizzle-orm/bun-sql transaksi OK");

    await su.end();
    return {
      status: "WORKAROUND",
      notes: [
        ...notes,
        "Status WORKAROUND karena dua pola di DATA_MODEL/SECURITY harus diganti (set_config & nullif) — keduanya perilaku Postgres, bukan Bun.",
      ],
    };
  },
};

export const s3Check: Check = {
  id: "bun-s3",
  task: "S-08",
  packages: ["Bun.S3Client", "versitygw (S3-compatible)"],
  async run() {
    if (!(await reachable(INFRA.s3.endpoint))) throw new Untested("server S3 tidak jalan");
    const notes: string[] = [];
    const bucket = "smip-raw";
    // versitygw posix: bucket dibuat via CreateBucket (PUT /bucket) — pakai presign-less request lewat S3Client.write ke bucket baru tidak membuat bucket.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(`${process.env.HOME}/.local/smip-spike/s3data/${bucket}`, { recursive: true });
    const s3 = new Bun.S3Client({ ...INFRA.s3, bucket, region: "us-east-1" });
    const key = "raw/x/twitterapi_io.x/2026/09/28/run-1/1-1.json.gz";
    const payload = Bun.gzipSync(new TextEncoder().encode(JSON.stringify({ tweets: [{ id: "1830000000000000001" }] })));
    await s3.write(key, payload, { type: "application/gzip" });
    assert(await s3.exists(key), "exists setelah write");
    const back = new Uint8Array(await s3.file(key).arrayBuffer());
    assert(JSON.parse(new TextDecoder().decode(Bun.gunzipSync(back))).tweets[0].id === "1830000000000000001", "roundtrip isi");
    const size = await s3.size(key);
    notes.push(`put/get/exists/size OK (${size} byte gzip)`);
    const url = s3.presign(key, { expiresIn: 60 });
    const res = await fetch(url);
    assert(res.ok && (await res.arrayBuffer()).byteLength === payload.byteLength, `presigned GET (status ${res.status})`);
    notes.push("presign GET (dipakai export download_url) OK");
    await s3.delete(key);
    assert(!(await s3.exists(key)), "delete");
    notes.push("delete OK");
    notes.push(
      "CATATAN: MinIO open-source DIARSIPKAN (dl.min.io → 410 'no longer maintained, no security updates'); spike memakai versitygw 1.8.0. DEPLOYMENT diperbarui.",
    );
    return { status: "COMPATIBLE", notes };
  },
};

export const viteCheck: Check = {
  id: "vite-build",
  task: "S-08",
  packages: ["vite", "@vitejs/plugin-react", "react"],
  async run() {
    const dir = await mkdtemp(join(tmpdir(), "smip-vite-"));
    const root = `${import.meta.dir}/../..`;
    try {
      await writeFile(
        join(dir, "index.html"),
        `<!doctype html><html><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>`,
      );
      await writeFile(
        join(dir, "main.tsx"),
        `import { createRoot } from "react-dom/client";\nfunction App(){ return <h1>SMIP</h1>; }\ncreateRoot(document.getElementById("root")!).render(<App/>);\n`,
      );
      await writeFile(
        join(dir, "vite.config.mjs"),
        `import react from "${root}/node_modules/@vitejs/plugin-react/dist/index.js";\nexport default { plugins: [react()], resolve: { alias: { "react-dom/client": "${root}/node_modules/react-dom/client.js", "react/jsx-runtime": "${root}/node_modules/react/jsx-runtime.js", "react": "${root}/node_modules/react/index.js" } }, logLevel: "error" };\n`,
      );
      const t0 = performance.now();
      const proc = Bun.spawn([process.execPath, "--bun", `${root}/node_modules/vite/bin/vite.js`, "build"], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      assert(code === 0, `vite build exit ${code}: ${(err || out).slice(-300)}`);
      const assets = await readdir(join(dir, "dist", "assets"));
      assert(
        assets.some((a) => a.endsWith(".js")),
        "bundle js ada",
      );
      return {
        status: "COMPATIBLE",
        notes: [
          `vite build dijalankan dengan \`bun --bun\` (runtime Bun, bukan Node): ${assets.length} asset, ${(performance.now() - t0).toFixed(0)} ms`,
        ],
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};

export const playwrightCheck: Check = {
  id: "playwright",
  task: "S-08",
  packages: ["playwright", "chromium-headless-shell"],
  async run() {
    const { chromium } = await import("playwright");
    const libs = process.env.SPIKE_PW_LIBS ?? `${process.env.HOME}/.local/smip-spike/pwlibs/root/usr/lib/x86_64-linux-gnu`;
    const app = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          `<html><body><h1 id="t">SMIP</h1><button onclick="document.getElementById('t').textContent='klik'">b</button></body></html>`,
          { headers: { "content-type": "text/html" } },
        ),
    });
    const notes: string[] = [];
    try {
      // Pakai library sistem dulu; workaround user-space hanya bila host belum `playwright install-deps`.
      let viaWorkaround = false;
      const browser = await chromium.launch().catch(async () => {
        viaWorkaround = true;
        return chromium.launch({ env: { ...process.env, LD_LIBRARY_PATH: libs } }).catch((e: Error) => {
          throw new Untested(`browser tidak bisa diluncurkan (library sistem hilang?): ${e.message.split("\n")[0]}`);
        });
      });
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${app.port}/`);
      await page.click("button");
      const txt = await page.textContent("#t");
      await browser.close();
      assert(txt === "klik", `interaksi DOM (dapat ${txt})`);
      notes.push("Playwright library dijalankan DI RUNTIME BUN: launch chromium-headless-shell, goto, click, textContent OK");
      notes.push(
        viaWorkaround
          ? `library sistem Chromium belum lengkap → memakai ekstrak user-space ${libs}; jalankan \`sudo npx playwright install-deps chromium\``
          : "library sistem Chromium lengkap (install-deps sudah dijalankan) — tanpa workaround",
      );
      return { status: viaWorkaround ? "WORKAROUND" : "COMPATIBLE", notes };
    } finally {
      app.stop(true);
    }
  },
};

export const drizzleKit: Check = {
  id: "drizzle-kit",
  task: "S-08",
  packages: ["drizzle-kit"],
  async run() {
    if (!(await reachable(`tcp://${INFRA.postgresHost}:${INFRA.postgresPort}`))) throw new Untested("Postgres tidak jalan");
    const root = `${import.meta.dir}/../..`;
    const dir = await mkdtemp(join(tmpdir(), "smip-dk-"));
    const admin = postgres({
      host: INFRA.postgresHost,
      port: INFRA.postgresPort,
      user: "postgres",
      database: "postgres",
      onnotice: () => {},
    });
    await admin.unsafe("DROP DATABASE IF EXISTS compat_dk");
    await admin.unsafe("CREATE DATABASE compat_dk");
    await admin.end();
    try {
      await writeFile(
        join(dir, "schema.ts"),
        `import { pgTable, uuid, text, timestamp, pgEnum } from "${root}/node_modules/drizzle-orm/pg-core/index.js";
export const eTopicStatus = pgEnum("e_topic_status", ["active", "paused", "archived"]);
export const topics = pgTable("topics", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull(), name: text("name").notNull(),
  status: eTopicStatus("status").notNull().default("active"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
`,
      );
      await writeFile(
        join(dir, "drizzle.config.ts"),
        `export default { dialect: "postgresql", schema: "./schema.ts", out: "./migrations",
  dbCredentials: { url: "postgres://postgres@${INFRA.postgresHost}:${INFRA.postgresPort}/compat_dk" } };
`,
      );
      const run = async (cmd: string) => {
        const p = Bun.spawn([process.execPath, "--bun", `${root}/node_modules/drizzle-kit/bin.cjs`, cmd], {
          cwd: dir,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, NODE_PATH: `${root}/node_modules` },
        });
        const [o, e, c] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
        assert(c === 0, `drizzle-kit ${cmd} exit ${c}: ${(e || o).slice(-400)}`);
      };
      await run("generate");
      const sqlFiles = (await readdir(join(dir, "migrations"))).filter((f) => f.endsWith(".sql"));
      assert(sqlFiles.length === 1, `1 file migrasi (dapat ${sqlFiles.join()})`);
      await run("migrate");
      const db = postgres({
        host: INFRA.postgresHost,
        port: INFRA.postgresPort,
        user: "postgres",
        database: "compat_dk",
        onnotice: () => {},
      });
      const cols = await db`select column_name from information_schema.columns where table_name='topics' order by ordinal_position`;
      await db.end();
      assert(cols.length === 5, `tabel topics 5 kolom (dapat ${cols.length})`);
      return {
        status: "COMPATIBLE",
        notes: [`drizzle-kit generate + migrate via \`bun --bun\` OK (${sqlFiles[0]}, enum e_ + timestamptz)`],
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
