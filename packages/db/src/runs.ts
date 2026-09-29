// Pembuatan crawl_run + job `crawl.dispatch` via outbox dalam transaksi pemanggil (scheduler tick, API backfill).
import type { CrawlDispatchPayload } from "@smip/contracts";
import { sql } from "drizzle-orm";
import { type Db, type Tx, withSystem } from "./client";
import { writeJobOutbox } from "./outbox";

export interface PlanForRun {
  id: string;
  tenant_id: string;
  topic_id: string;
  topic_query_id: string;
  platform_code: string;
  operation: CrawlDispatchPayload["operation"];
  interval_sec: number;
}

/** Collection stream (ADR-009): run system-owned — tanpa tenant/topik; tenant ditentukan saat matching. */
export interface StreamForRun {
  stream: true;
  id: string;
  platform_code: string;
  operation: CrawlDispatchPayload["operation"];
  interval_sec: number;
}

/** Tabel pemilik run: crawl_plans (per query) atau collection_streams (gabungan). */
export type RunOwnerTable = "crawl_plans" | "collection_streams";
const ownerSql = (t: RunOwnerTable) => sql.raw(t === "collection_streams" ? "collection_streams" : "crawl_plans");

/** BullMQ priority: 1 = tertinggi. Backfill manual/celah = 10 (paling rendah, QUEUE_SPEC §3). */
export const BACKFILL_PRIORITY = 10;

export async function createCrawlRun(
  tx: Tx,
  p: PlanForRun | StreamForRun,
  kind: "incremental" | "backfill",
  window: { since: Date; until: Date },
  now: Date,
  priority: number,
): Promise<string> {
  const id = Bun.randomUUIDv7();
  const stream = "stream" in p;
  await tx.execute(sql`insert into crawl_runs (id, tenant_id, crawl_plan_id, collection_stream_id, scheduled_for, kind, status, window_from, window_to)
    values (${id}, ${stream ? null : p.tenant_id}, ${stream ? null : p.id}, ${stream ? p.id : null}, ${now.toISOString()}::timestamptz,
            ${kind}::e_run_kind, 'queued', ${window.since.toISOString()}::timestamptz, ${window.until.toISOString()}::timestamptz)`);
  const payload: CrawlDispatchPayload = {
    crawl_run_id: id,
    scheduled_for: now.toISOString(),
    crawl_plan_id: stream ? null : p.id,
    ...(stream ? { collection_stream_id: p.id } : {}),
    topic_id: stream ? null : p.topic_id,
    topic_query_id: stream ? null : p.topic_query_id,
    platform: p.platform_code,
    operation: p.operation,
    run_kind: kind,
    window: { since: window.since.toISOString(), until: window.until.toISOString() },
    interval_sec: p.interval_sec,
    attempt_no: 1,
    exclude_connector_ids: [],
    exclude_account_ids: [],
  };
  await writeJobOutbox(tx, id, {
    queue: "crawl.dispatch",
    idempotencyKey: `run.${id}.attempt.1`,
    type: "crawl.dispatch",
    tenantId: stream ? null : p.tenant_id,
    payload,
    priority,
  });
  return id;
}

/**
 * Celah (gap_windows) milik run backfill: sukses → dibuang; gagal → `run_id` dilepas agar scheduler mencoba lagi
 * (CONNECTOR_SPEC §7; umur maksimum celah = I-24).
 */
export async function settleGap(tx: Tx, planId: string, runId: string, ok: boolean, table: RunOwnerTable = "crawl_plans"): Promise<void> {
  await tx.execute(sql`update ${ownerSql(table)} set gap_windows = coalesce((
      select jsonb_agg(case when g->>'run_id' = ${runId} then g - 'run_id' else g end)
      from jsonb_array_elements(gap_windows) g
      where not (${ok} and g->>'run_id' = ${runId})), '[]'::jsonb)
    where id = ${planId} and gap_windows @> ${JSON.stringify([{ run_id: runId }])}::text::jsonb`);
}

/** Batas celah per plan: celah tertua dibuang (data hilang yang disadari — lihat pruneGaps). */
export const MAX_GAPS = 20;

