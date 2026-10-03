// O-07 exporter state (OBSERVABILITY §3/§6): gauge dihitung dari Postgres tiap 60 dtk oleh scheduler (yang sudah melayani
// `/metrics`) — tanpa mengubah worker lain. Label hanya kardinalitas rendah (platform, status, queue, connector, provider).
import { type Db, withSystem } from "@smip/db";
import type { Registry } from "@smip/observability";
import { sql } from "drizzle-orm";

export function stateMetrics(reg: Registry, db: Db) {
  const runs = reg.gauge("smip_crawl_runs_recent", "Run pengambilan 1 jam terakhir per platform & status (plan + stream)", [
    "platform",
    "status",
  ]);
  const lastOk = reg.gauge("smip_platform_last_success_age_seconds", "Detik sejak run berhasil terakhir per platform (topik aktif)", [
    "platform",
  ]);
  const plansActive = reg.gauge("smip_crawl_plans_active", "Crawl plan aktif per platform", ["platform"]);
  const health = reg.gauge("smip_provider_health_score", "Skor kesehatan connector (0–100)", ["connector", "account_label"]);
  const circuit = reg.gauge("smip_circuit_state", "Circuit breaker (0 closed, 1 half_open, 2 open)", ["connector", "account_label"]);
  const accounts = reg.gauge("smip_provider_accounts", "Akun provider per status", ["provider", "status"]);
  const capFailed = reg.gauge("smip_capability_failed", "Capability connector aktif berstatus failed (1)", ["connector", "operation"]);
  const alertsOpen = reg.gauge("smip_alert_events_open", "Alert klien yang belum dibaca (semua kantor)");
  const outboxLag = reg.gauge("smip_outbox_unpublished", "Baris outbox belum terkirim");
  const outboxAge = reg.gauge("smip_outbox_oldest_unpublished_seconds", "Umur baris outbox tertua yang belum terkirim");
  const lastSample = reg.gauge("smip_state_metrics_timestamp_seconds", "Waktu sampling exporter state terakhir");

  return async function sample() {
    await withSystem(db, async (tx) => {
      const q = async <T>(s: ReturnType<typeof sql>) => (await tx.execute(s)) as unknown as T[];
      const r = await q<{ platform: string; status: string; n: number }>(sql`
        select coalesce(p.platform_code, s.platform_code) as platform, r.status::text as status, count(*)::int as n
        from crawl_runs r left join crawl_plans p on p.id = r.crawl_plan_id left join collection_streams s on s.id = r.collection_stream_id
        where r.scheduled_for >= now() - interval '1 hour' and coalesce(p.platform_code, s.platform_code) is not null group by 1, 2`);
      runs.reset();
      for (const x of r) runs.set({ platform: x.platform, status: x.status }, x.n);

      const ok = await q<{ platform: string; age: number | null }>(sql`
        select cp.platform_code as platform,
               extract(epoch from now() - max(r.finished_at) filter (where r.status in ('succeeded', 'partial')))::float8 as age
        from crawl_plans cp join topics t on t.id = cp.topic_id
        left join crawl_runs r on r.crawl_plan_id = cp.id and r.scheduled_for >= now() - interval '7 days'
        where t.status = 'active' and t.deleted_at is null and cp.status in ('active', 'error_backoff') group by 1`);
      lastOk.reset();
      plansActive.reset();
      for (const x of ok) lastOk.set({ platform: x.platform }, x.age ?? 7 * 86_400);
      for (const x of await q<{ platform: string; n: number }>(
        sql`select platform_code as platform, count(*)::int as n from crawl_plans where status = 'active' group by 1`,
      ))
        plansActive.set({ platform: x.platform }, x.n);

      health.reset();
      circuit.reset();
      for (const x of await q<{ connector: string; account: string; score: number | null; circuit: string }>(sql`
        select c.key as connector, coalesce(pa.label, '-') as account, h.score, h.circuit::text as circuit
        from provider_health h join connectors c on c.id = h.connector_id
        left join provider_accounts pa on pa.id = h.provider_account_key where c.enabled`)) {
        if (x.score !== null) health.set({ connector: x.connector, account_label: x.account }, Number(x.score));
        circuit.set({ connector: x.connector, account_label: x.account }, x.circuit === "open" ? 2 : x.circuit === "half_open" ? 1 : 0);
      }

      accounts.reset();
      for (const x of await q<{ provider: string; status: string; n: number }>(sql`
        select p.key as provider, a.status::text as status, count(*)::int as n
        from provider_accounts a join providers p on p.id = a.provider_id group by 1, 2`))
        accounts.set({ provider: x.provider, status: x.status }, x.n);

      capFailed.reset();
      for (const x of await q<{ connector: string; operation: string }>(sql`
        select distinct c.key as connector, cc.operation::text as operation
        from connector_capabilities cc join connectors c on c.id = cc.connector_id
        join routing_rules rr on rr.connector_id = c.id and rr.enabled join routing_policies rp on rp.id = rr.policy_id and rp.enabled
          and rp.operation = cc.operation
        where c.enabled and cc.status = 'failed'`))
        capFailed.set({ connector: x.connector, operation: x.operation }, 1);

      const [a] = await q<{ n: number }>(sql`select count(*)::int as n from alert_events where status = 'open'`);
      alertsOpen.set({}, a?.n ?? 0);
      const [o] = await q<{ n: number; age: number | null }>(sql`
        select count(*)::int as n, extract(epoch from now() - min(created_at))::float8 as age from outbox where published_at is null`);
      outboxLag.set({}, o?.n ?? 0);
      outboxAge.set({}, o?.age ?? 0);
    });
    lastSample.set({}, Date.now() / 1000);
  };
}
