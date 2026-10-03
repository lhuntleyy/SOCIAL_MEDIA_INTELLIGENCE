// I-03: Topic CRUD + validate/preview/cost-estimate + SyncCrawlPlans (API_SPEC §4, DATA_MODEL §3, FR-T01..T07).
// Semua akses data tenant lewat withTenant (RLS). Quota tenant dibaca sebagai system (quota_policies tidak di-grant ke app)
// dengan filter tenant eksplisit.

import type { QueryFeature } from "@smip/contracts";
import type { TenantId } from "@smip/core";
import {
  auditLogs,
  BACKFILL_PRIORITY,
  createCrawlRun,
  type Db,
  inList,
  type PlanForRun,
  readSettings,
  type Tx,
  textArray,
  withSystem,
  withTenant,
  writeOutbox,
} from "@smip/db";
import {
  astHash,
  type CompiledQuery,
  compileQuery,
  coverSet,
  matchQuery,
  normalizeTag,
  positiveLeaves,
  QueryError,
  stringify,
} from "@smip/query";
import { sql } from "drizzle-orm";
import { ApiError } from "../errors";
import { type ConnectorRates, type CostEstimate, clampInterval, estimateCost } from "./estimate";

export interface QueryBody {
  id?: string;
  kind: "main" | "sub";
  label?: string | null;
  query_text?: string | null;
  keywords?: string[];
  languages?: string[] | null;
  media_tags?: string[];
  not_media_tags?: string[];
  platforms?: string[] | null;
  enabled?: boolean;
}
export interface PlatformBody {
  code: string;
  interval_sec?: number;
  operations?: string[];
  enabled?: boolean;
}
export interface TopicBody {
  kind?: "topic" | "account";
  name: string;
  description?: string | null;
  platforms: PlatformBody[];
  taxonomy_type?: "interest" | "industry";
  taxonomy_ids?: string[];
  filter_ads?: boolean;
  language_hints?: string[];
  default_interval_sec?: number;
  queries: QueryBody[];
}
export type TopicPatch = Partial<TopicBody>;

export interface Actor {
  userId: string;
  tenantId: string;
  ip?: string;
  ua?: string;
  requestId?: string;
}

/** Port preview (ClickHouse). Dipisah agar API bisa jalan/tes tanpa CH. */
export type Previewer = (q: { platforms: string[]; needles: string[]; hashtags: string[] }) => Promise<{
  counts: Record<string, number>;
  sample: { platform: string; post_id: string; text: string; lang: string; hashtags: string[]; published_at: string }[];
}>;

type Row = Record<string, unknown>;
const rows = async <T = Row>(tx: Tx, q: ReturnType<typeof sql>) => (await tx.execute(q)) as unknown as T[];
const PREVIEW_DAYS = 7;
/** Batas rentang backfill manual per permintaan (biaya; COST_MODEL §8). */
export const MAX_BACKFILL_DAYS = 31;

function pgCode(e: unknown): string | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur; i++) {
    const c = cur as { code?: string; errno?: string; cause?: unknown };
    if (typeof c.errno === "string" && /^[0-9A-Z]{5}$/.test(c.errno)) return c.errno;
    if (typeof c.code === "string" && /^[0-9A-Z]{5}$/.test(c.code)) return c.code;
    cur = c.cause;
  }
  return undefined;
}

/** Kompilasi semua query; error → 400 INVALID_QUERY berpath (posisi karakter dari parser). */
export function compileAll(queries: QueryBody[]): CompiledQuery[] {
  const mains = queries.filter((q) => q.kind === "main").length;
  if (mains !== 1)
    throw new ApiError("VALIDATION_FAILED", "Topik wajib punya tepat satu main query", [
      { path: "queries", issue: `main query: ${mains}` },
    ]);
  return queries.map((q, i) => {
    try {
      return compileQuery(q);
    } catch (e) {
      if (e instanceof QueryError) {
        throw new ApiError("INVALID_QUERY", "Query tidak valid", [
          { path: `queries[${i}].query_text`, issue: e.position ? `${e.message} (posisi ${e.position})` : e.message },
        ]);
      }
      throw e;
    }
  });
}