/**
 * Rentang yang HILANG pada run partial menurut urutan hasil connector (CONNECTOR_SPEC §7):
 *   desc (terbaru dulu) → [window_from, min(published) diterima]; asc → [max(published) diterima, window_to];
 *   tak terurut / tak diketahui → seluruh window (tidak bisa tahu bagian mana yang hilang).
 */
export function gapWindow(
  r: {
    window_from: Date | null;
    window_to: Date | null;
    min_published_at: Date | null;
    max_published_at: Date | null;
    result_order: string | null;
  },
  now = new Date(),
): { since: string; until: string } {
  const from = (r.window_from ?? now).toISOString();
  const to = (r.window_to ?? now).toISOString();
  if (r.result_order === "desc") return { since: from, until: (r.min_published_at ?? r.window_to ?? now).toISOString() };
  if (r.result_order === "asc") return { since: (r.max_published_at ?? r.window_from ?? now).toISOString(), until: to };
  return { since: from, until: to };
}

/**
 * Buang celah yang melewati umur maksimum (default 24 jam) dan belum sedang diambil — dicatat sebagai data hilang
 * yang DISADARI (metrik smip_crawl_gap_abandoned_total), bukan diam-diam. Mengembalikan jumlah per platform.
 */
export async function pruneGaps(tx: Tx, maxAgeSec: number, now = new Date()): Promise<Record<string, number>> {
  const cutoff = new Date(now.getTime() - maxAgeSec * 1000).toISOString();
  const out: Record<string, number> = {};
  for (const table of ["crawl_plans", "collection_streams"] as const) {
    const rows = (await tx.execute(sql`
      with old as (
        select p.id, p.platform_code,
               count(*) filter (where g->>'run_id' is null and (g->>'created_at')::timestamptz < ${cutoff}::timestamptz) as n
        from ${ownerSql(table)} p, jsonb_array_elements(p.gap_windows) g
        group by p.id, p.platform_code)
      update ${ownerSql(table)} p set gap_windows = coalesce((
          select jsonb_agg(g) from jsonb_array_elements(p.gap_windows) g
          where not (g->>'run_id' is null and (g->>'created_at')::timestamptz < ${cutoff}::timestamptz)), '[]'::jsonb), updated_at = now()
      from old where old.id = p.id and old.n > 0
      returning old.platform_code, old.n`)) as unknown as { platform_code: string; n: string | number }[];
    for (const r of rows) out[r.platform_code] = (out[r.platform_code] ?? 0) + Number(r.n);
  }
  return out;
}

export interface FinalizedRun {
  runId: string;
  outcome: "succeeded" | "partial";
  tenantId: string | null;
  planId: string | null;
  streamId: string | null;
}

/**
 * Tutup run bila semua pekerjaan hilir selesai: status `processing` & `pending_batches = 0` (di bawah row lock).
 * succeeded → high_watermark maju ke max(published_at) item diterima; partial → celah [window_from, min(published_at)]
 * masuk gap_windows dan watermark TIDAK maju (CONNECTOR_SPEC §7, P-18). Plan dibebaskan.
 */
