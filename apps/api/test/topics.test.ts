// I-03 integrasi: Topic CRUD + validate/preview/cost-estimate + SyncCrawlPlans (API_SPEC §4, DATA_MODEL §3.7).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Previewer, TopicService } from "../src/topics/service";
import { type ApiHarness, apiHarness, infraUp, tid } from "./helpers";

const up = await infraUp();
const A = tid(1);
const B = tid(2);
const U = { adminA: tid(11), analystA: tid(12), viewerA: tid(13), ownerB: tid(20) };
type J<T = Record<string, unknown>> = {
  data: T;
  error?: { code: string; details?: { path: string; issue: string }[] };
  warnings?: { code: string; platform: string; reason: string }[];
  meta?: { page?: { next_cursor: string | null; total: number } };
};
const j = async <T = Record<string, unknown>>(r: Response) => (await r.json()) as J<T>;

/** Previewer palsu: data "terindeks" in-memory (API tidak butuh ClickHouse untuk tes ini). */
const indexed = [
  { platform: "x", post_id: "1", text: "Koperasi Merah Putih diresmikan", lang: "in", hashtags: [], published_at: "2026-09-27T01:00:00Z" },
  { platform: "x", post_id: "2", text: "kopdes merah putih mulai jalan", lang: "id", hashtags: [], published_at: "2026-09-27T02:00:00Z" },
  { platform: "x", post_id: "3", text: "merah putih di upacara", lang: "id", hashtags: [], published_at: "2026-09-27T03:00:00Z" }, // kandidat, tidak cocok
  { platform: "instagram", post_id: "4", text: "rapat #kdmp desa", lang: "id", hashtags: ["kdmp"], published_at: "2026-09-27T04:00:00Z" },
];
const previewCalls: { needles: string[]; hashtags: string[] }[] = [];
const previewer: Previewer = async (q) => {
  previewCalls.push({ needles: q.needles, hashtags: q.hashtags });
  const sample = indexed.filter((i) => q.platforms.includes(i.platform));
  // "7 hari" × 10 kandidat per sampel → estimasi = kandidat × rasio cocok / 7
  const counts = Object.fromEntries(q.platforms.map((p) => [p, sample.filter((s) => s.platform === p).length * 70]));
  return { counts, sample };
};

const main = { kind: "main", query_text: '"KDMP" OR "koperasi merah putih"', keywords: ["kopdes"], languages: ["id"] };
const sub = { kind: "sub", label: "Kades", query_text: '"kades" AND "koperasi"', platforms: ["x"] };
const body = (name: string, o: Record<string, unknown> = {}) => ({
  name,
  description: "Monitoring isu",
  platforms: [
    { code: "x", interval_sec: 300 },
    { code: "instagram", interval_sec: 900 },
  ],
  taxonomy_type: "interest",
  queries: [main, sub],
  ...o,
});

