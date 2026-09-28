// F-04: migrator SQL berpasangan up/down (AC "migrate up/down bersih").
// drizzle-kit tidak mendukung migrasi down → SQL-first (fallback ARCHITECTURE §2 "SQL murni + migrator sendiri");
// drizzle-orm tetap dipakai untuk query bertipe (src/schema.ts), dijaga sinkron oleh test.
//
// File: migrations/NNNN_nama.up.sql + NNNN_nama.down.sql. Satu migrasi = satu transaksi.
// Migrasi yang sudah diterapkan tidak boleh diedit (checksum) — buat migrasi baru (expand/contract, DEPLOYMENT §6).
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type postgres from "postgres";

export const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");

export interface Migration {
  version: number;
  name: string;
  up: string;
  down: string;
  checksum: string;
}

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.(up|down)\.sql$/.test(f));
  const byVersion = new Map<number, Partial<Migration>>();
  for (const f of files) {
    const m = /^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/.exec(f)!;
    const v = Number(m[1]);
    const cur = byVersion.get(v) ?? { version: v, name: m[2] };
    if (cur.name !== m[2]) throw new Error(`versi ${v} dipakai dua nama: ${cur.name} & ${m[2]}`);
    cur[m[3] as "up" | "down"] = await Bun.file(join(dir, f)).text();
    byVersion.set(v, cur);
  }
  const out: Migration[] = [];
  for (const m of [...byVersion.values()].sort((a, b) => a.version! - b.version!)) {
    if (!m.up || !m.down) throw new Error(`migrasi ${m.version}_${m.name} wajib punya .up.sql dan .down.sql`);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(m.up);
    out.push({ ...(m as Migration), checksum: hasher.digest("hex").slice(0, 16) });
  }
  out.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`nomor migrasi harus berurutan tanpa lompatan (ditemukan ${m.version} di posisi ${i + 1})`);
  });
  return out;
}

const TABLE = "smip_schema_migrations";

async function ensureTable(sql: postgres.Sql) {
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    version int PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
}

export async function status(sql: postgres.Sql, migrations?: Migration[]) {
  const all = migrations ?? (await loadMigrations());
  await ensureTable(sql);
  const applied = await sql<{ version: number; checksum: string }[]>`SELECT version, checksum FROM smip_schema_migrations ORDER BY version`;
  for (const a of applied) {
    const m = all.find((x) => x.version === a.version);
    if (!m) throw new Error(`DB punya migrasi ${a.version} yang tidak ada di repo`);
    if (m.checksum !== a.checksum)
      throw new Error(`migrasi ${m.version}_${m.name} diubah setelah diterapkan (checksum beda) — buat migrasi baru`);
  }
  return { applied: applied.map((a) => a.version), pending: all.filter((m) => !applied.some((a) => a.version === m.version)) };
}

/** Terapkan migrasi tertunda (sampai `to` bila diberikan). Kembalikan versi yang diterapkan. */
export async function up(sql: postgres.Sql, opts: { to?: number; migrations?: Migration[] } = {}): Promise<number[]> {
  const { pending } = await status(sql, opts.migrations);
  const done: number[] = [];
  for (const m of pending.filter((p) => opts.to === undefined || p.version <= opts.to)) {
    await sql.begin(async (tx) => {
      await tx.unsafe(m.up);
      await tx`INSERT INTO smip_schema_migrations (version, name, checksum) VALUES (${m.version}, ${m.name}, ${m.checksum})`;
    });
    done.push(m.version);
  }
  return done;
}

/** Turunkan migrasi terakhir sebanyak `steps` (default 1), atau sampai versi `to` (0 = kosong). */
export async function down(sql: postgres.Sql, opts: { steps?: number; to?: number; migrations?: Migration[] } = {}): Promise<number[]> {
  const all = opts.migrations ?? (await loadMigrations());
  const { applied } = await status(sql, all);
  const targets = [...applied].reverse().filter((v, i) => (opts.to !== undefined ? v > opts.to : i < (opts.steps ?? 1)));
  for (const v of targets) {
    const m = all.find((x) => x.version === v)!;
    await sql.begin(async (tx) => {
      await tx.unsafe(m.down);
      await tx`DELETE FROM smip_schema_migrations WHERE version = ${v}`;
    });
  }
  return targets;
}
