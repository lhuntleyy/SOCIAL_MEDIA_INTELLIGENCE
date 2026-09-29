// I-23 cost guard lapis 2–3 (COST_MODEL §8): soft quota (hard = false) yang used ≥ limit → THROTTLE, bukan stop.
// Scheduler menaikkan interval efektif plan/stream yang terdampak ke maksimum (default 1 jam); ingestion tetap jalan.
// Hard quota tetap ditegakkan router (QUOTA_EXHAUSTED → run `skipped`). Sumber used = `quota_usage` (flush dari Redis).
import { sql } from "drizzle-orm";
import type { Tx } from "./client";
import { writeOutbox } from "./outbox";
import { GLOBAL_SCOPE_ID } from "./quota";

export const COST_GUARD_AGGREGATE = "cost_guard";

export interface BreachedPolicy {
  id: string;
  scope_type: "global" | "tenant" | "topic" | "provider" | "connector" | "provider_account";
  scope_id: string | null;
  period: "day" | "month";
  unit: string;
  used: number;
  limit: number;
}

export interface CostGuardState {
  global: boolean;
  tenants: Set<string>;
  topics: Set<string>;
  /** Platform yang connector/provider/akunnya melewati soft cap → semua plan/stream platform itu di-throttle. */
  platforms: Set<string>;
  breached: BreachedPolicy[];
  throttled: BreachedPolicy[];
  released: string[];
}

export const EMPTY_COST_GUARD: CostGuardState = {
  global: false,
  tenants: new Set(),
  topics: new Set(),
  platforms: new Set(),
  breached: [],
  throttled: [],
  released: [],
};

/**
 * Evaluasi soft cap untuk periode berjalan (zona `reset_tz` policy) + catat transisi (`throttled_since`, outbox
 * `cost_guard.throttled|released` → alert). Dipanggil di awal tick scheduler dalam transaksi yang sama.
 */
export async function evaluateCostGuard(tx: Tx): Promise<CostGuardState> {
  const rows = (await tx.execute(sql`
    select qp.id, qp.scope_type, qp.scope_id, qp.period, qp.unit, qp.limit_value::float8 as limit, qp.throttled_since,
           coalesce(u.used, 0)::float8 as used
    from quota_policies qp
    left join quota_usage u on u.scope_type = qp.scope_type and u.scope_id = coalesce(qp.scope_id, ${GLOBAL_SCOPE_ID}::uuid)
      and u.period = qp.period and u.unit = qp.unit
      and u.period_start = case when qp.period = 'day' then (now() at time zone qp.reset_tz)::date
                                else date_trunc('month', now() at time zone qp.reset_tz)::date end
    where qp.enabled and not qp.hard
    for update of qp skip locked`)) as unknown as (BreachedPolicy & { throttled_since: string | null })[];

  const s: CostGuardState = {
    ...EMPTY_COST_GUARD,
    tenants: new Set(),
    topics: new Set(),
    platforms: new Set(),
    breached: [],
    throttled: [],
    released: [],
  };
  const platformScopes: { type: string; id: string }[] = [];
  for (const r of rows) {
    const hit = r.used >= r.limit;
    const { throttled_since, ...p } = r;
    if (hit) {
      s.breached.push(p);
      if (!throttled_since) s.throttled.push(p);
      if (p.scope_type === "global") s.global = true;
      else if (p.scope_type === "tenant") s.tenants.add(p.scope_id!);
      else if (p.scope_type === "topic") s.topics.add(p.scope_id!);
      else platformScopes.push({ type: p.scope_type, id: p.scope_id! });
    } else if (throttled_since) s.released.push(p.id);
  }
  if (platformScopes.length) {
    const ids = (t: string) => platformScopes.filter((x) => x.type === t).map((x) => x.id);
    const arr = (xs: string[]) => sql`${`{${xs.join(",")}}`}::uuid[]`;
    const ps = (await tx.execute(sql`
      select distinct c.platform_code from connectors c
      where c.id = any(${arr(ids("connector"))}) or c.provider_id = any(${arr(ids("provider"))})
         or c.provider_id in (select provider_id from provider_accounts where id = any(${arr(ids("provider_account"))}))`)) as unknown as {
      platform_code: string;
    }[];
    for (const p of ps) s.platforms.add(p.platform_code);
  }
  for (const p of s.throttled) {
    await tx.execute(sql`update quota_policies set throttled_since = now() where id = ${p.id}`);
    await writeOutbox(tx, {
      aggregate: COST_GUARD_AGGREGATE,
      aggregateId: p.id,
      eventType: "cost_guard.throttled",
      payload: { scope_type: p.scope_type, scope_id: p.scope_id, period: p.period, unit: p.unit, used: p.used, limit: p.limit },
    });
  }
  for (const id of s.released) {
    await tx.execute(sql`update quota_policies set throttled_since = null where id = ${id}`);
    await writeOutbox(tx, { aggregate: COST_GUARD_AGGREGATE, aggregateId: id, eventType: "cost_guard.released" });
  }
  return s;
}

export interface GuardTarget {
  platform_code: string;
  tenant_id?: string;
  topic_id?: string;
  /** Run stream: dilayani banyak tenant — di-throttle bila scope platform/global, atau SEMUA tenant anggota ter-throttle. */
  member_tenants?: string[];
  member_topics?: string[];
}

export function isThrottled(s: CostGuardState, t: GuardTarget): boolean {
  if (s.global || s.platforms.has(t.platform_code)) return true;
  if (t.tenant_id && s.tenants.has(t.tenant_id)) return true;
  if (t.topic_id && s.topics.has(t.topic_id)) return true;
  if (t.member_tenants?.length) {
    const hit = t.member_tenants.every((x, i) => s.tenants.has(x) || s.topics.has(t.member_topics?.[i] ?? ""));
    if (hit) return true;
  }
  return false;
}
