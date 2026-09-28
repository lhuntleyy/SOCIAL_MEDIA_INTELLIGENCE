// Klien DB aplikasi: drizzle di atas Bun.SQL (ADR-001 S-21). Query tenant WAJIB lewat withTenant()
// — transaksi + set_config lokal (bukan SET LOCAL = $1, ditolak Postgres; S-08).
import type { TenantId } from "@smip/core";
import { sql as dsql } from "drizzle-orm";
import { type BunSQLDatabase, drizzle } from "drizzle-orm/bun-sql";
import * as schema from "./schema";

export type Db = BunSQLDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function createDb(url: string, opts: { max?: number } = {}): { db: Db; close: () => Promise<void> } {
  const client = new Bun.SQL(url, { max: opts.max ?? 10 });
  return { db: drizzle({ client, schema }), close: () => client.close() };
}

/**
 * Jalankan `fn` dalam transaksi berkonteks tenant sebagai role `smip_app` (NOBYPASSRLS) → RLS membatasi ke `tenantId`.
 * Koneksi login (API: NOINHERIT, member smip_app & smip_auth) tidak punya hak apa pun sampai SET LOCAL ROLE.
 */
export async function withTenant<T>(db: Db, tenantId: TenantId, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(dsql.raw("SET LOCAL ROLE smip_app"));
    await tx.execute(dsql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

/** Jalur autentikasi (login/refresh/MFA) sebagai role `smip_auth` — satu-satunya role yang boleh membaca hash password. */
export async function withAuthRole<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(dsql.raw("SET LOCAL ROLE smip_auth"));
    return fn(tx);
  });
}

/**
 * Operasi lintas tenant milik platform operator (admin tenant, membership lintas tenant, verifikasi impersonasi)
 * sebagai `smip_system` (BYPASSRLS). Pemanggil WAJIB sudah memverifikasi `op=true` — RLS tidak melindungi di sini.
 */
export async function withSystem<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(dsql.raw("SET LOCAL ROLE smip_system"));
    return fn(tx);
  });
}
