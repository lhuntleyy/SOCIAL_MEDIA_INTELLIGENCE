// F-11: seed dev idempoten (DEPLOYMENT §3: tenant demo, fake connector, policy default). Aman dijalankan berulang.
//   DATABASE_URL=… [SEED_ADMIN_PASSWORD=…] bun scripts/seed.ts
// Password admin: dari SEED_ADMIN_PASSWORD, atau dibuat acak dan dicetak SEKALI (tidak disimpan di file).
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL wajib");
if (process.env.NODE_ENV === "production") throw new Error("seed dev dilarang di produksi");

// ID deterministik agar idempoten & mudah dirujuk test/dev
const id = (n: number) => `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const IDS = { plan: id(1), tenant: id(2), admin: id(3), providerFake: id(10) };

const PLATFORMS: [string, string, string, string[], boolean, number][] = [
  ["x", "Twitter / X", "twitter", ["post", "reply", "repost", "quote"], true, 1],
  ["instagram", "Instagram", "instagram", ["post", "comment"], true, 2],
  ["facebook", "Facebook", "facebook", ["post", "comment"], true, 3],
  ["youtube", "Youtube", "youtube", ["post", "comment"], true, 4],
  ["tiktok", "Tiktok", "tiktok", ["post", "comment"], true, 5],
  ["threads", "Threads", "threads", ["post", "reply", "repost", "quote"], true, 6],
  ["bluesky", "Bluesky", "bluesky", ["post", "reply", "repost", "quote"], false, 7], // registry, connector Fase 6
  ["reddit", "Reddit", "reddit", ["post", "comment"], false, 8],
];

// Provider nyata dicatat DISABLED (kill-switch) — diaktifkan operator setelah connector verified (AGENTS §5).
const PROVIDERS: [string, string, string, string][] = [
  ["fake", "Fake (dev/test)", "third_party", "low"],
  ["twitterapi_io", "twitterapi.io", "third_party", "medium"],
  ["apify", "Apify", "third_party", "medium"],
  ["x_api", "X API", "official", "low"],
  ["youtube_data_api", "YouTube Data API", "official", "low"],
  ["threads_api", "Threads API", "official", "low"],
  ["meta_graph", "Meta Graph API", "official", "low"],
  ["scrapecreators", "ScrapeCreators", "third_party", "medium"],
];

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  await sql.begin(async (tx) => {
    await tx`insert into plans (id, code, name, limits) values (${IDS.plan}, 'dev', 'Dev',
      ${tx.json({ max_topics: 50, min_interval_sec: 300, monthly_fetch_budget_units: 100000, retention_days: 365, max_users: 20 })})
      on conflict (id) do nothing`;
    await tx`insert into tenants (id, slug, name, plan_id) values (${IDS.tenant}, 'contoh', 'Contoh Org', ${IDS.plan}) on conflict (id) do nothing`;

    for (const [code, name, icon, types, enabled, order] of PLATFORMS) {
      await tx`insert into platforms (code, name, icon, content_types, enabled, sort_order) values (${code}, ${name}, ${icon}, ${types}, ${enabled}, ${order})
        on conflict (code) do update set name = excluded.name, icon = excluded.icon, content_types = excluded.content_types, sort_order = excluded.sort_order`;
    }

    const existing = await tx`select 1 from users where id = ${IDS.admin}`;
    if (!existing.length) {
      const pw = process.env.SEED_ADMIN_PASSWORD ?? Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("base64url");
      const hash = await Bun.password.hash(pw, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });
      await tx`insert into users (id, email, name, password_hash, is_platform_operator) values (${IDS.admin}, 'admin@contoh.local', 'Admin Dev', ${hash}, true)`;
      await tx`insert into memberships (tenant_id, user_id, role) values (${IDS.tenant}, ${IDS.admin}, 'owner')`;
      if (!process.env.SEED_ADMIN_PASSWORD) console.log(`admin dev dibuat: admin@contoh.local / ${pw}   (dicetak sekali — simpan sendiri)`);
    }

    for (const [i, [key, name, kind, risk]] of PROVIDERS.entries()) {
      await tx`insert into providers (id, key, name, kind, risk_level, enabled) values (${id(10 + i)}, ${key}, ${name}, ${kind}, ${risk}, ${key === "fake"})
        on conflict (key) do nothing`;
    }

    // connector fake per platform aktif + capability verified (evidence = seed) + policy global search_keyword → fake
    for (const [n, [code, , , , enabled]] of PLATFORMS.entries()) {
      if (!enabled) continue;
      const connectorId = id(100 + n);
      await tx`insert into connectors (id, key, provider_id, platform_code, runtime, version, enabled) values (${connectorId}, ${`fake.${code}`}, ${IDS.providerFake}, ${code}, 'bun', '0.0.0', true)
        on conflict (key) do nothing`;
      await tx`insert into connector_capabilities (connector_id, operation, declared, status, verified_at, evidence_ref)
        values (${connectorId}, 'search_keyword', ${tx.json({ query_features: ["term", "phrase", "or", "and", "not", "group"], supports_since: true, supports_cursor: true })},
                'verified', now(), 'seed:fake-connector')
        on conflict (connector_id, operation) do nothing`;
      const policyId = id(200 + n);
      await tx`insert into routing_policies (id, tenant_id, platform_code, operation) values (${policyId}, null, ${code}, 'search_keyword')
        on conflict do nothing`;
      await tx`insert into routing_rules (id, policy_id, connector_id, priority, weight, enabled) values (${id(300 + n)}, ${policyId}, ${connectorId}, 1, 100, true)
        on conflict (policy_id, connector_id) do nothing`;
    }
  });
  const [c] = await sql`select (select count(*) from platforms)::int platforms, (select count(*) from connectors)::int connectors,
    (select count(*) from routing_policies)::int policies, (select count(*) from tenants)::int tenants`;
  console.log("seed OK", c);
} finally {
  await sql.end();
}

// Vault: kunci transit KEK untuk credential (SECURITY §4)
if (process.env.VAULT_ADDR && process.env.VAULT_TOKEN) {
  const h = { "X-Vault-Token": process.env.VAULT_TOKEN, "content-type": "application/json" };
  await fetch(`${process.env.VAULT_ADDR}/v1/sys/mounts/transit`, { method: "POST", headers: h, body: JSON.stringify({ type: "transit" }) });
  const r = await fetch(`${process.env.VAULT_ADDR}/v1/transit/keys/${process.env.KMS_KEY_ID ?? "smip-kek"}`, {
    method: "POST",
    headers: h,
    body: "{}",
  });
  console.log(`vault transit key ${process.env.KMS_KEY_ID ?? "smip-kek"}: HTTP ${r.status}`);
}
