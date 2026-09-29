// I-22 dedup planner collection stream (ADR-009 + amandemen, ARCHITECTURE §12, DATA_MODEL §3.11).
//   1. query aktif → set penutup (coverSet) term ter-normalisasi
//   2. per (platform, operation, visibility): kelas interval dari cepat → lambat; query yang term-nya sudah tercakup
//      stream lebih cepat cukup MENUMPANG (topic 1 jam tidak memicu fetch 5 menit sendiri)
//   3. sisa query per kelas → komponen terhubung via term bersama; komponen ≥ 2 query = satu stream
//   4. visibility: tenant ber-akun BYO → stream privat tenant itu (R-13/R-15); lainnya → stream shared pool
// Rekonsiliasi idempoten: stream_key = hash(platform, operation, kelas, visibility, term) — term berubah = stream baru.
// Watermark: stream baru mulai dari watermark TERENDAH anggota; stream dilepas → plan anggota mewarisi watermark stream.
import type { CrawlDispatchPayload } from "@smip/contracts";
import { type Db, type Tx, textArray, withSystem } from "@smip/db";
import { coverSet, type Node, normalizeText } from "@smip/query";
import { sql } from "drizzle-orm";

export interface PlanMember {
  planId: string;
  tenantId: string;
  topicQueryId: string;
  platform: string;
  operation: CrawlDispatchPayload["operation"];
  intervalSec: number;
  highWatermark: Date | null;
  terms: string[] | null; // null = tidak bisa ditutup (murni NOT) → tetap plan
  byo: boolean;
}

export interface DesiredStream {
  key: string;
  platform: string;
  operation: CrawlDispatchPayload["operation"];
  intervalClass: number;
  visibilityTenantId: string | null;
  terms: string[];
  members: PlanMember[];
}

const leafTerm = (v: string) => normalizeText(v).trim();

/** Pure: kelompokkan anggota menjadi stream yang diinginkan. Anggota tanpa stream tetap dijalankan sebagai plan. */
export function planStreamGroups(members: PlanMember[]): DesiredStream[] {
  const out: DesiredStream[] = [];
  const groups = new Map<string, PlanMember[]>();
  for (const m of members) {
    if (!m.terms?.length) continue;
    const vis = m.byo ? m.tenantId : "*";
    const g = `${m.platform}|${m.operation}|${vis}`;
    groups.set(g, [...(groups.get(g) ?? []), m]);
  }
  for (const list of groups.values()) {
    const vis = list[0]!.byo ? list[0]!.tenantId : null;
    const streamsHere: DesiredStream[] = [];
    const classes = [...new Set(list.map((m) => m.intervalSec))].sort((a, b) => a - b);
    for (const cls of classes) {
      const rest: PlanMember[] = [];
      for (const m of list.filter((x) => x.intervalSec === cls)) {
        // menumpang stream lebih cepat yang sudah mencakup semua term penutupnya
        const host = streamsHere.find((s) => s.intervalClass < cls && m.terms!.every((t) => s.terms.includes(t)));
        if (host) host.members.push(m);
        else rest.push(m);
      }
      // komponen terhubung (union-find) atas term bersama
      const parent = rest.map((_, i) => i);
      const find = (i: number): number => {
        if (parent[i] === i) return i;
        const root = find(parent[i]!);
        parent[i] = root; // path compression
        return root;
      };
      const owner = new Map<string, number>();
      rest.forEach((m, i) => {
        for (const t of m.terms!) {
          const j = owner.get(t);
          if (j === undefined) owner.set(t, i);
          else parent[find(i)] = find(j);
        }
      });
      const comps = new Map<number, PlanMember[]>();
      rest.forEach((m, i) => {
        comps.set(find(i), [...(comps.get(find(i)) ?? []), m]);
      });
      for (const comp of comps.values()) {
        if (comp.length < 2) continue; // tanpa irisan → tak ada penghematan, tetap plan
        const terms = [...new Set(comp.flatMap((m) => m.terms!))].sort();
        const first = comp[0]!;
        const key = [first.platform, first.operation, cls, vis ?? "*", terms.join("\u0001")].join("|");
        streamsHere.push({
          key,
          platform: first.platform,
          operation: first.operation,
          intervalClass: cls,
          visibilityTenantId: vis,
          terms,
          members: comp,
        });
      }
    }
    out.push(...streamsHere);
  }
  return out;
}

