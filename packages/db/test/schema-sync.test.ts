// Skema drizzle (src/schema.ts) harus cocok dengan DB hasil migrasi SQL: nama kolom, nullability, tipe dasar.
// Plus: withTenant() lewat Bun.SQL + drizzle menegakkan RLS.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TenantId } from "@smip/core";
import { getTableConfig } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { ALL_TABLES, auditLogs, createDb, tenants, up, withSystem, withTenant } from "../src";

// default: Postgres compose (`bun run dev:up`); override TEST_PG_URL (mis. spike: postgres://postgres@127.0.0.1:5433/postgres)
const PG_URL = new URL(process.env.TEST_PG_URL ?? "postgres://smip_owner:smip_owner_dev@127.0.0.1:55432/postgres");
const HOST = {
  host: PG_URL.hostname,
  port: Number(PG_URL.port),
  user: decodeURIComponent(PG_URL.username),
  password: PG_URL.password ? decodeURIComponent(PG_URL.password) : undefined,
  onnotice: () => {},
};
const DB = `smip_sync_${Date.now()}`;
const pgUp = await postgres({ ...HOST, database: "postgres", connect_timeout: 2 })`select 1`.then(
  () => true,
  () => false,
);

// nama tipe drizzle → udt_name Postgres (array: udt diawali "_")
const ALIAS: Record<string, string> = {
  boolean: "bool",
  integer: "int4",
  smallint: "int2",
  bigint: "int8",
  real: "float4",
  "timestamp with time zone": "timestamptz",
};
function sameType(drizzleType: string, udt: string): boolean {
  const base = drizzleType.replace(/\[\]$/, "").replace(/\(.*\)/, "");
  return (ALIAS[base] ?? base) === udt.replace(/^_/, "");
}

describe.skipIf(!pgUp)("drizzle schema ↔ migrasi SQL", () => {
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  beforeAll(async () => {
    admin = postgres({ ...HOST, database: "postgres" });
    await admin.unsafe(`CREATE DATABASE ${DB}`);
    sql = postgres({ ...HOST, database: DB });
    await up(sql);
  });
  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin?.end();
  });

  test("setiap tabel drizzle: kolom & NOT NULL identik dengan DB", async () => {
    const mismatches: string[] = [];
    for (const table of Object.values(ALL_TABLES)) {
      const cfg = getTableConfig(table);
      const cols = await sql<{ column_name: string; is_nullable: string; udt_name: string }[]>`
        select column_name, is_nullable, udt_name from information_schema.columns where table_schema = 'public' and table_name = ${cfg.name}`;
      const db = new Map(cols.map((c) => [c.column_name, c]));
      const dz = new Map(cfg.columns.map((c) => [c.name, c]));
      for (const [name, c] of dz) {
        const d = db.get(name);
        if (!d) mismatches.push(`${cfg.name}.${name}: tidak ada di DB`);
        else if ((d.is_nullable === "NO") !== c.notNull && !c.primary)
          mismatches.push(`${cfg.name}.${name}: notNull drizzle=${c.notNull} db=${d.is_nullable}`);
        else if (!sameType(c.getSQLType(), d.udt_name))
          mismatches.push(`${cfg.name}.${name}: tipe drizzle=${c.getSQLType()} db=${d.udt_name}`);
      }
      for (const name of db.keys()) if (!dz.has(name)) mismatches.push(`${cfg.name}.${name}: ada di DB, tidak di drizzle`);
    }
    expect(mismatches).toEqual([]);
  });

  test("jsonb via drizzle bun-sql tersimpan sebagai JSON sungguhan, bukan string ter-encode ganda (regresi F-10)", async () => {
    const { db, close } = createDb(`postgres://${HOST.user}${HOST.password ? `:${HOST.password}` : ""}@${HOST.host}:${HOST.port}/${DB}`, {
      max: 1,
    });
    try {
      const values = [{ reason: "tiket SUP-1", n: 1 }, [1, { x: 2 }], "teks", 42, true];
      for (const after of values)
        await withSystem(db, (tx) =>
          tx.insert(auditLogs).values({ id: Bun.randomUUIDv7(), actorType: "system", action: "jsonb.test", after }),
        );
      const rows = await sql<{ t: string }[]>`select jsonb_typeof(after) t from audit_logs where action = 'jsonb.test' order by id`;
      expect(rows.map((r) => r.t)).toEqual(["object", "array", "string", "number", "boolean"]);
      const [r] = await sql`select after->>'reason' r from audit_logs where action = 'jsonb.test' and jsonb_typeof(after) = 'object'`;
      expect(r!.r).toBe("tiket SUP-1");
      const back = await withSystem(db, (tx) => tx.select({ after: auditLogs.after }).from(auditLogs));
      expect(back.map((b) => b.after)).toEqual(values);
    } finally {
      await close();
    }
  });

  test("withTenant (Bun.SQL + drizzle) menegakkan RLS sebagai smip_app", async () => {
    const A = TenantId("0192f000-0000-7000-8000-00000000000a");
    const B = TenantId("0192f000-0000-7000-8000-00000000000b");
    await sql`insert into tenants (id, slug, name) values (${A}, 'a', 'A'), (${B}, 'b', 'B')`;
    const { db, close } = createDb(`postgres://${HOST.user}${HOST.password ? `:${HOST.password}` : ""}@${HOST.host}:${HOST.port}/${DB}`, {
      max: 1,
    });
    try {
      const rows = await withTenant(db, A, (tx) => tx.select({ slug: tenants.slug }).from(tenants));
      expect(rows).toEqual([{ slug: "a" }]);
      // konteks tidak bocor ke transaksi berikutnya pada koneksi yang sama
      const leak = await db.transaction(async (tx) => {
        await tx.execute("SET LOCAL ROLE smip_app" as never);
        return tx.select().from(tenants);
      });
      expect(leak).toEqual([]);
    } finally {
      await close();
    }
  });
});
