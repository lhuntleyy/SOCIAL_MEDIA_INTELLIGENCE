// Interval efektif crawl plan (paket kantor 0029): interval eksplisit topik (API) → paket kantor (plans.limits.platform_intervals)
// → jadwal bawaan owner (platforms.crawl_interval_sec) → bawaan topik; tidak lebih cepat dari min_interval_sec paket.
// Dipanggil saat paket kantor / jadwal bawaan berubah; jadwal berikutnya tidak lebih lambat dari interval baru. Collection stream
// mengikuti sendiri (planStreams: kelas interval anggota).
import { sql } from "drizzle-orm";
import type { Tx } from "./client";

export async function resyncPlanIntervals(tx: Tx, f: { tenantId?: string; platform?: string }) {
  await tx.execute(sql`update crawl_plans cp set interval_sec = x.iv,
      next_run_at = least(cp.next_run_at, now() + make_interval(secs => x.iv)), updated_at = now()
    from (select cp2.id,
                 least(86400, greatest(coalesce((pl.limits->>'min_interval_sec')::int, 60),
                   coalesce(tp.interval_sec, (pl.limits->'platform_intervals'->>cp2.platform_code)::int, pf.crawl_interval_sec,
                            t.default_interval_sec))) as iv
          from crawl_plans cp2
          join topics t on t.id = cp2.topic_id
          join tenants tn on tn.id = cp2.tenant_id
          left join plans pl on pl.id = tn.plan_id
          join platforms pf on pf.code = cp2.platform_code
          left join topic_platforms tp on tp.topic_id = cp2.topic_id and tp.platform_code = cp2.platform_code
          where cp2.status <> 'disabled'
            ${f.tenantId ? sql`and cp2.tenant_id = ${f.tenantId}` : sql``}
            ${f.platform ? sql`and cp2.platform_code = ${f.platform}` : sql``}) x
    where cp.id = x.id and cp.interval_sec <> x.iv`);
}
