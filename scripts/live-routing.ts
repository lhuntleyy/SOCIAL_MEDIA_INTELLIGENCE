// Operator (dev/demo): alihkan routing dari connector `fake` ke connector NYATA yang sudah verified + pagar biaya.
//   bun --env-file=infra/compose/.env.dev scripts/live-routing.ts [--dry]
// Pagar biaya: maxTotalChargeUsd per run + quota biaya bulanan HARD per connector (saat ini NONAKTIF — MONTHLY_CAP; cost guard,
// run dilewati bila habis). Angka = kebijakan operator (internal_safety), bukan angka provider → disimpan di DB, bukan kode.
import postgres from "postgres";

const PLAN: Record<string, { rules: [string, number, number][] }> = {
  x: {
    rules: [
      ["apify.x.xquik", 1, 100],
      ["apify.x.kaito", 2, 100],
      ["apify.x.scraperone", 3, 100],
    ],
  },
  youtube: {
    rules: [
      ["youtube_data_api.youtube", 1, 100],
      ["apify.youtube.streamers", 2, 0],
    ],
  }, // Apify = standby (mahal)
  // clockworks dulu: xmolodtsov tanpa filter tanggal → 0 hasil pada window incremental (live 2026-09-29)
  tiktok: {
    rules: [
      ["apify.tiktok.clockworks", 1, 100],
      ["apify.tiktok.xmolodtsov", 2, 100],
    ],
  },
  // 2026-10-01 (keputusan pemilik): Instagram via HikerAPI saja — hashtag terbaru (berhenti di window, tanpa tagihan berulang) +
  // keyword /gql/topsearch; ±$0,03/1K post vs Apify IG $2,3–10,2/1K (PROVIDER_MATRIX "Uji HikerAPI"). Actor Apify IG dinonaktifkan.
  instagram: { rules: [["hikerapi.instagram", 1, 100]] },
  facebook: { rules: [["apify.facebook.scraperone", 1, 100]] },
  threads: { rules: [["apify.threads.scrapersdelight", 1, 100]] },
};
/** Pagar biaya internal. Keputusan pemilik 2026-10-01: **tanpa batas bulanan dulu** (`MONTHLY_CAP=false` → kuota bulanan per
 * connector dinonaktifkan, bukan dihapus; batas nyata = batas pemakaian akun Apify sendiri). Nyalakan lagi: `MONTHLY_CAP = true`.
 * Angka di bawah = batas yang dipakai saat pagar aktif (USD/bulan per connector, hard). */
