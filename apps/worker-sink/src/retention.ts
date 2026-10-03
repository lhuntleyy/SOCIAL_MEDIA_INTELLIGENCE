// H-04 job retensi harian (DATA_MODEL §9): per kantor sesuai retention_days paket (bawaan Pengaturan), post global tak-match /
// tak lagi dipakai, data operasional Postgres (outbox terkirim, ledger dedup). Angka diatur owner di Pengaturan (`retention.*`).
import type { ClickHouseClient } from "@clickhouse/client";
import { purgeGlobalPosts, purgeTenantData } from "@smip/analytics";
import { type Db, loadSettings, withSystem } from "@smip/db";
import { sql } from "drizzle-orm";

const DAY = 86_400_000;

export interface RetentionResult {
  tenants: { tenant_id: string; days: number }[];
  outbox_deleted: number;
  processed_deleted: number;
}

export async function runRetention(db: Db, ch: ClickHouseClient, o: { now?: () => Date; sync?: boolean } = {}): Promise<RetentionResult> {
  const now = o.now?.() ?? new Date();
  const s = await loadSettings(db);
  const tenants = await withSystem(
    db,
    async (tx) =>
      (await tx.execute(sql`select t.id as tenant_id, (p.limits->>'retention_days')::int as days
        from tenants t left join plans p on p.id = t.plan_id where t.kind = 'office'`)) as unknown as {
        tenant_id: string;
        days: number | null;
      }[],
  );
  const out: RetentionResult = { tenants: [], outbox_deleted: 0, processed_deleted: 0 };
  for (const t of tenants) {
    const days = Math.max(30, t.days ?? s["retention.default_tenant_days"]);
    await purgeTenantData(ch, t.tenant_id, new Date(now.getTime() - days * DAY), { sync: o.sync });
    out.tenants.push({ tenant_id: t.tenant_id, days });
  }
  await purgeGlobalPosts(
    ch,
    {
      unmatchedBefore: new Date(now.getTime() - s["retention.unmatched_posts_days"] * DAY),
      globalBefore: new Date(now.getTime() - s["retention.global_posts_days"] * DAY),
    },
    { sync: o.sync },
  );
  const ops = new Date(now.getTime() - s["retention.ops_days"] * DAY).toISOString();
  await withSystem(db, async (tx) => {
    const a = (await tx.execute(
      sql`delete from outbox where published_at is not null and published_at < ${ops}::timestamptz returning 1`,
    )) as unknown as unknown[];
    const b = (await tx.execute(
      sql`delete from processed_messages where processed_at < ${ops}::timestamptz returning 1`,
    )) as unknown as unknown[];
    out.outbox_deleted = a.length;
    out.processed_deleted = b.length;
  });
  return out;
}

/**
 * Hapus TOTAL data satu kantor (UU PDP / akhir kontrak): ClickHouse (sinkron) lalu Postgres (credential di-crypto-shred, baris
 * tenant dihapus → cascade). Hanya untuk kantor berstatus `closed`. Dipanggil lewat `scripts/tenant-purge.ts` (operator).
 */
export async function purgeTenant(db: Db, ch: ClickHouseClient, tenantId: string) {
  const [t] = await withSystem(
    db,
    async (tx) =>
      (await tx.execute(sql`select status, kind from tenants where id = ${tenantId}`)) as unknown as { status: string; kind: string }[],
  );
  if (!t) throw new Error("kantor tidak ditemukan");
  if (t.kind !== "office") throw new Error("hanya kantor (bukan tenant platform)");
  if (t.status !== "closed") throw new Error("tutup kantor dulu (status closed) sebelum dihapus total");
  const tables = await purgeTenantData(ch, tenantId, null, { sync: true });
  await withSystem(db, async (tx) => {
    await tx.execute(sql`update credentials set wrapped_dek = null where tenant_id = ${tenantId}`);
    await tx.execute(sql`delete from tenants where id = ${tenantId}`);
  });
  return { clickhouse_tables: tables.length };
}