describe.skipIf(!up)("topics API (integrasi)", () => {
  let h: ApiHarness;
  const tok: Record<string, string> = {};
  let topicId = "";

  beforeAll(async () => {
    h = await apiHarness("topics", undefined, (db) => ({ topics: new TopicService(db, { previewer }) }));
    const { sql } = h;
    await sql`insert into plans (id, code, name, limits) values (${tid(90)}, 'pro', 'Pro', ${sql.json({ max_topics: 3, min_interval_sec: 900, initial_backfill_days: 0 })})`;
    await sql`insert into tenants (id, slug, name, plan_id) values (${A}, 'org-a', 'Org A', ${tid(90)}), (${B}, 'org-b', 'Org B', ${tid(90)})`;
    for (const [id, email, t, role] of [
      [U.adminA, "admin@a.id", A, "admin"],
      [U.analystA, "analyst@a.id", A, "analyst"],
      [U.viewerA, "viewer@a.id", A, "viewer"],
      [U.ownerB, "owner@b.id", B, "owner"],
    ] as const) {
      await sql`insert into users (id, email, name, password_hash) values (${id}, ${email}, ${email}, 'x')`;
      await sql`insert into memberships (tenant_id, user_id, role) values (${t}, ${id}, ${role})`;
    }
    await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE smip_system`;
      await tx`insert into platforms (code, name, icon, content_types, enabled, sort_order) values
        ('x', 'X', 'x', '{post}', true, 1), ('instagram', 'Instagram', 'ig', '{post}', true, 2), ('tiktok', 'TikTok', 'tt', '{video}', false, 3)`;
      await tx`insert into taxonomies (id, tenant_id, type, name) values (${tid(70)}, null, 'interest', 'Politik'), (${tid(71)}, ${B}, 'interest', 'Rahasia B'), (${tid(72)}, null, 'industry', 'Retail')`;
      const conns = [
        [
          "x",
          tid(40),
          tid(41),
          { min_interval_sec: 300, cost_per_1k_results: 0.15, min_cost_per_request: 0.00015 },
          ["term", "phrase", "or", "and", "not", "group"],
        ],
        ["instagram", tid(50), tid(51), { min_interval_sec: 1800, fixed_cost_per_run: 0.05, cost_per_1k_results: 2.3 }, ["term"]],
      ] as const;
      for (const [pl, prov, conn, measured, features] of conns) {
        await tx`insert into providers (id, key, name, kind, risk_level, enabled) values (${prov}, ${`prov_${pl}`}, ${pl}, 'third_party', 'medium', true)`;
        await tx`insert into connectors (id, key, provider_id, platform_code, runtime, version, enabled) values (${conn}, ${`prov_${pl}.${pl}`}, ${prov}, ${pl}, 'bun', '1', true)`;
        await tx`insert into connector_capabilities (connector_id, operation, declared, measured, status, verified_at, evidence_ref)
          values (${conn}, 'search_keyword', ${tx.json({ query_features: [...features], max_query_length: 512 })}, ${tx.json(measured)}, 'verified', now(), 'test')`;
        const pol = Bun.randomUUIDv7();
        await tx`insert into routing_policies (id, platform_code, operation) values (${pol}, ${pl}, 'search_keyword')`;
        await tx`insert into routing_rules (id, policy_id, connector_id, priority, weight, enabled) values (${Bun.randomUUIDv7()}, ${pol}, ${conn}, 1, 100, true)`;
      }
    });
    tok.adminA = await h.token({ sub: U.adminA, tid: A, role: "admin" });
    tok.analystA = await h.token({ sub: U.analystA, tid: A, role: "analyst" });
    tok.viewerA = await h.token({ sub: U.viewerA, tid: A, role: "viewer" });
    tok.ownerB = await h.token({ sub: U.ownerB, tid: B, role: "owner" });
  });
  afterAll(async () => h?.close());

  test("validate-query: contoh API_SPEC; query rusak → INVALID_QUERY berposisi", async () => {
    const r = await j<{ valid: boolean; positive_terms: string[]; normalized: string }>(
      await h.call("POST", "/topics/validate-query", {
        token: tok.analystA,
        body: { query_text: '("demo" OR "unras") AND NOT "2025"', keywords: ["unjuk rasa"], languages: ["id"] },
      }),
    );
    expect(r.data.valid).toBe(true);
    expect(r.data.positive_terms).toEqual(["demo", "unras", "unjuk rasa"]);
    expect(r.data.normalized).toBe('("demo" OR "unras" OR "unjuk rasa") AND NOT "2025"');
    const bad = await h.call("POST", "/topics/validate-query", { token: tok.analystA, body: { query_text: '"kopdes OR x' } });
    expect(bad.status).toBe(400);
    const e = await j(bad);
    expect(e.error?.code).toBe("INVALID_QUERY");
    expect(e.error?.details?.[0]?.issue).toContain("posisi");
    expect((await h.call("POST", "/topics/validate-query", { token: tok.viewerA, body: { query_text: "a" } })).status).toBe(403);
  });

  test("preview: kandidat dari data terindeks → presisi matcher lokal + estimasi/hari", async () => {
    const r = await j<{ sample: { post_id: string }[]; estimated_matches_per_day: Record<string, number> }>(
      await h.call("POST", "/topics/preview", { token: tok.analystA, body: { platforms: ["x", "instagram"], queries: [main] } }),
    );
    expect(r.data.sample.map((s) => s.post_id)).toEqual(["1", "2", "4"]); // "merah putih di upacara" tidak cocok
    // x: 3 kandidat sampel × 70 = 210 kandidat, 2/3 cocok → 140 / 7 = 20 per hari; instagram: 70 × 1 / 7 = 10
    expect(r.data.estimated_matches_per_day).toEqual({ x: 20, instagram: 10 });
    expect(previewCalls.at(-1)!.needles.sort()).toEqual(["kdmp", "kopdes", "koperasi merah putih"]);
  });

  test("create: interval di-clamp (plan & connector), crawl_plans tersinkron, cost estimate, audit + outbox", async () => {
    const r = await h.call("POST", "/topics", { token: tok.analystA, body: body("PERMASALAHAN KDMP", { taxonomy_ids: [tid(70)] }) });
    expect(r.status).toBe(201);
    const t = await j<{
      id: string;
      status: string;
      version: number;
      platforms: { code: string; interval_sec: number; effective_interval_sec: number; enabled: boolean; operations: string[] }[];
      queries: { id: string; kind: string; ast_version: number }[];
      taxonomy_ids: string[];
      author: { id: string };
      cost_estimate: {
        requests_per_day: number;
        results_per_day: number;
        usd_per_day: number;
        unverified_rates: string[];
        by_platform: Record<string, { requests: number; results: number; runs: number }>;
      };
    }>(r);
    topicId = t.data.id;
    expect(t.data).toMatchObject({ status: "active", version: 1, taxonomy_ids: [tid(70)], author: { id: U.analystA } });
    expect(t.data.platforms).toEqual([
      { code: "instagram", interval_sec: 900, effective_interval_sec: 1800, enabled: true, operations: ["search_keyword"] },
      { code: "x", interval_sec: 300, effective_interval_sec: 900, enabled: true, operations: ["search_keyword"] },
    ]);
    expect(t.warnings?.map((w) => [w.platform, w.reason]).sort()).toEqual([
      ["instagram", "min_interval_of_available_connectors"],
      ["x", "plan_min_interval"],
    ]);
    expect(t.data.queries.map((q) => [q.kind, q.ast_version])).toEqual([
      ["main", 1],
      ["sub", 1],
    ]);
    // x @900: main → 1 query OR eksak, sub → 1 query eksak = 2 sub-query × 96 = 192 req; instagram @1800 (hanya "term"):
    // main → cover {kdmp, koperasi merah putih, kopdes} = 3 sub-query × 48 = 144 req
    const est = t.data.cost_estimate;
    expect(est.by_platform.x).toMatchObject({ requests: 192, runs: 192 });
    expect(est.by_platform.instagram).toMatchObject({ requests: 144, runs: 48 });
    // hasil: x 20 × 1,1 = 22; instagram 10 × 1,4 = 14
    expect([est.by_platform.x!.results, est.by_platform.instagram!.results]).toEqual([22, 14]);
    // usd: x = 22×0,15/1000 + 192×0,00015 = 0,0321 → 0,03; ig = 48×0,05 + 14×2,3/1000 = 2,4322 → 2,43
    expect(est.usd_per_day).toBe(2.46);
    expect(est.unverified_rates).toEqual([]);

    const plans =
      await h.sql`select p.platform_code, q.kind, p.interval_sec, p.status, p.priority from crawl_plans p join topic_queries q on q.id = p.topic_query_id
      where p.topic_id = ${topicId} order by p.platform_code, q.kind`;
    expect(plans.map((p) => [p.platform_code, p.kind, p.interval_sec, p.status, p.priority])).toEqual([
      ["instagram", "main", 1800, "active", 5],
      ["x", "main", 900, "active", 0],
      ["x", "sub", 900, "active", 0], // sub hanya platform x
    ]);
    const [q] =
      await h.sql`select languages, keywords, jsonb_typeof(query_ast) as t, octet_length(ast_hash) as hl from topic_queries where topic_id = ${topicId} and kind = 'main'`;
    expect(q).toEqual({ languages: ["id"], keywords: ["kopdes"], t: "object", hl: 32 });
    expect((await h.sql`select count(*)::int as n from outbox where aggregate = 'topic' and aggregate_id = ${topicId}`)[0]!.n).toBe(1);
    expect((await h.sql`select count(*)::int as n from audit_logs where action = 'topic.create' and target_id = ${topicId}`)[0]!.n).toBe(1);
  });

  test("validasi: nama duplikat 409, platform nonaktif, tanpa main query, taxonomy tenant lain / tipe salah, viewer 403", async () => {
    expect((await h.call("POST", "/topics", { token: tok.analystA, body: body("permasalahan kdmp") })).status).toBe(409);
    const e1 = await j(await h.call("POST", "/topics", { token: tok.analystA, body: body("T1", { platforms: [{ code: "tiktok" }] }) }));
    expect(e1.error?.code).toBe("VALIDATION_FAILED");
    const e2 = await j(await h.call("POST", "/topics", { token: tok.analystA, body: body("T2", { queries: [sub] }) }));
    expect(e2.error?.details?.[0]?.path).toBe("queries");
    const e3 = await j(await h.call("POST", "/topics", { token: tok.analystA, body: body("T3", { taxonomy_ids: [tid(71)] }) }));
    expect(e3.error?.details?.[0]?.path).toBe("taxonomy_ids"); // taxonomy milik B tak terlihat (RLS)
    const e4 = await j(await h.call("POST", "/topics", { token: tok.analystA, body: body("T4", { taxonomy_ids: [tid(72)] }) }));
    expect(e4.error?.details?.[0]?.issue).toContain("interest");
    expect((await h.call("POST", "/topics", { token: tok.viewerA, body: body("T5") })).status).toBe(403);
    expect((await h.call("POST", "/topics", { token: tok.analystA, body: { ...body("T6"), extra: 1 } })).status).toBe(400);
  });

  test("list: search/sort/cursor; isolasi tenant (B tidak melihat, GET id milik A → 404)", async () => {
    await h.call("POST", "/topics", {
      token: tok.analystA,
      body: body("Banjir Jakarta", { queries: [{ kind: "main", query_text: "banjir" }] }),
    });
    const all = await j<{ name: string }[]>(await h.call("GET", "/topics?sort=name:asc&limit=1", { token: tok.viewerA }));
    expect(all.data.map((t) => t.name)).toEqual(["Banjir Jakarta"]);
    expect(all.meta?.page?.total).toBe(2);
    const next = await j<{ name: string }[]>(
      await h.call("GET", `/topics?sort=name:asc&limit=1&cursor=${all.meta!.page!.next_cursor}`, { token: tok.viewerA }),
    );
    expect(next.data.map((t) => t.name)).toEqual(["PERMASALAHAN KDMP"]);
    expect(next.meta?.page?.next_cursor).toBeNull();
    expect((await j<unknown[]>(await h.call("GET", "/topics?search=kdmp", { token: tok.viewerA }))).data).toHaveLength(1);
    expect((await j<unknown[]>(await h.call("GET", "/topics?type=industry", { token: tok.viewerA }))).data).toHaveLength(0);
    expect((await j<unknown[]>(await h.call("GET", "/topics", { token: tok.ownerB }))).data).toHaveLength(0);
    expect((await h.call("GET", `/topics/${topicId}`, { token: tok.ownerB })).status).toBe(404);
    expect((await h.call("PATCH", `/topics/${topicId}`, { token: tok.ownerB, body: { name: "curi" } })).status).toBe(404);
  });

  test("PATCH: If-Match, hapus sub query → plan-nya ikut terhapus, platform dimatikan → plan disabled", async () => {
    const cur = await j<{ version: number; queries: { id: string; kind: string; query_text: string }[] }>(
      await h.call("GET", `/topics/${topicId}`, { token: tok.analystA }),
    );
    const stale = await h.call("PATCH", `/topics/${topicId}`, {
      token: tok.analystA,
      headers: { "if-match": '"99"' },
      body: { name: "Nama Baru" },
    });
    expect([stale.status, (await j(stale)).error?.code]).toEqual([409, "VERSION_MISMATCH"]);
    const mainQ = cur.data.queries.find((q) => q.kind === "main")!;
    const r = await h.call("PATCH", `/topics/${topicId}`, {
      token: tok.analystA,
      headers: { "if-match": `"${cur.data.version}"` },
      body: {
        description: "baru",
        queries: [{ id: mainQ.id, kind: "main", query_text: mainQ.query_text, keywords: ["kopdes", "kdkmp"] }],
        platforms: [
          { code: "x", interval_sec: 900 },
          { code: "instagram", interval_sec: 1800, enabled: false },
        ],
      },
    });
    expect(r.status).toBe(200);
    const t = await j<{ version: number; queries: { id: string; keywords: string[] }[]; description: string }>(r);
    expect(t.data.version).toBe(cur.data.version + 1);
    expect(t.data.queries.map((q) => [q.id, q.keywords])).toEqual([[mainQ.id, ["kopdes", "kdkmp"]]]); // id query dipertahankan
    const plans = await h.sql`select platform_code, status from crawl_plans where topic_id = ${topicId} order by platform_code`;
    expect(plans.map((p) => [p.platform_code, p.status])).toEqual([
      ["instagram", "disabled"],
      ["x", "active"],
    ]);
  });

  test("pause/resume/archive → status plan ikut; arsip hanya admin; setelah arsip 404", async () => {
    await h.call("POST", `/topics/${topicId}/pause`, { token: tok.analystA });
    const st = async () =>
      (await h.sql`select platform_code, status from crawl_plans where topic_id = ${topicId} order by platform_code`).map((p) => p.status);
    expect(await st()).toEqual(["disabled", "paused"]);
    await h.call("POST", `/topics/${topicId}/resume`, { token: tok.analystA });
    expect(await st()).toEqual(["disabled", "active"]);
    expect((await h.call("DELETE", `/topics/${topicId}`, { token: tok.analystA })).status).toBe(403);
    expect((await h.call("DELETE", `/topics/${topicId}`, { token: tok.adminA })).status).toBe(204);
    expect(await st()).toEqual(["disabled", "disabled"]);
    expect((await h.call("GET", `/topics/${topicId}`, { token: tok.adminA })).status).toBe(404);
    // nama boleh dipakai ulang setelah diarsip (unique index WHERE deleted_at IS NULL)
    expect((await h.call("POST", "/topics", { token: tok.analystA, body: body("PERMASALAHAN KDMP") })).status).toBe(201);
  });

  test("PLAN_LIMIT max_topics; hard quota tenant terlampaui → 422 QUOTA_WOULD_EXCEED; cost-estimate tanpa simpan", async () => {
    // aktif sekarang: Banjir Jakarta + PERMASALAHAN KDMP (baru) = 2; limit 3
    expect((await h.call("POST", "/topics", { token: tok.analystA, body: body("Topik 3") })).status).toBe(201);
    const lim = await h.call("POST", "/topics", { token: tok.analystA, body: body("Topik 4") });
    expect([lim.status, (await j(lim)).error?.code]).toEqual([403, "PLAN_LIMIT"]);
    await h.sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE smip_system`;
      await tx`update plans set limits = ${tx.json({ max_topics: 10, min_interval_sec: 900, initial_backfill_days: 0 })}`;
      await tx`insert into quota_policies (id, scope_type, scope_id, period, unit, limit_value, hard) values (${Bun.randomUUIDv7()}, 'tenant', ${A}, 'day', 'requests', 100, true)`;
      // soft cap (I-23): tidak menolak, hanya memperingatkan throttle
      await tx`insert into quota_policies (id, scope_type, scope_id, period, unit, limit_value, hard) values (${Bun.randomUUIDv7()}, 'tenant', ${A}, 'month', 'requests', 50, false)`;
    });
    const est = await j<{
      requests_per_day: number;
      would_exceed: string[];
      would_throttle: string[];
      quota_after_pct: Record<string, number>;
    }>(
      await h.call("POST", "/topics/cost-estimate", {
        token: tok.analystA,
        body: { platforms: [{ code: "x", interval_sec: 900 }], queries: [main] },
      }),
    );
    expect(est.data).toMatchObject({
      requests_per_day: 96,
      would_exceed: [],
      would_throttle: ["tenant_monthly_requests"],
      quota_after_pct: { tenant_daily_requests: 96 },
    });
    const over = await h.call("POST", "/topics", { token: tok.analystA, body: body("Topik Mahal") });
    expect([over.status, (await j(over)).error?.code]).toEqual([422, "QUOTA_WOULD_EXCEED"]);

    // UI tidak lagi mengirim interval → interval bawaan sistem (1 jam), bisa diatur per plan (limits.default_interval_sec)
    const noInterval = async () =>
      (
        await j<{ requests_per_day: number }>(
          await h.call("POST", "/topics/cost-estimate", { token: tok.analystA, body: { platforms: [{ code: "x" }], queries: [main] } }),
        )
      ).data.requests_per_day;
    expect(await noInterval()).toBe(24);
    await h.sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE smip_system`;
      await tx`update plans set limits = ${tx.json({ max_topics: 10, min_interval_sec: 900, default_interval_sec: 1800, initial_backfill_days: 0 })}`;
    });
    expect(await noInterval()).toBe(48);
  });

  test("API key: scope topics:read hanya boleh baca", async () => {
    const k = await j<{ secret: string }>(
      await h.call("POST", "/api-keys", { token: tok.adminA, body: { name: "bi", scopes: ["topics:read"] } }),
    );
    const hdr = { "x-api-key": k.data.secret };
    expect((await h.call("GET", "/topics", { headers: hdr })).status).toBe(200);
    expect((await h.call("POST", "/topics/validate-query", { headers: hdr, body: { query_text: "a" } })).status).toBe(403);
    const k2 = await j<{ secret: string }>(
      await h.call("POST", "/api-keys", { token: tok.adminA, body: { name: "etl", scopes: ["analytics:read"] } }),
    );
    expect((await h.call("GET", "/topics", { headers: { "x-api-key": k2.data.secret } })).status).toBe(403);
  });
  test("backfill (admin): satu run per plan per hari, prioritas terendah via outbox; riwayat run + attempts; isolasi", async () => {
    const list = await j<{ id: string; name: string }[]>(await h.call("GET", "/topics?search=Banjir", { token: tok.adminA }));
    const banjir = list.data[0]!.id;
    const to = new Date(Date.now() - 3_600_000);
    const from = new Date(to.getTime() - 3 * 86_400_000 + 3_600_000); // 2 hari 23 jam → 3 potongan harian
    const bf = { from: from.toISOString(), to: to.toISOString() };
    expect((await h.call("POST", `/topics/${banjir}/backfill`, { token: tok.analystA, body: bf })).status).toBe(403);
    const r = await h.call("POST", `/topics/${banjir}/backfill`, { token: tok.adminA, body: bf });
    expect(r.status).toBe(202);
    expect((await j<{ runs_created: number; status: string }>(r)).data).toMatchObject({ runs_created: 6, status: "queued" }); // 2 plan (x, instagram) × 3 hari
    const jobs = await h.sql`select payload->>'priority' as pr, payload->'payload'->>'run_kind' as kind from outbox where aggregate = 'job'
      and payload->'payload'->>'topic_id' = ${banjir}`;
    expect(jobs.map((x) => [x.pr, x.kind])).toEqual(Array(6).fill(["10", "backfill"]));
    const bad = [
      { from: bf.from, to: new Date(Date.now() + 86_400_000).toISOString() },
      { from: new Date(Date.now() - 40 * 86_400_000).toISOString(), to: bf.to },
      { from: bf.to, to: bf.from },
    ];
    for (const b of bad) expect((await h.call("POST", `/topics/${banjir}/backfill`, { token: tok.adminA, body: b })).status).toBe(400);
    expect((await h.call("POST", `/topics/${banjir}/backfill`, { token: tok.ownerB, body: bf })).status).toBe(404);

    const [run] =
      await h.sql`select r.id, r.scheduled_for from crawl_runs r join crawl_plans p on p.id = r.crawl_plan_id where p.topic_id = ${banjir} and p.platform_code = 'x' limit 1`;
    await h.sql`insert into provider_attempts (id, crawl_run_id, crawl_run_scheduled_for, tenant_id, connector_id, attempt_no, started_at, duration_ms, outcome, error_code)
      values (${Bun.randomUUIDv7()}, ${run!.id}, ${run!.scheduled_for}, ${A}, ${tid(41)}, 1, now(), 812, 'failover_error', 'RATE_LIMITED')`;
    const runs = await j<
      {
        id: string;
        platform: string;
        kind: string;
        status: string;
        attempts: { no: number; connector: string; outcome: string; error_code: string; duration_ms: number }[];
      }[]
    >(await h.call("GET", `/topics/${banjir}/runs?platform=x`, { token: tok.analystA }));
    expect(runs.data).toHaveLength(3);
    expect(runs.data.every((x) => x.platform === "x" && x.kind === "backfill" && x.status === "queued")).toBe(true);
    expect(runs.data.find((x) => x.id === run!.id)!.attempts).toEqual([
      { no: 1, connector: "prov_x.x", outcome: "failover_error", error_code: "RATE_LIMITED", duration_ms: 812 },
    ]);
    expect((await h.call("GET", `/topics/${banjir}/runs`, { token: tok.ownerB })).status).toBe(404);
  });

  test("I-25: riwayat run memuat run collection stream yang melayani topik + porsi biaya tenant", async () => {
    const list = await j<{ id: string }[]>(await h.call("GET", "/topics?search=Banjir", { token: tok.adminA }));
    const banjir = list.data[0]!.id;
    const [q] = await h.sql`select id from topic_queries where topic_id = ${banjir} limit 1`;
    const stream = Bun.randomUUIDv7();
    const run = Bun.randomUUIDv7();
    await h.sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE smip_system`;
      await tx`insert into collection_streams (id, platform_code, operation, stream_key, interval_class, terms, interval_sec, next_run_at)
        values (${stream}, 'x', 'search_keyword', ${Buffer.from(stream)}, 900, '{banjir}', 900, now())`;
      await tx`insert into stream_topic_links (stream_id, tenant_id, topic_query_id) values (${stream}, ${A}, ${q!.id})`;
      await tx`insert into crawl_runs (id, collection_stream_id, scheduled_for, kind, status, tenant_matches, items_fetched)
        values (${run}, ${stream}, date_trunc('milliseconds', now()), 'incremental', 'succeeded', ${tx.json({ [A]: 7, [B]: 3 })}, 12)`;
      const [r] = await tx`select scheduled_for from crawl_runs where id = ${run}`;
      await tx`insert into cost_allocations (run_id, run_scheduled_for, tenant_id, cost_units, matches, basis) values
        (${run}, ${r!.scheduled_for}, ${A}, 0.07, 7, 'matches'), (${run}, ${r!.scheduled_for}, ${B}, 0.03, 3, 'matches')`;
    });
    const runs = await j<{ id: string; source: string; items_matched: number; cost_units: number | null }[]>(
      await h.call("GET", `/topics/${banjir}/runs`, { token: tok.analystA }),
    );
    const sr = runs.data.find((r) => r.id === run)!;
    expect(sr).toMatchObject({ source: "stream", items_matched: 7, cost_units: 0.07 }); // porsi tenant A saja, bukan total run
    expect(runs.data.filter((r) => r.source === "plan").every((r) => r.cost_units === null)).toBe(true);
  });

  test("scrape awal otomatis: topik baru langsung di-backfill N hari (plan), platform yang baru ditambah juga", async () => {
    await h.sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE smip_system`;
      await tx`update plans set limits = ${tx.json({ max_topics: 20, min_interval_sec: 900, initial_backfill_days: 2 })}`;
      await tx`delete from quota_policies where scope_id = ${A}`;
    });
    const r = await h.call("POST", "/topics", {
      token: tok.analystA,
      body: { name: "Auto Scrape", platforms: [{ code: "x" }], queries: [{ kind: "main", query_text: "banjir" }] },
    });
    expect(r.status).toBe(201);
    const t = await j<{ id: string; version: number; initial_backfill: { days: number; runs: number } }>(r);
    expect(t.data.initial_backfill).toEqual({ days: 2, runs: 2 }); // 1 plan × 2 hari
    const kinds = await h.sql`select r.kind from crawl_runs r join crawl_plans p on p.id = r.crawl_plan_id where p.topic_id = ${t.data.id}`;
    expect(kinds.map((x) => x.kind)).toEqual(["backfill", "backfill"]);
    const u = await h.call("PATCH", `/topics/${t.data.id}`, {
      token: tok.analystA,
      headers: { "if-match": String(t.data.version) },
      body: { platforms: [{ code: "x" }, { code: "instagram" }] },
    });
    expect((await j<{ initial_backfill: { days: number; runs: number } }>(u)).data.initial_backfill).toEqual({ days: 2, runs: 2 }); // hanya instagram
  });
  test("menu Akun: topik kind=account → query @username per platform, plan user_timeline; validasi; filter kind; kind tetap", async () => {
    const acc = {
      kind: "account",
      name: "Akun Pejabat",
      platforms: [{ code: "x" }, { code: "instagram" }],
      queries: [
        { kind: "main", query_text: "@Jokowi", platforms: ["x"] },
        { kind: "sub", query_text: "@jokowi", platforms: ["instagram"] },
      ],
    };
    const r = await j<{ id: string; kind: string; queries: { query_text: string }[] }>(
      await h.call("POST", "/topics", { token: tok.ownerB, body: acc }),
    );
    expect(r.data.kind).toBe("account");
    expect(r.data.queries.map((q) => q.query_text)).toEqual(["@jokowi", "@jokowi"]);
    const plans = await h.sql`select platform_code, operation from crawl_plans where topic_id = ${r.data.id} order by platform_code`;
    expect(plans.map((p) => [p.platform_code, p.operation])).toEqual([
      ["instagram", "user_timeline"],
      ["x", "user_timeline"],
    ]);
    // bukan @username / tanpa platform tunggal → ditolak
    const bad = await j(
      await h.call("POST", "/topics", {
        token: tok.ownerB,
        body: { ...acc, name: "Salah", queries: [{ kind: "main", query_text: "jokowi OR prabowo", platforms: ["x"] }] },
      }),
    );
    expect(bad.error?.code).toBe("VALIDATION_FAILED");
    const list = await j<{ kind: string }[]>(await h.call("GET", "/topics?kind=account", { token: tok.ownerB }));
    expect(list.data.map((t) => t.kind)).toEqual(["account"]);
    expect((await j<unknown[]>(await h.call("GET", "/topics?kind=topic", { token: tok.ownerB }))).data).toHaveLength(0);
    // backfill akun: satu run per akun untuk seluruh rentang (bukan per hari)
    const to = new Date(Date.now() - 60_000);
    const bf = await j<{ runs_created: number }>(
      await h.call("POST", `/topics/${r.data.id}/backfill`, {
        token: tok.ownerB,
        body: { from: new Date(to.getTime() - 3 * 86_400_000).toISOString(), to: to.toISOString() },
      }),
    );
    expect(bf.data.runs_created).toBe(2);
    const ch = await j(await h.call("PATCH", `/topics/${r.data.id}`, { token: tok.ownerB, body: { kind: "topic" } }));
    expect(ch.error?.code).toBe("VALIDATION_FAILED");
  });
});