const MONTHLY_CAP = false;
/** Batas biaya per run actor (`maxTotalChargeUsd`) — pengaman run liar, bukan pembatas volume (maxItems 300/run tetap berlaku). */
const PER_RUN_USD = 1;
/** Run Apify bersamaan per akun (plan STARTER; FREE dulu 4 karena batas memori 8 GB). */
const APIFY_CONCURRENCY = 8;
const MONTHLY_USD: Record<string, number> = {
  "apify.x.xquik": 1.5,
  "apify.x.kaito": 0.3,
  "apify.x.scraperone": 0.3,
  "apify.tiktok.clockworks": 1.2,
  "apify.tiktok.xmolodtsov": 0.3,
  "apify.instagram.boolean": 2.0,
  "apify.instagram.hashtag": 0.8,
  "apify.facebook.scraperone": 0.8,
  "apify.threads.scrapersdelight": 0.8,
  "apify.youtube.streamers": 0.1,
};
/** Connector yang dimatikan (tidak dipakai routing). */
const DISABLED = ["apify.instagram.boolean", "apify.instagram.hashtag"];
/** Tarif HikerAPI (DOCS hikerapi.com/pricing 2026-10-01: $1 / 1.000 request paket populer; $0,60 di volume) → usage.costUnits. */
const HIKER_USD_PER_REQUEST = 0.001;
const dry = process.argv.includes("--dry");
const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
try {
  await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE smip_system`;
    const keys = Object.values(PLAN).flatMap((p) => p.rules.map((r) => r[0]));
    const conns = await tx`select c.id, c.key, c.provider_id, c.config from connectors c where c.key in ${tx(keys)}`;
    const byKey = new Map(conns.map((c) => [c.key as string, c]));
    for (const k of keys) if (!byKey.has(k)) throw new Error(`connector ${k} belum terdaftar`);
    await tx`update providers set enabled = true, updated_at = now() where id in ${tx([...new Set(conns.map((c) => c.provider_id as string))])}`;
    for (const c of conns) {
      const cfg = { ...(c.config as Record<string, unknown>) };
      if (c.key.startsWith("apify.")) cfg.maxTotalChargeUsd = PER_RUN_USD;
      if (c.key.startsWith("hikerapi.")) cfg.usdPerRequest = HIKER_USD_PER_REQUEST;
      await tx`update connectors set enabled = true, config = ${tx.json(cfg as never)}, updated_at = now() where id = ${c.id}`;
      const usd = MONTHLY_USD[c.key];
      if (usd !== undefined) {
        const [q] =
          await tx`select id from quota_policies where scope_type = 'connector' and scope_id = ${c.id} and period = 'month' and unit = 'cost_units'`;
        if (q) await tx`update quota_policies set limit_value = ${usd}, hard = true, enabled = ${MONTHLY_CAP} where id = ${q.id}`;
        else if (MONTHLY_CAP)
          await tx`insert into quota_policies (id, scope_type, scope_id, period, unit, limit_value, hard, alert_thresholds, reset_tz)
            values (${Bun.randomUUIDv7()}, 'connector', ${c.id}, 'month', 'cost_units', ${usd}, true, '{50,80,95}', 'UTC')`;
        await tx`insert into outbox (aggregate, aggregate_id, event_type, payload) values ('quota_policy', ${c.id}, 'quota.updated', '{}')`;
      }
    }
    for (const [c] of await tx`select id from connectors where key in ${tx(DISABLED)}`.then((r) => r.map((x) => [x]))) {
      await tx`update connectors set enabled = false, updated_at = now() where id = ${c!.id}`;
      await tx`insert into outbox (aggregate, aggregate_id, event_type, payload) values ('connector', ${c!.id}, 'connector.updated', '{}')`;
    }
    // HikerAPI memakai API privat Instagram → risiko tinggi (tenant yang opt-out tidak dilayani, I-19)
    await tx`update providers set risk_level = 'high', updated_at = now() where key = 'hikerapi'`;
    // run Apify bersamaan dibatasi per akun: plan menolak run baru bila total memori run aktif melebihi batas plan
    // (HTTP 402 actor-memory-limit-exceeded, teramati live 2026-09-30 di plan FREE saat 8 run paralel × 1 GB)
    for (const acc of await tx`select pa.id from provider_accounts pa join providers p on p.id = pa.provider_id where p.key = 'apify' and pa.status = 'active'`) {
      const [rl] =
        await tx`select id from rate_limit_policies where scope_type = 'provider_account' and scope_id = ${acc.id} and algorithm = 'concurrency'`;
      const ref = `internal_safety: ${APIFY_CONCURRENCY} run × 1 GB < batas memori plan STARTER Apify (2026-10-01); 402 actor-memory-limit-exceeded teramati di FREE 2026-09-30`;
      if (rl)
        await tx`update rate_limit_policies set capacity = ${APIFY_CONCURRENCY}, source_ref = ${ref}, enabled = true where id = ${rl.id}`;
      else
        await tx`insert into rate_limit_policies (id, scope_type, scope_id, algorithm, capacity, refill_tokens, refill_interval_ms, source, source_ref, enabled)
          values (${Bun.randomUUIDv7()}, 'provider_account', ${acc.id}, 'concurrency', ${APIFY_CONCURRENCY}, 0, 1000, 'internal_safety', ${ref}, true)`;
      await tx`insert into outbox (aggregate, aggregate_id, event_type, payload) values ('rate_limit_policy', ${acc.id}, 'rate_limit.updated', '{}')`;
    }
    for (const [platform, p] of Object.entries(PLAN)) {
      const [pol] =
        await tx`select id from routing_policies where tenant_id is null and platform_code = ${platform} and operation = 'search_keyword'`;
      if (!pol) throw new Error(`policy ${platform}/search_keyword tidak ada`);
      await tx`delete from routing_rules where policy_id = ${pol.id}`;
      for (const [key, prio, weight] of p.rules)
        await tx`insert into routing_rules (id, policy_id, connector_id, priority, weight, enabled, conditions)
          values (${Bun.randomUUIDv7()}, ${pol.id}, ${byKey.get(key)!.id}, ${prio}, ${weight}, true, '{}')`;
      await tx`update routing_policies set version = version + 1, updated_at = now() where id = ${pol.id}`;
      await tx`insert into outbox (aggregate, aggregate_id, event_type, payload) values ('routing_policy', ${pol.id}, 'policy.replaced', ${tx.json({ by: "live-routing" })})`;
      console.log(`${platform}: ${p.rules.map((r) => `${r[0]}(p${r[1]}/w${r[2]})`).join(" → ")}`);
    }
    await tx`insert into audit_logs (id, actor_type, action, target_type, after) values (${Bun.randomUUIDv7()}, 'system', 'routing.live_switch', 'routing_policy', ${tx.json({ plan: PLAN, monthly_cap: MONTHLY_CAP, monthly_usd: MONTHLY_USD, per_run_usd: PER_RUN_USD, apify_concurrency: APIFY_CONCURRENCY } as never)})`;
    if (dry) throw new Error("--dry: rollback");
  });
} finally {
  await sql.end();
}
