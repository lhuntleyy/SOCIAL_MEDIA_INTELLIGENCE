// Operator (H-04): hapus TOTAL data satu kantor yang sudah ditutup — `bun scripts/tenant-purge.ts <slug> --confirm <slug>`.
// ClickHouse (semua tabel ber-tenant) lalu Postgres (credential di-crypto-shred, tenant dihapus → cascade). Tidak bisa dibatalkan.
import { createClient } from "@clickhouse/client";
import { createDb, withSystem } from "@smip/db";
import { purgeTenant } from "@smip/worker-sink";
import { sql } from "drizzle-orm";

const [slug, flag, again] = process.argv.slice(2);
if (!slug || flag !== "--confirm" || again !== slug) throw new Error("pakai: bun scripts/tenant-purge.ts <slug> --confirm <slug>");
const { db, close } = createDb(process.env.DATABASE_URL!, { max: 2 });
const ch = createClient({
  url: process.env.CLICKHOUSE_URL,
  database: process.env.CLICKHOUSE_DB,
  username: process.env.CLICKHOUSE_USER,
  password: process.env.CLICKHOUSE_PASSWORD,
});
try {
  const [t] = (await withSystem(db, (tx) => tx.execute(sql`select id, name from tenants where slug = ${slug}`))) as unknown as {
    id: string;
    name: string;
  }[];
  if (!t) throw new Error(`kantor ${slug} tidak ditemukan`);
  const r = await purgeTenant(db, ch, t.id);
  console.log(`kantor ${t.name} (${slug}) dihapus total — ${r.clickhouse_tables} tabel ClickHouse dibersihkan`);
} finally {
  await ch.close();
  await close();
}