function leafNeedles(c: CompiledQuery): { needles: string[]; hashtags: string[] } {
  const { version: _v, ...ast } = c.ast;
  const cover = coverSet(ast);
  if (!cover) throw new ApiError("INVALID_QUERY", "Query tidak punya term positif untuk dicari (mis. hanya NOT)");
  return {
    needles: cover.map((l) => l.value.replace(/^#/, "")),
    hashtags: cover.filter((l) => l.value.startsWith("#")).map((l) => normalizeTag(l.value)),
  };
}

export class TopicService {
  constructor(
    private readonly db: Db,
    private readonly opts: { previewer?: Previewer; now?: () => Date } = {},
  ) {}

  private tenant<T>(a: Pick<Actor, "tenantId">, fn: (tx: Tx) => Promise<T>) {
    return withTenant(this.db, a.tenantId as TenantId, fn);
  }

  private async audit(tx: Tx, a: Actor, action: string, id: string, after?: unknown) {
    await tx.insert(auditLogs).values({
      id: Bun.randomUUIDv7(),
      tenantId: a.tenantId,
      actorType: "user",
      actorId: a.userId,
      action,
      targetType: "topic",
      targetId: id,
      after: after ?? null,
      ip: a.ip ?? null,
      userAgent: a.ua ?? null,
      requestId: a.requestId ?? null,
    });
  }

  // ---------- validate / preview / estimate ----------
  validateQuery(q: QueryBody) {
    const [c] = compileAll([{ ...q, kind: "main" }]);
    const { version: _v, ...ast } = c!.ast;
    return {
      valid: true,
      ast: c!.ast,
      positive_terms: [...new Set(positiveLeaves(ast).map((l) => l.value))],
      languages: c!.languages,
      normalized: stringify(ast),
    };
  }

  async preview(b: { platforms: string[]; queries: QueryBody[] }) {
    const compiled = compileAll(b.queries);
    if (!this.opts.previewer) throw new ApiError("UNAVAILABLE", "Preview belum tersedia (analytics tidak terhubung)");
    const needles = new Set<string>();
    const hashtags = new Set<string>();
    for (const c of compiled) {
      const n = leafNeedles(c);
      for (const x of n.needles) needles.add(x);
      for (const x of n.hashtags) hashtags.add(x);
    }
    const { counts, sample } = await this.opts.previewer({ platforms: b.platforms, needles: [...needles], hashtags: [...hashtags] });
    const seen: Record<string, number> = {};
    const hit: Record<string, number> = {};
    const matched: typeof sample = [];
    for (const it of sample) {
      seen[it.platform] = (seen[it.platform] ?? 0) + 1;
      const item = { text: it.text, hashtags: it.hashtags, lang: it.lang || null };
      // item cocok topik bila cocok salah satu query (main atau sub) — sama dengan worker-pipeline
      if (compiled.some((c) => matchQuery(c, item).match)) {
        hit[it.platform] = (hit[it.platform] ?? 0) + 1;
        matched.push(it);
      }
    }
    const perDay = Object.fromEntries(
      b.platforms.map((p) => [p, seen[p] ? Math.round(((counts[p] ?? 0) * (hit[p] ?? 0)) / seen[p]! / PREVIEW_DAYS) : 0]),
    );
    return {
      sample: matched.slice(0, 20).map((m) => ({ platform: m.platform, post_id: m.post_id, text: m.text, published_at: m.published_at })),
      estimated_matches_per_day: perDay,
      note: "Estimasi dari data yang sudah terindeks; volume nyata bisa berbeda.",
    };
  }

  /** Connector utama (priority terkecil, weight terbesar) + floor interval per (platform, operation). */
  private async connectorView(tx: Tx, platforms: string[]) {
    const list = await rows<{
      platform_code: string;
      operation: string;
      declared: Record<string, unknown>;
      measured: Record<string, unknown>;
    }>(
      tx,
      sql`
      with pol as (
        select distinct on (platform_code, operation) id, platform_code, operation, allow_unverified
        from routing_policies where enabled and platform_code in ${inList(platforms)}
        order by platform_code, operation, (tenant_id is null)
      )
      select pol.platform_code, pol.operation, cc.declared, cc.measured
      from pol
      join routing_rules r on r.policy_id = pol.id and r.enabled and r.weight > 0
      join connectors c on c.id = r.connector_id and c.enabled
      join providers p on p.id = c.provider_id and p.enabled
      join connector_capabilities cc on cc.connector_id = c.id and cc.operation = pol.operation
      where cc.status = 'verified' or (pol.allow_unverified and cc.status = 'declared')
      order by r.priority, r.weight desc`,
    );
    const view = new Map<string, { primary: ConnectorRates; minInterval?: number }>();
    for (const r of list) {
      const k = `${r.platform_code}|${r.operation}`;
      const m = r.measured ?? {};
      const num = (v: unknown) => (typeof v === "number" ? v : v === undefined || v === null ? undefined : Number(v));
      const minI = num(m.min_interval_sec);
      const cur = view.get(k);
      if (!cur) {
        view.set(k, {
          primary: {
            queryFeatures: ((r.declared?.query_features as QueryFeature[]) ?? ["term"]) as QueryFeature[],
            maxQueryLength: num(r.declared?.max_query_length) ?? null,
            avgPages: num(m.avg_pages),
            costPer1kResults: num(m.cost_per_1k_results),
            minCostPerRequest: num(m.min_cost_per_request),
            fixedCostPerRun: num(m.fixed_cost_per_run),
            minIntervalSec: minI,
          },
          minInterval: minI,
        });
      } else if (minI === undefined || (cur.minInterval !== undefined && minI < cur.minInterval)) {
        // cukup SATU connector yang sanggup interval rapat → floor = minimum antar connector
        cur.minInterval = minI;
      }
    }
    return view;
  }

  /** Interval crawl bawaan bila topik/platform tidak menyebut interval (UI tidak lagi menampilkan interval — diatur sistem). */
  static readonly DEFAULT_INTERVAL_SEC = 3600;

  private async planLimits(
    tx: Tx,
  ): Promise<{ max_topics?: number; min_interval_sec?: number; default_interval_sec?: number; initial_backfill_days?: number }> {
    const [r] = await rows<{ limits: Record<string, number> | null }>(
      tx,
      sql`select p.limits from tenants t left join plans p on p.id = t.plan_id where t.id = smip_current_tenant()`,
    );
    return r?.limits ?? {};
  }

  /** Interval efektif per platform + warning INTERVAL_CLAMPED / NO_ACTIVE_CONNECTOR. */
  private resolvePlatforms(
    platforms: PlatformBody[],
    defaultInterval: number,
    view: Map<string, { primary: ConnectorRates; minInterval?: number }>,
    planMin?: number,
    platformInterval?: Map<string, number>,
  ) {
    const warnings: { code: string; platform: string; reason: string }[] = [];
    const out = platforms.map((p) => {
      const ops = p.operations?.length ? [...new Set(p.operations)] : ["search_keyword"];
      // interval platform dari Pengaturan (owner) menang atas bawaan topik; interval eksplisit per topik tetap dihormati
      const requested = p.interval_sec ?? platformInterval?.get(p.code) ?? defaultInterval;
      const floors = ops.map((op) => view.get(`${p.code}|${op}`)?.minInterval);
      if (ops.every((op) => !view.has(`${p.code}|${op}`))) {
        warnings.push({ code: "NO_ACTIVE_CONNECTOR", platform: p.code, reason: "belum ada connector verified pada routing policy" });
      }
      const { effective, clamped } = clampInterval(requested, [planMin, ...floors]);
      if (clamped) {
        const byPlan = planMin !== undefined && planMin > requested && !floors.some((f) => f !== undefined && f >= planMin);
        warnings.push({
          code: "INTERVAL_CLAMPED",
          platform: p.code,
          reason: byPlan ? "plan_min_interval" : "min_interval_of_available_connectors",
        });
      }
      return { code: p.code, requested, effective, operations: ops, enabled: p.enabled ?? true };
    });
    return { platforms: out, warnings };
  }

  private async matchesPerDay(platforms: string[], queries: QueryBody[]): Promise<Record<string, number> | null> {
    if (!this.opts.previewer) return null;
    try {
      return (await this.preview({ platforms, queries })).estimated_matches_per_day;
    } catch {
      return null; // CH tidak tersedia → hasil tidak diketahui (bukan 0)
    }
  }

  private async estimate(tx: Tx, a: Actor, b: Pick<TopicBody, "platforms" | "queries" | "default_interval_sec">) {
    const compiled = compileAll(b.queries);
    const codes = b.platforms.map((p) => p.code);
    const view = await this.connectorView(tx, codes);
    const limits = await this.planLimits(tx);
    const dflt = b.default_interval_sec ?? limits.default_interval_sec ?? TopicService.DEFAULT_INTERVAL_SEC;
    const pi = (await tx.execute(sql`select code, crawl_interval_sec from platforms where crawl_interval_sec is not null`)) as unknown as {
      code: string;
      crawl_interval_sec: number;
    }[];
    const resolved = this.resolvePlatforms(
      b.platforms,
      dflt,
      view,
      limits.min_interval_sec,
      new Map(pi.map((r) => [r.code, Number(r.crawl_interval_sec)])),
    );
    const matches = await this.matchesPerDay(codes, b.queries);
    const est = estimateCost(
      resolved.platforms
        .filter((p) => p.enabled)
        .map((p) => ({
          code: p.code,
          intervalSec: p.effective,
          operations: p.operations,
          queries: compiled.filter(
            (_, i) => b.queries[i]!.enabled !== false && (!b.queries[i]!.platforms || b.queries[i]!.platforms!.includes(p.code)),
          ),
        })),
      (pl, op) => view.get(`${pl}|${op}`)?.primary,
      (pl) => (matches ? (matches[pl] ?? 0) : null),
    );
    const quota = await this.quotaImpact(a.tenantId, est);
    return { compiled, resolved, estimate: { ...est, quota_after_pct: quota.pct }, exceeded: quota.exceeded, throttle: quota.throttle };
  }

  /** FR-T05: dampak ke quota tenant; hard terlampaui → ditolak (QUOTA_WOULD_EXCEED); soft → peringatan throttle (I-23). */
  private async quotaImpact(tenantId: string, est: CostEstimate) {
    const now = this.opts.now?.() ?? new Date();
    const policies = await withSystem(this.db, (tx) =>
      rows<{ period: "day" | "month"; unit: string; limit_value: string; hard: boolean; used: string | null }>(
        tx,
        sql`select qp.period, qp.unit, qp.limit_value, qp.hard,
                   (select used from quota_usage u where u.scope_type = 'tenant' and u.scope_id = qp.scope_id and u.period = qp.period and u.unit = qp.unit
                      and u.period_start = case when qp.period = 'day' then (now() at time zone qp.reset_tz)::date else date_trunc('month', now() at time zone qp.reset_tz)::date end) as used
            from quota_policies qp where qp.enabled and qp.scope_type = 'tenant' and qp.scope_id = ${tenantId}`,
      ),
    );
    const pct: Record<string, number> = {};
    const exceeded: string[] = [];
    const throttle: string[] = [];
    const daysLeft = (() => {
      const y = now.getUTCFullYear();
      const m = now.getUTCMonth();
      return new Date(Date.UTC(y, m + 1, 0)).getUTCDate() - now.getUTCDate() + 1;
    })();
    for (const p of policies) {
      const perDay = p.unit === "requests" ? est.requests_per_day : p.unit === "results" ? est.results_per_day : est.usd_per_day;
      if (perDay === null) continue; // tidak diketahui → tidak bisa dinilai (UI memberi label)
      const projected = Number(p.used ?? 0) + perDay * (p.period === "day" ? 1 : daysLeft);
      const limit = Number(p.limit_value);
      const key = `tenant_${p.period === "day" ? "daily" : "monthly"}_${p.unit}`;
      pct[key] = limit > 0 ? Math.round((projected / limit) * 1000) / 10 : 100;
      if (p.hard && projected > limit) exceeded.push(key);
      if (!p.hard && projected > limit) throttle.push(key);
    }
    return { pct, exceeded, throttle };
  }

  async costEstimate(a: Actor, b: Pick<TopicBody, "platforms" | "queries" | "default_interval_sec">) {
    return this.tenant(a, async (tx) => {
      const r = await this.estimate(tx, a, b);
      // would_throttle: soft cap diproyeksikan terlampaui → interval akan di-throttle ke maksimum (bukan stop, COST_MODEL §8)
      return { ...r.estimate, warnings: r.resolved.warnings, would_exceed: r.exceeded, would_throttle: r.throttle };
    });
  }

  // ---------- CRUD ----------
  /** API_SPEC §3 `GET /platforms`: registry platform aktif + interval minimum plan tenant (UI tidak hardcode). */
  async platforms(a: Actor) {
    return this.tenant(a, async (tx) => {
      const limits = await this.planLimits(tx);
      const list = await rows<{ code: string; name: string; icon: string | null }>(
        tx,
        sql`select code, name, icon from platforms where enabled order by sort_order, code`,
      );
      // operation yang benar-benar bisa dilayani: policy aktif + rule aktif + connector aktif dengan capability verified
      const ops = await rows<{ platform_code: string; operation: string }>(
        tx,
        sql`select distinct rp.platform_code, rp.operation from routing_policies rp
            join routing_rules rr on rr.policy_id = rp.id and rr.enabled
            join connectors c on c.id = rr.connector_id and c.enabled
            join connector_capabilities cc on cc.connector_id = c.id and cc.operation = rp.operation and cc.status = 'verified'
            where rp.enabled`,
      );
      return list.map((p) => ({
        ...p,
        enabled: true,
        min_interval_sec: limits.min_interval_sec,
        operations_available: ops.filter((o) => o.platform_code === p.code).map((o) => o.operation),
      }));
    });
  }

  async list(a: Actor, q: { search?: string; status?: string; type?: string; kind?: string; sort: string; limit: number; offset: number }) {
    return this.tenant(a, async (tx) => {
      const [col, dir] = q.sort.split(":") as [string, string];
      const order = sql.raw(`${col === "name" ? "lower(t.name)" : `t.${col}`} ${dir === "desc" ? "desc" : "asc"}, t.id`);
      const where = sql`t.deleted_at is null
        ${q.status ? sql`and t.status = ${q.status}::e_topic_status` : sql``}
        ${q.kind ? sql`and t.kind = ${q.kind}` : sql``}
        ${q.search ? sql`and t.name ilike ${`%${q.search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`}` : sql``}
        ${q.type ? sql`and exists (select 1 from topic_taxonomies tt join taxonomies x on x.id = tt.taxonomy_id where tt.topic_id = t.id and x.type = ${q.type}::e_taxonomy_type)` : sql``}`;
      const items = await rows<Row>(
        tx,
        sql`select t.id, t.kind, t.name, t.description, t.status, t.version, t.created_at, t.updated_at,
                   (select coalesce(array_agg(tp.platform_code order by tp.platform_code), '{}') from topic_platforms tp where tp.topic_id = t.id and tp.enabled) as platforms,
                   u.id as author_id, u.name as author_name
            from topics t left join users u on u.id = t.author_user_id
            where ${where} order by ${order} limit ${q.limit} offset ${q.offset}`,
      );
      const [{ n } = { n: "0" }] = await rows<{ n: string }>(tx, sql`select count(*) as n from topics t where ${where}`);
      return { items: items.map((r) => this.summary(r)), total: Number(n) };
    });
  }

  private summary(r: Row) {
    return {
      id: r.id,
      kind: r.kind,
      name: r.name,
      description: r.description,
      status: r.status,
      platforms: r.platforms,
      author: r.author_id ? { id: r.author_id, name: r.author_name } : null,
      version: r.version,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }

  async get(a: Actor, id: string) {
    return this.tenant(a, (tx) => this.load(tx, id));
  }

  private async load(tx: Tx, id: string) {
    const [t] = await rows<Row>(
      tx,
      sql`select t.*, u.name as author_name from topics t left join users u on u.id = t.author_user_id where t.id = ${id} and t.deleted_at is null`,
    );
    if (!t) throw new ApiError("NOT_FOUND", "Topik tidak ditemukan");
    const platforms = await rows<Row>(
      tx,
      sql`select tp.platform_code as code, tp.interval_sec, tp.enabled, tp.operations,
                 (select max(cp.interval_sec) from crawl_plans cp where cp.topic_id = tp.topic_id and cp.platform_code = tp.platform_code and cp.status <> 'disabled') as effective_interval_sec
          from topic_platforms tp where tp.topic_id = ${id} order by tp.platform_code`,
    );
    const queries = await rows<Row>(
      tx,
      sql`select id, kind, label, query_text, keywords, languages, media_tags, not_media_tags, platforms, enabled, (query_ast->>'version')::int as ast_version
          from topic_queries where topic_id = ${id} order by (kind = 'sub'), created_at, id`,
    );
    const tax = await rows<{ id: string; type: string }>(
      tx,
      sql`select x.id, x.type from topic_taxonomies tt join taxonomies x on x.id = tt.taxonomy_id where tt.topic_id = ${id} order by x.name`,
    );
    return {
      id: t.id,
      kind: t.kind,
      name: t.name,
      description: t.description,
      status: t.status,
      author: t.author_user_id ? { id: t.author_user_id, name: t.author_name } : null,
      filter_ads: t.filter_ads,
      language_hints: t.language_hints,
      default_interval_sec: t.default_interval_sec,
      taxonomy_type: tax[0]?.type ?? null,
      taxonomy_ids: tax.map((x) => x.id),
      platforms: platforms.map((p) => ({
        code: p.code,
        interval_sec: p.interval_sec ?? t.default_interval_sec,
        effective_interval_sec: p.effective_interval_sec ?? p.interval_sec ?? t.default_interval_sec,
        enabled: p.enabled,
        operations: p.operations,
      })),
      queries,
      version: t.version,
      created_at: t.created_at,
      updated_at: t.updated_at,
    };
  }

  private async checkPlatforms(tx: Tx, codes: string[]) {
    if (new Set(codes).size !== codes.length)
      throw new ApiError("VALIDATION_FAILED", "Platform duplikat", [{ path: "platforms", issue: "duplikat" }]);
    const ok = await rows<{ code: string }>(tx, sql`select code from platforms where enabled and code in ${inList(codes)}`);
    const bad = codes.filter((c) => !ok.some((o) => o.code === c));
    if (bad.length)
      throw new ApiError(
        "VALIDATION_FAILED",
        "Platform tidak dikenal/tidak aktif",
        bad.map((b) => ({ path: "platforms", issue: b })),
      );
  }

  private async setTaxonomies(tx: Tx, a: Actor, topicId: string, type: string | undefined, ids: string[]) {
    await tx.execute(sql`delete from topic_taxonomies where topic_id = ${topicId}`);
    if (!ids.length) return;
    const found = await rows<{ id: string; type: string }>(tx, sql`select id, type from taxonomies where id in ${inList(ids)}`); // RLS: milik tenant atau global
    if (found.length !== new Set(ids).size)
      throw new ApiError("VALIDATION_FAILED", "Taxonomy tidak ditemukan", [{ path: "taxonomy_ids", issue: "tidak dikenal" }]);
    if (type && found.some((f) => f.type !== type))
      throw new ApiError("VALIDATION_FAILED", "Taxonomy tidak sesuai taxonomy_type", [
        { path: "taxonomy_ids", issue: `harus bertipe ${type}` },
      ]);
    for (const f of found) {
      await tx.execute(sql`insert into topic_taxonomies (topic_id, taxonomy_id, tenant_id) values (${topicId}, ${f.id}, ${a.tenantId})`);
    }
  }

  /** Sinkron query: id ada → update, tanpa id → insert, hilang → delete (cascade crawl_plans). */
  private async syncQueries(tx: Tx, a: Actor, topicId: string, queries: QueryBody[], compiled: CompiledQuery[]) {
    const existing = new Set(
      (await rows<{ id: string }>(tx, sql`select id from topic_queries where topic_id = ${topicId}`)).map((r) => r.id),
    );
    const keep: string[] = [];
    for (const [i, q] of queries.entries()) {
      const c = compiled[i]!;
      const hash = await astHash(c);
      const vals = {
        kind: q.kind,
        label: q.label ?? null,
        text: q.query_text?.trim() || "",
        ast: c.ast,
        keywords: q.keywords?.length ? q.keywords : null,
        media: c.mediaTags.length ? c.mediaTags : null,
        notMedia: c.notMediaTags.length ? c.notMediaTags : null,
        langs: c.languages,
        platforms: q.platforms?.length ? q.platforms : null,
        enabled: q.enabled ?? true,
      };
      if (q.id) {
        if (!existing.has(q.id))
          throw new ApiError("VALIDATION_FAILED", "Query bukan milik topik ini", [{ path: `queries[${i}].id`, issue: "tidak dikenal" }]);
        await tx.execute(sql`update topic_queries set kind = ${vals.kind}::e_query_kind, label = ${vals.label}, query_text = ${vals.text}, query_ast = ${vals.ast},
          ast_hash = ${Buffer.from(hash)}, keywords = ${textArray(vals.keywords)}, media_tags = ${textArray(vals.media)}, not_media_tags = ${textArray(vals.notMedia)}, languages = ${textArray(vals.langs)},
          platforms = ${textArray(vals.platforms)}, enabled = ${vals.enabled}, updated_at = now() where id = ${q.id}`);
        keep.push(q.id);
      } else {
        const id = Bun.randomUUIDv7();
        await tx.execute(sql`insert into topic_queries (id, tenant_id, topic_id, kind, label, query_text, query_ast, ast_hash, keywords, media_tags, not_media_tags, languages, platforms, enabled)
          values (${id}, ${a.tenantId}, ${topicId}, ${vals.kind}::e_query_kind, ${vals.label}, ${vals.text}, ${vals.ast}, ${Buffer.from(hash)}, ${textArray(vals.keywords)},
                  ${textArray(vals.media)}, ${textArray(vals.notMedia)}, ${textArray(vals.langs)}, ${textArray(vals.platforms)}, ${vals.enabled})`);
        keep.push(id);
      }
    }
    const drop = [...existing].filter((id) => !keep.includes(id));
    if (drop.length) await tx.execute(sql`delete from topic_queries where id in ${inList(drop)}`);
  }

  private async syncPlatforms(
    tx: Tx,
    a: Actor,
    topicId: string,
    platforms: { code: string; requested: number; operations: string[]; enabled: boolean }[],
  ) {
    await tx.execute(
      sql`delete from topic_platforms where topic_id = ${topicId} ${platforms.length ? sql`and platform_code not in ${inList(platforms.map((p) => p.code))}` : sql``}`,
    );
    for (const p of platforms) {
      await tx.execute(sql`insert into topic_platforms (topic_id, platform_code, tenant_id, enabled, interval_sec, operations)
        values (${topicId}, ${p.code}, ${a.tenantId}, ${p.enabled}, ${p.requested}, ${textArray(p.operations)})
        on conflict (topic_id, platform_code) do update set enabled = excluded.enabled, interval_sec = excluded.interval_sec, operations = excluded.operations`);
    }
  }

  /**
   * SyncCrawlPlans (DATA_MODEL §3.7): satu plan per (query aktif × platform aktif × operation).
   * Kombinasi yang hilang → `disabled` (watermark dipertahankan bila diaktifkan lagi); query terhapus → cascade.
   */
  async syncCrawlPlans(tx: Tx, a: Actor, topicId: string, effective: Map<string, number>) {
    const [t] = await rows<{ status: string }>(tx, sql`select status from topics where id = ${topicId}`);
    const planStatus = t!.status === "active" ? "active" : t!.status === "paused" ? "paused" : "disabled";
    const qs = await rows<{ id: string; platforms: string[] | null }>(
      tx,
      sql`select id, platforms from topic_queries where topic_id = ${topicId} and enabled`,
    );
    const ps = await rows<{ platform_code: string; operations: string[] }>(
      tx,
      sql`select platform_code, operations from topic_platforms where topic_id = ${topicId} and enabled`,
    );
    const keys: string[] = [];
    for (const q of qs) {
      for (const p of ps) {
        if (q.platforms && !q.platforms.includes(p.platform_code)) continue;
        const interval = effective.get(p.platform_code) ?? 900;
        for (const op of p.operations) {
          keys.push(`${q.id}|${p.platform_code}|${op}`);
          await tx.execute(sql`
            insert into crawl_plans (id, tenant_id, topic_id, topic_query_id, platform_code, operation, interval_sec, status, next_run_at, priority)
            values (${Bun.randomUUIDv7()}, ${a.tenantId}, ${topicId}, ${q.id}, ${p.platform_code}, ${op}, ${interval}, ${planStatus}::e_plan_status, now(), ${interval <= 900 ? 0 : 5})
            on conflict (topic_query_id, platform_code, operation) do update set
              interval_sec = excluded.interval_sec,
              priority = excluded.priority,
              status = case when excluded.status = 'active' and crawl_plans.status = 'error_backoff' then crawl_plans.status else excluded.status end,
              next_run_at = case when excluded.status = 'active' and crawl_plans.status in ('paused', 'disabled') then now()
                                 else least(crawl_plans.next_run_at, now() + make_interval(secs => excluded.interval_sec)) end,
              updated_at = now()`);
        }
      }
    }
    await tx.execute(sql`update crawl_plans set status = 'disabled', updated_at = now()
      where topic_id = ${topicId} and status <> 'disabled' ${keys.length ? sql`and (topic_query_id::text || '|' || platform_code || '|' || operation) not in ${inList(keys)}` : sql``}`);
    return keys.length;
  }

  private async assertPlanLimit(tx: Tx) {
    const limits = await this.planLimits(tx);
    if (limits.max_topics === undefined) return;
    const [{ n } = { n: "0" }] = await rows<{ n: string }>(
      tx,
      sql`select count(*) as n from topics where deleted_at is null and status <> 'archived'`,
    );
    if (Number(n) >= limits.max_topics) throw new ApiError("PLAN_LIMIT", `Batas topik paket tercapai (${limits.max_topics})`);
  }

  /**
   * Scrape awal otomatis: topik baru (atau platform yang baru ditambahkan) langsung di-backfill N hari terakhir
   * (`plans.limits.initial_backfill_days`, bawaan 7; 0 = mati) supaya dashboard langsung terisi — pengguna tinggal
   * memilih rentang waktu. Best-effort: gagal backfill tidak menggagalkan simpan topik.
   */
  static readonly INITIAL_BACKFILL_DAYS = 7;
  private async autoBackfill(a: Actor, id: string, platforms?: string[]) {
    if (platforms && !platforms.length) return null;
    try {
      const limits = await this.tenant(a, (tx) => this.planLimits(tx));
      const settings = await withSystem(this.db, readSettings);
      const days = Math.min(MAX_BACKFILL_DAYS, limits.initial_backfill_days ?? settings["topics.initial_backfill_days"]);
      if (days <= 0) return null;
      const to = this.opts.now?.() ?? new Date();
      const from = new Date(to.getTime() - days * 86_400_000);
      const r = await this.backfill(a, id, { from: from.toISOString(), to: to.toISOString(), platforms });
      return { days, runs: r.runs_created };
    } catch {
      return null;
    }
  }

  /**
   * Topik akun (menu Akun): tiap query = satu `@username` untuk satu platform; semua platform memakai operation user_timeline.
   * Validasi di sini agar UI/API tidak bisa membuat topik akun yang memakai pencarian keyword (atau sebaliknya).
   */
  static accountBody<T extends { platforms?: PlatformBody[]; queries?: QueryBody[] }>(b: T): T {
    const queries = (b.queries ?? []).map((q, i) => {
      const t = (q.query_text ?? "").trim();
      if (!/^@[A-Za-z0-9._]{1,64}$/.test(t) || q.platforms?.length !== 1)
        throw new ApiError("VALIDATION_FAILED", "Akun harus berupa @username dengan tepat satu platform", [
          { path: `queries[${i}]`, issue: "format @username + platforms[1]" },
        ]);
      return { ...q, query_text: t.toLowerCase(), keywords: [], media_tags: [], not_media_tags: [], languages: null };
    });
    const used = new Set(queries.map((q) => q.platforms![0]!));
    const platforms = (b.platforms ?? []).filter((p) => used.has(p.code)).map((p) => ({ ...p, operations: ["user_timeline"] }));
    for (const code of used)
      if (!platforms.some((p) => p.code === code)) platforms.push({ code, operations: ["user_timeline"], enabled: true });
    return { ...b, ...(b.platforms || b.queries ? { platforms } : {}), ...(b.queries ? { queries } : {}) };
  }

  async create(a: Actor, b: TopicBody) {
    if (b.kind === "account") b = TopicService.accountBody(b);
    const out = await this.createTx(a, b);
    return { ...out, initial_backfill: await this.autoBackfill(a, String(out.id)) };
  }

  private async createTx(a: Actor, b: TopicBody) {
    return this.tenant(a, async (tx) => {
      await this.checkPlatforms(
        tx,
        b.platforms.map((p) => p.code),
      );
      await this.assertPlanLimit(tx);
      const dflt = b.default_interval_sec ?? (await this.planLimits(tx)).default_interval_sec ?? TopicService.DEFAULT_INTERVAL_SEC;
      const est = await this.estimate(tx, a, { ...b, default_interval_sec: dflt });
      if (est.exceeded.length) {
        throw new ApiError(
          "QUOTA_WOULD_EXCEED",
          "Estimasi melebihi hard quota tenant",
          est.exceeded.map((k) => ({ path: "cost_estimate", issue: k })),
        );
      }
      const id = Bun.randomUUIDv7();
      try {
        await tx.execute(sql`insert into topics (id, tenant_id, kind, name, description, author_user_id, filter_ads, language_hints, default_interval_sec)
          values (${id}, ${a.tenantId}, ${b.kind ?? "topic"}, ${b.name.trim()}, ${b.description ?? null}, ${a.userId}, ${b.filter_ads ?? false}, ${textArray(b.language_hints ?? ["id"])}, ${dflt})`);
      } catch (e) {
        if (pgCode(e) === "23505") throw new ApiError("CONFLICT", "Nama topik sudah dipakai");
        throw e;
      }
      await this.setTaxonomies(tx, a, id, b.taxonomy_type, b.taxonomy_ids ?? []);
      await this.syncQueries(tx, a, id, b.queries, est.compiled);
      await this.syncPlatforms(tx, a, id, est.resolved.platforms);
      const plans = await this.syncCrawlPlans(tx, a, id, new Map(est.resolved.platforms.map((p) => [p.code, p.effective])));
      await writeOutbox(tx, { aggregate: "topic", aggregateId: id, eventType: "topic.created", payload: { plans } });
      await this.audit(tx, a, "topic.create", id, { name: b.name, platforms: b.platforms.map((p) => p.code), queries: b.queries.length });
      return { ...(await this.load(tx, id)), cost_estimate: est.estimate, warnings: est.resolved.warnings };
    });
  }

  private async lockVersion(tx: Tx, id: string, ifMatch: number | undefined) {
    const [t] = await rows<{ version: number; status: string }>(
      tx,
      sql`select version, status from topics where id = ${id} and deleted_at is null for update`,
    );
    if (!t) throw new ApiError("NOT_FOUND", "Topik tidak ditemukan");
    if (ifMatch !== undefined && t.version !== ifMatch) throw new ApiError("VERSION_MISMATCH", `Versi berubah (sekarang ${t.version})`);
    return t;
  }

  async update(a: Actor, id: string, b: TopicPatch, ifMatch?: number) {
    let before: string[] = [];
    const out = await this.updateTx(a, id, b, ifMatch, (p) => {
      before = p;
    });
    const added = (out.platforms as { code: string; enabled: boolean }[])
      .filter((p) => p.enabled && !before.includes(p.code))
      .map((p) => p.code);
    return { ...out, initial_backfill: added.length ? await this.autoBackfill(a, id, added) : null };
  }

  private async updateTx(a: Actor, id: string, b: TopicPatch, ifMatch: number | undefined, seen: (enabled: string[]) => void) {
    return this.tenant(a, async (tx) => {
      const cur = await this.lockVersion(tx, id, ifMatch);
      if (cur.status === "archived") throw new ApiError("CONFLICT", "Topik sudah diarsipkan");
      const existing = await this.load(tx, id);
      if (b.kind && b.kind !== existing.kind)
        throw new ApiError("VALIDATION_FAILED", "Jenis topik (topik/akun) tidak bisa diubah", [{ path: "kind", issue: "tetap" }]);
      if (existing.kind === "account" && (b.platforms || b.queries)) {
        const cur = existing.platforms.map((p) => ({
          code: String(p.code),
          interval_sec: Number(p.interval_sec),
          enabled: Boolean(p.enabled),
        }));
        b = TopicService.accountBody({
          ...b,
          platforms: b.platforms ?? cur,
          queries: b.queries ?? (existing.queries as unknown as QueryBody[]),
        });
      }
      seen((existing.platforms as { code: string; enabled: boolean }[]).filter((p) => p.enabled).map((p) => String(p.code)));
      const platforms: PlatformBody[] =
        b.platforms ??
        existing.platforms.map((p) => ({
          code: String(p.code),
          interval_sec: Number(p.interval_sec),
          operations: p.operations as string[],
          enabled: Boolean(p.enabled),
        }));
      const queries: QueryBody[] =
        b.queries ??
        (existing.queries as Row[]).map((q) => ({
          id: String(q.id),
          kind: q.kind as "main" | "sub",
          label: q.label as string | null,
          query_text: q.query_text as string,
          keywords: (q.keywords as string[] | null) ?? [],
          languages: q.languages as string[] | null,
          media_tags: (q.media_tags as string[] | null) ?? [],
          not_media_tags: (q.not_media_tags as string[] | null) ?? [],
          platforms: q.platforms as string[] | null,
          enabled: Boolean(q.enabled),
        }));
      if (b.platforms)
        await this.checkPlatforms(
          tx,
          platforms.map((p) => p.code),
        );
      const est = await this.estimate(tx, a, {
        platforms,
        queries,
        default_interval_sec: b.default_interval_sec ?? Number(existing.default_interval_sec),
      });
      if ((b.platforms || b.queries) && est.exceeded.length) {
        throw new ApiError(
          "QUOTA_WOULD_EXCEED",
          "Estimasi melebihi hard quota tenant",
          est.exceeded.map((k) => ({ path: "cost_estimate", issue: k })),
        );
      }
      try {
        await tx.execute(sql`update topics set
          name = coalesce(${b.name?.trim() ?? null}, name),
          description = ${b.description === undefined ? sql`description` : b.description},
          filter_ads = coalesce(${b.filter_ads ?? null}, filter_ads),
          language_hints = coalesce(${textArray(b.language_hints)}, language_hints),
          default_interval_sec = coalesce(${b.default_interval_sec ?? null}, default_interval_sec),
          version = version + 1, updated_at = now()
          where id = ${id}`);
      } catch (e) {
        if (pgCode(e) === "23505") throw new ApiError("CONFLICT", "Nama topik sudah dipakai");
        throw e;
      }
      if (b.taxonomy_ids) await this.setTaxonomies(tx, a, id, b.taxonomy_type, b.taxonomy_ids);
      if (b.queries) await this.syncQueries(tx, a, id, queries, est.compiled);
      await this.syncPlatforms(tx, a, id, est.resolved.platforms);
      const plans = await this.syncCrawlPlans(tx, a, id, new Map(est.resolved.platforms.map((p) => [p.code, p.effective])));
      await writeOutbox(tx, { aggregate: "topic", aggregateId: id, eventType: "topic.updated", payload: { plans } });
      await this.audit(tx, a, "topic.update", id, { fields: Object.keys(b) });
      return { ...(await this.load(tx, id)), cost_estimate: est.estimate, warnings: est.resolved.warnings };
    });
  }

  async setStatus(a: Actor, id: string, status: "active" | "paused" | "archived", ifMatch?: number) {
    return this.tenant(a, async (tx) => {
      const cur = await this.lockVersion(tx, id, ifMatch);
      if (cur.status === "archived") throw new ApiError("CONFLICT", "Topik sudah diarsipkan");
      await tx.execute(sql`update topics set status = ${status}::e_topic_status, version = version + 1, updated_at = now(),
        deleted_at = ${status === "archived" ? sql`now()` : sql`null`} where id = ${id}`);
      if (status === "archived")
        await tx.execute(sql`update crawl_plans set status = 'disabled', updated_at = now() where topic_id = ${id}`);
      else if (status === "paused")
        await tx.execute(
          sql`update crawl_plans set status = 'paused', updated_at = now() where topic_id = ${id} and status in ('active', 'error_backoff')`,
        );
      else
        await tx.execute(
          sql`update crawl_plans set status = 'active', next_run_at = now(), updated_at = now() where topic_id = ${id} and status = 'paused'`,
        );
      await writeOutbox(tx, { aggregate: "topic", aggregateId: id, eventType: `topic.${status}` });
      await this.audit(tx, a, `topic.${status === "active" ? "resume" : status === "paused" ? "pause" : "archive"}`, id);
      return status === "archived" ? { id, status } : this.load(tx, id);
    });
  }

  // ---------- backfill & riwayat run (API_SPEC §4) ----------
  /**
   * Backfill manual (FR-T06): satu run `backfill` per plan aktif per hari dalam [from, to] — prioritas queue terendah.
   * Kepemilikan dicek dengan filter tenant eksplisit (insert crawl_runs butuh role system).
   */
  async backfill(a: Actor, id: string, b: { from: string; to: string; platforms?: string[] }) {
    const from = new Date(b.from);
    const to = new Date(b.to);
    const now = this.opts.now?.() ?? new Date();
    const DAY = 86_400_000;
    if (!(from < to))
      throw new ApiError("VALIDATION_FAILED", "`from` harus sebelum `to`", [{ path: "from", issue: "rentang tidak valid" }]);
    if (to.getTime() > now.getTime())
      throw new ApiError("VALIDATION_FAILED", "`to` tidak boleh di masa depan", [{ path: "to", issue: "masa depan" }]);
    if (to.getTime() - from.getTime() > MAX_BACKFILL_DAYS * DAY) {
      throw new ApiError("VALIDATION_FAILED", `Rentang backfill maksimal ${MAX_BACKFILL_DAYS} hari`, [
        { path: "to", issue: "terlalu panjang" },
      ]);
    }
    const backfillId = Bun.randomUUIDv7();
    const created = await withSystem(this.db, async (tx) => {
      const [t] = await rows<{ status: string }>(
        tx,
        sql`select status from topics where id = ${id} and tenant_id = ${a.tenantId} and deleted_at is null`,
      );
      if (!t) throw new ApiError("NOT_FOUND", "Topik tidak ditemukan");
      if (t.status !== "active") throw new ApiError("CONFLICT", "Topik tidak aktif");
      const plans = await rows<PlanForRun>(
        tx,
        sql`select id, tenant_id, topic_id, topic_query_id, platform_code, operation, interval_sec from crawl_plans
            where topic_id = ${id} and tenant_id = ${a.tenantId} and status in ('active', 'error_backoff')
            ${b.platforms?.length ? sql`and platform_code in ${inList(b.platforms)}` : sql``}`,
      );
      if (!plans.length)
        throw new ApiError("VALIDATION_FAILED", "Tidak ada crawl plan aktif untuk platform tersebut", [
          { path: "platforms", issue: "kosong" },
        ]);
      let n = 0;
      // pantau akun (user_timeline): satu run untuk seluruh rentang — profil yang sama tak perlu diambil ulang per hari
      for (const p of plans.filter((x) => x.operation === "user_timeline")) {
        await createCrawlRun(tx, p, "backfill", { since: from, until: to }, now, BACKFILL_PRIORITY);
        n++;
      }
      const daily = plans.filter((x) => x.operation !== "user_timeline");
      for (let since = from.getTime(); daily.length && since < to.getTime(); since += DAY) {
        const until = new Date(Math.min(since + DAY, to.getTime()));
        for (const p of daily) {
          await createCrawlRun(tx, p, "backfill", { since: new Date(since), until }, now, BACKFILL_PRIORITY);
          n++;
        }
      }
      await tx.insert(auditLogs).values({
        id: Bun.randomUUIDv7(),
        tenantId: a.tenantId,
        actorType: "user",
        actorId: a.userId,
        action: "topic.backfill",
        targetType: "topic",
        targetId: id,
        after: { backfill_id: backfillId, from: b.from, to: b.to, platforms: b.platforms ?? null, runs: n },
        ip: a.ip ?? null,
        userAgent: a.ua ?? null,
        requestId: a.requestId ?? null,
      });
      return n;
    });
    return { backfill_id: backfillId, runs_created: created, status: "queued" };
  }

  async runs(a: Actor, id: string, q: { platform?: string; status?: string; limit: number }) {
    const own = await this.tenant(a, async (tx) => {
      const [t] = await rows(tx, sql`select 1 from topics where id = ${id}`);
      if (!t) throw new ApiError("NOT_FOUND", "Topik tidak ditemukan");
      return rows<Row>(
        tx,
        sql`select r.id, 'plan' as source, p.platform_code as platform, p.operation, r.kind, r.status, r.scheduled_for, r.started_at, r.finished_at,
                   r.items_fetched, r.items_matched, r.items_new, r.error_code, null::numeric as cost_units
            from crawl_runs r join crawl_plans p on p.id = r.crawl_plan_id
            where p.topic_id = ${id}
              ${q.platform ? sql`and p.platform_code = ${q.platform}` : sql``}
              ${q.status ? sql`and r.status = ${q.status}::e_run_status` : sql``}
              and r.scheduled_for > now() - interval '90 days'
            order by r.scheduled_for desc, r.id desc limit ${q.limit}`,
      );
    });
    // run collection stream (I-22/I-25) yang melayani query topik ini: system-owned (tenant_id NULL → tak lolos RLS)
    // → dibaca sebagai sistem SETELAH kepemilikan topik terverifikasi di atas; biaya = porsi tenant (cost_allocations)
    const stream = await withSystem(this.db, (tx) =>
      rows<Row>(
        tx,
        sql`select r.id, 'stream' as source, s.platform_code as platform, s.operation, r.kind, r.status, r.scheduled_for, r.started_at, r.finished_at,
                   r.items_fetched, coalesce((r.tenant_matches->>${a.tenantId})::int, 0) as items_matched, r.items_new, r.error_code,
                   (select ca.cost_units from cost_allocations ca where ca.run_id = r.id and ca.tenant_id = ${a.tenantId}) as cost_units
            from crawl_runs r join collection_streams s on s.id = r.collection_stream_id
            where r.collection_stream_id in (select l.stream_id from stream_topic_links l join topic_queries tq on tq.id = l.topic_query_id
                                             where tq.topic_id = ${id} and tq.tenant_id = ${a.tenantId})
              ${q.platform ? sql`and s.platform_code = ${q.platform}` : sql``}
              ${q.status ? sql`and r.status = ${q.status}::e_run_status` : sql``}
              and r.scheduled_for > now() - interval '90 days'
            order by r.scheduled_for desc, r.id desc limit ${q.limit}`,
      ),
    );
    const runs = [...own, ...stream]
      .sort((x, y) => new Date(String(y.scheduled_for)).getTime() - new Date(String(x.scheduled_for)).getTime())
      .slice(0, q.limit);
    const ids = runs.map((r) => String(r.id));
    const attempts = ids.length
      ? await withSystem(this.db, (tx) =>
          rows<Row>(
            tx,
            sql`select a.crawl_run_id, a.attempt_no as no, c.key as connector, a.outcome, a.error_code, a.duration_ms
                from provider_attempts a join connectors c on c.id = a.connector_id
                where a.crawl_run_id in ${inList(ids)} order by a.attempt_no`,
          ),
        )
      : [];
    return runs.map((r) => ({
      ...r,
      cost_units: r.cost_units === null || r.cost_units === undefined ? null : Number(r.cost_units),
      attempts: attempts.filter((x) => x.crawl_run_id === r.id).map(({ crawl_run_id: _c, ...x }) => x),
    }));
  }
}
