// F-05: migrator ClickHouse (pasangan up/down + checksum), pola sama dengan packages/db/src/migrate.ts.
// ClickHouse tidak punya transaksi DDL: statement dijalankan berurutan; down wajib idempoten (IF EXISTS)
// agar migrasi yang gagal di tengah bisa dibersihkan dengan `down` lalu `up` ulang.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ClickHouseClient } from "@clickhouse/client";

export const CH_MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");

export interface ChMigration {
  version: number;
  name: string;
  up: string[];
  down: string[];
  checksum: string;
}

/** Pisah file SQL jadi statement (akhiran `;` di akhir baris); komentar `--` dibuang. */
export function splitStatements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(/;[ \t]*(?:--[^\n]*)?(?:\n|$)/) // `;` di akhir baris, boleh diikuti komentar `-- …`
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function loadChMigrations(dir = CH_MIGRATIONS_DIR): Promise<ChMigration[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.(up|down)\.sql$/.test(f));
  const map = new Map<number, { name: string; up?: string; down?: string }>();
  for (const f of files) {
    const m = /^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/.exec(f)!;
    const v = Number(m[1]);
    const cur = map.get(v) ?? { name: m[2]! };
    cur[m[3] as "up" | "down"] = await Bun.file(join(dir, f)).text();
    map.set(v, cur);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a - b)
    .map(([version, m], i) => {
      if (version !== i + 1) throw new Error(`nomor migrasi ClickHouse harus berurutan (ditemukan ${version} di posisi ${i + 1})`);
      if (!m.up || !m.down) throw new Error(`migrasi ${version}_${m.name} wajib punya .up.sql dan .down.sql`);
      const h = new Bun.CryptoHasher("sha256");
      h.update(m.up);
      return { version, name: m.name, up: splitStatements(m.up), down: splitStatements(m.down), checksum: h.digest("hex").slice(0, 16) };
    });
}

const TABLE = "smip_schema_migrations";

async function applied(ch: ClickHouseClient): Promise<{ version: number; checksum: string }[]> {
  await ch.command({
    query: `CREATE TABLE IF NOT EXISTS ${TABLE} (version UInt32, name String, checksum String, applied_at DateTime DEFAULT now()) ENGINE = MergeTree ORDER BY version`,
  });
  const rs = await ch.query({ query: `SELECT version, checksum FROM ${TABLE} ORDER BY version`, format: "JSONEachRow" });
  return (await rs.json()) as { version: number; checksum: string }[];
}

export async function chStatus(ch: ClickHouseClient, migrations?: ChMigration[]) {
  const all = migrations ?? (await loadChMigrations());
  const done = await applied(ch);
  for (const a of done) {
    const m = all.find((x) => x.version === a.version);
    if (!m) throw new Error(`ClickHouse punya migrasi ${a.version} yang tidak ada di repo`);
    if (m.checksum !== a.checksum) throw new Error(`migrasi ClickHouse ${m.version}_${m.name} diubah setelah diterapkan (checksum beda)`);
  }
  return { applied: done.map((d) => d.version), pending: all.filter((m) => !done.some((d) => d.version === m.version)) };
}

export async function chUp(ch: ClickHouseClient, opts: { migrations?: ChMigration[] } = {}): Promise<number[]> {
  const { pending } = await chStatus(ch, opts.migrations);
  for (const m of pending) {
    for (const stmt of m.up) await ch.command({ query: stmt });
    await ch.insert({ table: TABLE, values: [{ version: m.version, name: m.name, checksum: m.checksum }], format: "JSONEachRow" });
  }
  return pending.map((m) => m.version);
}

export async function chDown(
  ch: ClickHouseClient,
  opts: { to?: number; steps?: number; migrations?: ChMigration[] } = {},
): Promise<number[]> {
  const all = opts.migrations ?? (await loadChMigrations());
  const { applied: done } = await chStatus(ch, all);
  const targets = [...done].reverse().filter((v, i) => (opts.to !== undefined ? v > opts.to : i < (opts.steps ?? 1)));
  for (const v of targets) {
    for (const stmt of all.find((m) => m.version === v)!.down) await ch.command({ query: stmt });
    await ch.command({ query: `DELETE FROM ${TABLE} WHERE version = ${v}` });
  }
  return targets;
}