export async function finalizeRunIfDone(tx: Tx, runId: string, now = new Date()): Promise<FinalizedRun | null> {
  const [r] =
    (await tx.execute(sql`select r.id, r.scheduled_for::text as sf, r.status, r.pending_batches, r.error_code, r.crawl_plan_id, r.collection_stream_id, r.tenant_id, r.kind,
      r.window_from, r.window_to, r.min_published_at, r.max_published_at,
      -- urutan hasil connector attempt terakhir (declared.result_order) → sisi window mana yang hilang
      (select cc.declared->>'result_order' from connector_capabilities cc
        where cc.connector_id::text = r.routing->>'connector_id'
          and cc.operation = coalesce((select operation from crawl_plans where id = r.crawl_plan_id),
                                      (select operation from collection_streams where id = r.collection_stream_id))) as result_order
    from crawl_runs r where r.id = ${runId} for update of r`)) as unknown as {
      id: string;
      sf: string;
      status: string;
      pending_batches: number;
      error_code: string | null;
      crawl_plan_id: string | null;
      collection_stream_id: string | null;
      tenant_id: string | null;
      kind: string;
      window_from: Date | null;
      window_to: Date | null;
      min_published_at: Date | null;
      max_published_at: Date | null;
      result_order: string | null;
    }[];
  if (r?.status !== "processing" || r.pending_batches > 0) return null;
  const outcome = r.error_code ? "partial" : "succeeded";
  // scheduled_for via teks: Date JS hanya milidetik, timestamptz Postgres mikrodetik → perbandingan Date bisa meleset
  await tx.execute(sql`update crawl_runs set status = ${outcome}::e_run_status, finished_at = ${now.toISOString()}::timestamptz
    where id = ${r.id} and scheduled_for = ${r.sf}::timestamptz`);
  const ownerId = r.crawl_plan_id ?? r.collection_stream_id;
  const table: RunOwnerTable = r.crawl_plan_id ? "crawl_plans" : "collection_streams";
  if (ownerId) {
    if (outcome === "succeeded") {
      await tx.execute(sql`update ${ownerSql(table)} set consecutive_failures = 0, updated_at = now(),
          inflight_run_id = case when inflight_run_id = ${r.id} then null else inflight_run_id end,
          high_watermark = case when ${r.kind} = 'incremental' and ${r.max_published_at?.toISOString() ?? null}::timestamptz is not null
                                then greatest(coalesce(high_watermark, '-infinity'), ${r.max_published_at?.toISOString() ?? null}::timestamptz)
                                else high_watermark end
        where id = ${ownerId}`);
      await settleGap(tx, ownerId, r.id, true, table);
    } else {
      const gap = r.window_from ? [{ ...gapWindow(r, now), created_at: now.toISOString() }] : [];
      await tx.execute(sql`update ${ownerSql(table)} set updated_at = now(),
          inflight_run_id = case when inflight_run_id = ${r.id} then null else inflight_run_id end,
          gap_windows = (select coalesce(jsonb_agg(g order by g->>'created_at'), '[]'::jsonb) from (
            select g from jsonb_array_elements(gap_windows || ${JSON.stringify(r.kind === "incremental" ? gap : [])}::text::jsonb) g
            order by g->>'created_at' desc limit ${MAX_GAPS}) t)
        where id = ${ownerId}`);
      await settleGap(tx, ownerId, r.id, false, table);
    }
  }
  if (r.collection_stream_id) await allocateStreamRunCost(tx, r.id); // I-25: biaya run stream → tenant
  return { runId: r.id, outcome, tenantId: r.tenant_id, planId: r.crawl_plan_id, streamId: r.collection_stream_id };
}

/** Baris gazetteer (geo_regions) untuk worker-pipeline. */
export async function loadGeoRegions(db: Db): Promise<{ code: string; name: string; aliases: string[] }[]> {
  return (await withSystem(db, (tx) => tx.execute(sql`select code, name, aliases from geo_regions order by code`))) as unknown as {
    code: string;
    name: string;
    aliases: string[];
  }[];
}

/** Ledger idempotensi: true = pesan ini belum pernah diproses (klaim berhasil, ikut transaksi pemanggil). */
export async function claimMessage(tx: Tx, key: string): Promise<boolean> {
  const r = (await tx.execute(
    sql`insert into processed_messages (key) values (${key}) on conflict (key) do nothing returning key`,
  )) as unknown as unknown[];
  return r.length === 1;
}

export interface CostAllocation {
  runId: string;
  tenantId: string;
  costUnits: number;
  requests: number;
  results: number;
  matches: number;
  basis: "matches" | "even_split";
}

/**
 * I-25 (P-20): biaya aktual run stream (jumlah usage semua attempt) dialokasikan ke tenant proporsional jumlah match
 * baru; tanpa match → dibagi rata ke tenant anggota stream. Sisa pembulatan ke tenant terakhir → Σ alokasi = biaya run.
 * Idempoten (PK run_id, tenant_id). Dipanggil saat run stream ditutup (sukses/partial/gagal).
 */