async function loadMembers(tx: Tx): Promise<PlanMember[]> {
  const rows = (await tx.execute(sql`
    select p.id as plan_id, p.tenant_id, p.topic_query_id, p.platform_code, p.operation, p.interval_sec, p.high_watermark, q.query_ast,
           exists (select 1 from provider_accounts a where a.tenant_id = p.tenant_id and a.status = 'active') as byo
    from crawl_plans p join topic_queries q on q.id = p.topic_query_id join topics t on t.id = p.topic_id
    where p.status in ('active', 'error_backoff') and q.enabled and t.status = 'active' and t.deleted_at is null
      and p.operation like 'search_%'`)) as unknown as {
    plan_id: string;
    tenant_id: string;
    topic_query_id: string;
    platform_code: string;
    operation: CrawlDispatchPayload["operation"];
    interval_sec: number;
    high_watermark: Date | null;
    query_ast: Node & { version?: number };
    byo: boolean;
  }[];
  return rows.map((r) => {
    const { version: _v, ...ast } = r.query_ast ?? ({} as Node);
    let cover: ReturnType<typeof coverSet> = null;
    try {
      cover = coverSet(ast as Node); // AST rusak/tak dikenal → tidak digabung (tetap plan), bukan crash planner
    } catch {
      cover = null;
    }
    return {
      planId: r.plan_id,
      tenantId: r.tenant_id,
      topicQueryId: r.topic_query_id,
      platform: r.platform_code,
      operation: r.operation,
      intervalSec: r.interval_sec,
      highWatermark: r.high_watermark,
      terms: cover ? [...new Set(cover.map((l) => leafTerm(l.value)))].filter(Boolean) : null,
      byo: r.byo,
    };
  });
}

export interface PlanStreamsResult {
  active: number;
  created: number;
  retired: number;
  links: number;
}

/** Rekonsiliasi collection_streams + stream_topic_links dengan hasil planner (satu transaksi, idempoten). */
export async function planStreams(db: Db, o: { now?: () => Date } = {}): Promise<PlanStreamsResult> {
  const now = o.now?.() ?? new Date();
  return withSystem(db, async (tx) => {
    const desired = planStreamGroups(await loadMembers(tx));
    const keyHash = (k: string) => Buffer.from(new Bun.CryptoHasher("sha256").update(k).digest());
    const wantKeys = desired.map((s) => keyHash(s.key));

    // 1) stream yang tidak diinginkan lagi: plan anggota mewarisi watermark stream, link dihapus, stream nonaktif
    const retired = (await tx.execute(sql`
      update collection_streams set enabled = false, updated_at = now()
      where enabled ${wantKeys.length ? sql`and stream_key not in ${wantKeys}` : sql``}
      returning id, high_watermark`)) as unknown as { id: string; high_watermark: Date | null }[];
    for (const r of retired) {
      if (r.high_watermark) {
        await tx.execute(sql`update crawl_plans p set high_watermark = greatest(coalesce(p.high_watermark, '-infinity'), ${r.high_watermark.toISOString()}::timestamptz)
          from stream_topic_links l where l.stream_id = ${r.id} and p.topic_query_id = l.topic_query_id`);
      }
      await tx.execute(sql`delete from stream_topic_links where stream_id = ${r.id}`);
    }

    let created = 0;
    let links = 0;
    for (const [i, s] of desired.entries()) {
      const hws = s.members.map((m) => m.highWatermark);
      const startHw = hws.some((h) => h === null) ? null : new Date(Math.min(...hws.map((h) => h!.getTime())));
      const [row] = (await tx.execute(sql`
        insert into collection_streams (id, platform_code, operation, stream_key, interval_class, visibility_tenant_id, terms, interval_sec,
                                        high_watermark, next_run_at, enabled, priority)
        values (${Bun.randomUUIDv7()}, ${s.platform}, ${s.operation}, ${wantKeys[i]!}, ${s.intervalClass}, ${s.visibilityTenantId},
                ${textArray(s.terms)}, ${s.intervalClass},
                ${startHw?.toISOString() ?? null}::timestamptz, ${now.toISOString()}::timestamptz, true, ${s.intervalClass <= 900 ? 0 : 5})
        on conflict (stream_key) do update set enabled = true, updated_at = now()
        returning id, (xmax = 0) as inserted`)) as unknown as { id: string; inserted: boolean }[];
      if (row!.inserted) created++;
      const ids = s.members.map((m) => m.topicQueryId);
      // anggota yang pindah dari stream lain: bawa watermark stream lama dulu (tanpa celah)
      await tx.execute(sql`update crawl_plans p set high_watermark = greatest(coalesce(p.high_watermark, '-infinity'), cs.high_watermark)
        from stream_topic_links l join collection_streams cs on cs.id = l.stream_id
        where l.topic_query_id = p.topic_query_id and l.stream_id <> ${row!.id} and cs.high_watermark is not null and p.topic_query_id in ${ids}`);
      await tx.execute(sql`delete from stream_topic_links where topic_query_id in ${ids} and stream_id <> ${row!.id}`);
      await tx.execute(sql`delete from stream_topic_links where stream_id = ${row!.id} and topic_query_id not in ${ids}`);
      for (const m of s.members) {
        await tx.execute(sql`insert into stream_topic_links (stream_id, tenant_id, topic_query_id) values (${row!.id}, ${m.tenantId}, ${m.topicQueryId})
          on conflict do nothing`);
        links++;
      }
    }
    return { active: desired.length, created, retired: retired.length, links };
  });
}
