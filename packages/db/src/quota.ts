// I-09: sinkronisasi counter quota Redis ↔ Postgres `quota_usage` (DATA_MODEL §4.10).
// Redis = sumber kebenaran live; flush berkala (worker-ops) menulis nilai absolut (idempoten, aman diulang);
// seed dipakai router saat kunci Redis hilang agar quota tidak "reset" diam-diam (overspend).
import { sql } from "drizzle-orm";
import { type Db, withSystem } from "./client";

export const GLOBAL_SCOPE_ID = "00000000-0000-0000-0000-000000000000";

export interface QuotaUsageKey {
  scopeType: string;
  scopeId: string | null;
  period: "day" | "month";
  periodStart: string;
  unit: string;
}
export interface QuotaUsageValue extends QuotaUsageKey {
  used: number;
  reserved: number;
}

/** Upsert nilai absolut. `used` tidak pernah mundur (GREATEST) — flush lama yang tertunda tidak menimpa nilai baru. */
export async function flushQuotaUsage(db: Db, rows: QuotaUsageValue[]): Promise<number> {
  if (!rows.length) return 0;
  await withSystem(db, async (tx) => {
    for (const r of rows) {
      await tx.execute(sql`
        insert into quota_usage (scope_type, scope_id, period, period_start, unit, used, reserved, updated_at)
        values (${r.scopeType}::e_quota_scope, ${r.scopeId ?? GLOBAL_SCOPE_ID}::uuid, ${r.period}::e_period, ${r.periodStart}::date, ${r.unit}::e_unit, ${r.used}, ${r.reserved}, now())
        on conflict (scope_type, scope_id, period, period_start, unit)
        do update set used = greatest(quota_usage.used, excluded.used), reserved = excluded.reserved, updated_at = now()`);
    }
  });
  return rows.length;
}

/** Baca counter tersimpan (untuk seed ulang Redis). Urutan hasil = urutan input; null bila belum ada. */
export async function loadQuotaUsage(db: Db, keys: QuotaUsageKey[]): Promise<(QuotaUsageValue | null)[]> {
  return withSystem(db, async (tx) =>
    Promise.all(
      keys.map(async (k) => {
        const rows = (await tx.execute(sql`
          select used, reserved from quota_usage
          where scope_type = ${k.scopeType}::e_quota_scope and scope_id = ${k.scopeId ?? GLOBAL_SCOPE_ID}::uuid
            and period = ${k.period}::e_period and period_start = ${k.periodStart}::date and unit = ${k.unit}::e_unit`)) as unknown as {
          used: string;
          reserved: string;
        }[];
        return rows[0] ? { ...k, used: Number(rows[0].used), reserved: Number(rows[0].reserved) } : null;
      }),
    ),
  );
}