export async function allocateStreamRunCost(tx: Tx, runId: string): Promise<CostAllocation[]> {
  const [run] = (await tx.execute(sql`select r.id, r.scheduled_for::text as sf, r.collection_stream_id, r.tenant_matches,
      (select coalesce(sum((a.usage->>'requests')::numeric), 0) from provider_attempts a where a.crawl_run_id = r.id) as requests,
      (select coalesce(sum((a.usage->>'results')::numeric), 0) from provider_attempts a where a.crawl_run_id = r.id) as results,
      (select coalesce(sum((a.usage->>'costUnits')::numeric), 0) from provider_attempts a where a.crawl_run_id = r.id) as cost
    from crawl_runs r where r.id = ${runId}`)) as unknown as {
    id: string;
    sf: string;
    collection_stream_id: string | null;
    tenant_matches: Record<string, number>;
    requests: string;
    results: string;
    cost: string;
  }[];
  if (!run?.collection_stream_id) return [];
  const total = { cost: Number(run.cost), requests: Number(run.requests), results: Number(run.results) };
  let weights = Object.entries(run.tenant_matches ?? {})
    .filter(([, n]) => Number(n) > 0)
    .map(([t, n]) => [t, Number(n)] as [string, number]);
  let basis: CostAllocation["basis"] = "matches";
  if (!weights.length) {
    const members = (await tx.execute(
      sql`select distinct tenant_id from stream_topic_links where stream_id = ${run.collection_stream_id}`,
    )) as unknown as {
      tenant_id: string;
    }[];
    weights = members.map((m) => [m.tenant_id, 1]);
    basis = "even_split";
  }
  if (!weights.length) return [];
  weights.sort(([a], [b]) => a.localeCompare(b));
  const sum = weights.reduce((a, [, n]) => a + n, 0);
  const round = (v: number) => Math.round(v * 1e9) / 1e9;
  const acc = { cost: 0, requests: 0, results: 0 };
  const out: CostAllocation[] = weights.map(([tenantId, n], i) => {
    const last = i === weights.length - 1;
    const share = (k: keyof typeof total) => (last ? round(total[k] - acc[k]) : round((total[k] * n) / sum));
    const a = { costUnits: share("cost"), requests: share("requests"), results: share("results") };
    acc.cost += a.costUnits;
    acc.requests += a.requests;
    acc.results += a.results;
    return { runId: run.id, tenantId, matches: basis === "matches" ? n : 0, basis, ...a };
  });
  for (const a of out) {
    await tx.execute(sql`insert into cost_allocations (run_id, run_scheduled_for, tenant_id, cost_units, requests, results, matches, basis)
      values (${a.runId}, ${run.sf}::timestamptz, ${a.tenantId}, ${a.costUnits}, ${a.requests}, ${a.results}, ${a.matches}, ${a.basis})
      on conflict (run_id, tenant_id) do nothing`);
  }
  return out;
}

/** Tambah jumlah match per tenant pada run stream (pipeline, bisa beberapa bagian/attempt). */
export async function addTenantMatches(tx: Tx, runId: string, counts: Record<string, number>): Promise<void> {
  if (!Object.keys(counts).length) return;
  await tx.execute(sql`update crawl_runs set tenant_matches = (
      select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from (
        select k, sum(v)::int as v from (
          select key as k, value::int as v from jsonb_each_text(tenant_matches)
          union all select key, value::int from jsonb_each_text(${JSON.stringify(counts)}::text::jsonb)) x group by k) y)
    where id = ${runId}`);
}

/** Alokasi yang belum diterapkan ke counter quota tenant (Redis). `apply` harus idempoten per (run, tenant). */
export async function applyCostAllocations(
  db: Db,
  apply: (a: { runId: string; tenantId: string; requests: number; results: number; costUnits: number }) => Promise<void>,
  limit = 200,
): Promise<number> {
  return withSystem(db, async (tx) => {
    const rows = (await tx.execute(sql`select run_id, tenant_id, requests, results, cost_units from cost_allocations
      where applied_at is null order by created_at limit ${limit} for update skip locked`)) as unknown as {
      run_id: string;
      tenant_id: string;
      requests: string;
      results: string;
      cost_units: string;
    }[];
    for (const r of rows) {
      await apply({
        runId: r.run_id,
        tenantId: r.tenant_id,
        requests: Number(r.requests),
        results: Number(r.results),
        costUnits: Number(r.cost_units),
      });
      await tx.execute(sql`update cost_allocations set applied_at = now() where run_id = ${r.run_id} and tenant_id = ${r.tenant_id}`);
    }
    return rows.length;
  });
}
