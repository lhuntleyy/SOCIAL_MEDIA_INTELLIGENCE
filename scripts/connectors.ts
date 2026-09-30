// Operasi connector (AGENTS §5, CONNECTOR_SPEC §9) — sampai Admin API (I-21) tersedia.
//   bun scripts/connectors.ts register                      → upsert provider/connector/capability(declared) dari manifest registry (nonaktif)
//   bun scripts/connectors.ts account <provider> <label> <ENV_VAR> [secretField]
//                                                           → credential disegel KMS dari env (nilai tidak pernah dicetak) + akun shared pool
//   bun scripts/connectors.ts rotate <provider> <label> <ENV_VAR> [secretField]
//                                                           → ganti token akun yang ada (= PUT /admin/accounts/{id}/credential): credential
//                                                             baru disegel, lama di-crypto-shred, akun kembali `active`, outbox + audit
//   bun scripts/connectors.ts verify <connectorKey> "<query>" [--samples N] [--max-items N] [--window-hours H] [--apply]
//                                                           → panggil provider SUNGGUHAN (berbayar!) dgn window 24 jam, validasi, laporan
//                                                             docs/evidence/verify/verify-<key>.json; --apply → capability verified + measured
// Env: DATABASE_URL, KMS_* (lihat infra/compose/.env.dev). Config biaya connector (maxTotalChargeUsd, memoryMb) diambil dari connectors.config.

import type { Connector } from "@smip/connector-sdk";
import { createKms, credentialAad, fingerprint, open, seal } from "@smip/crypto";
import { connectorRegistry, measuredOf, runVerify } from "@smip/worker-fetch-bun";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL wajib");
const sql = postgres(url, { max: 1, onnotice: () => {} });
const kmsEnv = () => createKms({ NODE_ENV: process.env.NODE_ENV ?? "development", ...process.env });
const registry = connectorRegistry(process.env.NODE_ENV ?? "development");
const [cmd, ...args] = process.argv.slice(2);

/** Manifest connector runtime python (worker-fetch-py) — bentuk sama dgn ConnectorManifest TS. */
async function pythonManifests(): Promise<Connector["manifest"][]> {
  const py = `${import.meta.dir}/../.venv/bin/python`;
  if (!(await Bun.file(py).exists())) return [];
  const p = Bun.spawnSync([py, "-m", "smip_fetch.manifests"], { cwd: `${import.meta.dir}/../workers-py` });
  if (p.exitCode !== 0) throw new Error(`manifest python gagal: ${p.stderr.toString().slice(0, 300)}`);
  return JSON.parse(p.stdout.toString());
}

async function register() {
  const all = [...[...registry.values()].map((c) => c.manifest), ...(await pythonManifests())];
  for (const m of all) {
    if (m.providerKey === "fake") continue; // fake dikelola seed dev
    await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE smip_system`;
      // provider BARU dicatat disabled (kill-switch) — diaktifkan operator setelah verified
      const kind = m.providerKind ?? "third_party";
      const risk = kind === "official" ? "low" : kind === "unofficial" ? "high" : "medium";
      await tx`insert into providers (id, key, name, kind, risk_level, enabled) values (${Bun.randomUUIDv7()}, ${m.providerKey}, ${m.providerKey}, ${kind}, ${risk}, false)
        on conflict (key) do nothing`;
      const [p] = await tx`select id from providers where key = ${m.providerKey}`;
      await tx`insert into connectors (id, key, provider_id, platform_code, runtime, version, enabled, config_schema, manifest_hash)
        values (${Bun.randomUUIDv7()}, ${m.key}, ${p!.id}, ${m.platform}, ${m.runtime}, ${m.version}, false, ${tx.json(m.configSchema as never)},
                ${new Bun.CryptoHasher("sha256").update(JSON.stringify(m)).digest("hex")})
        on conflict (key) do update set version = excluded.version, config_schema = excluded.config_schema, manifest_hash = excluded.manifest_hash, updated_at = now()`;
      const [cr] = await tx`select id from connectors where key = ${m.key}`;
      for (const [op, sup] of Object.entries(m.operations)) {
        const declared = {
          query_features: sup!.queryFeatures,
          max_query_length: sup!.maxQueryLength,
          supports_since: sup!.supportsSince,
          supports_cursor: sup!.supportsCursor,
          async_execution: sup!.asyncExecution,
          result_order: sup!.resultOrder,
          since_granularity: sup!.sinceGranularity ?? "exact",
          returns_fields: sup!.returnsFields,
        };
        // declared diperbarui; status verified TIDAK diubah di sini (hanya lewat verify)
        await tx`insert into connector_capabilities (connector_id, operation, declared) values (${cr!.id}, ${op}, ${tx.json(declared as never)})
          on conflict (connector_id, operation) do update set declared = excluded.declared`;
      }
      console.log(`terdaftar: ${m.key} (${Object.keys(m.operations).join(", ")})`);
    });
  }
}

async function account(providerKey: string, label: string, envVar: string, field = "api_token") {
  const secret = process.env[envVar];
  if (!secret) throw new Error(`env ${envVar} kosong`);
  const kms = kmsEnv();
  await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE smip_system`;
    const [p] = await tx`select id from providers where key = ${providerKey}`;
    if (!p) throw new Error(`provider ${providerKey} belum terdaftar (jalankan register)`);
    const credId = Bun.randomUUIDv7();
    const s = await seal(kms, credentialAad(credId, null), { [field]: secret });
    // fingerprint = HMAC yang sama dengan Admin API (I-21) → duplikat terdeteksi lintas jalur
    const pepperB64 = process.env.CREDENTIAL_PEPPER_B64;
    if (!pepperB64) throw new Error("CREDENTIAL_PEPPER_B64 wajib (lihat infra/compose/.env.dev)");
    const fp = await fingerprint({ [field]: secret }, new Uint8Array(Buffer.from(pepperB64, "base64")));
    const [dup] =
      await tx`select 1 from credentials where fingerprint = ${Buffer.from(fp)} and wrapped_dek is not null and tenant_id is null`;
    if (dup) throw new Error("credential yang sama sudah terdaftar di shared pool");
    await tx`insert into credentials (id, kind, ciphertext, iv, wrapped_dek, kek_id, aad, fingerprint)
      values (${credId}, 'api_key', ${Buffer.from(s.ciphertext)}, ${Buffer.from(s.iv)}, ${Buffer.from(s.wrapped_dek)}, ${s.kek_id}, ${s.aad}, ${Buffer.from(fp)})`;
    await tx`insert into provider_accounts (id, provider_id, label, credential_id, display_hint) values (${Bun.randomUUIDv7()}, ${p.id}, ${label}, ${credId}, ${`…${secret.slice(-4)}`})`;
  });
  console.log(`akun ${label} untuk ${providerKey} dibuat (secret disegel, tidak dicetak)`);
}

async function rotate(providerKey: string, label: string, envVar: string, field = "api_token") {
  const secret = process.env[envVar];
  if (!secret) throw new Error(`env ${envVar} kosong`);
  const kms = kmsEnv();
  const pepperB64 = process.env.CREDENTIAL_PEPPER_B64;
  if (!pepperB64) throw new Error("CREDENTIAL_PEPPER_B64 wajib (lihat infra/compose/.env.dev)");
  await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE smip_system`;
    const [acc] =
      await tx`select pa.id, pa.tenant_id, pa.credential_id, pa.status from provider_accounts pa join providers p on p.id = pa.provider_id
      where p.key = ${providerKey} and pa.label = ${label} for update`;
    if (!acc) throw new Error(`akun ${label} (${providerKey}) tidak ada — pakai perintah account`);
    if (acc.status === "revoked") throw new Error("akun sudah dicabut");
    const fp = await fingerprint({ [field]: secret }, new Uint8Array(Buffer.from(pepperB64, "base64")));
    const [dup] = await tx`select 1 from credentials where fingerprint = ${Buffer.from(fp)} and wrapped_dek is not null
      and tenant_id is not distinct from ${acc.tenant_id}`;
    if (dup) throw new Error("credential yang sama sudah terdaftar");
    const credId = Bun.randomUUIDv7();
    const s = await seal(kms, credentialAad(credId, acc.tenant_id), { [field]: secret });
    await tx`insert into credentials (id, tenant_id, kind, ciphertext, iv, wrapped_dek, kek_id, aad, fingerprint)
      values (${credId}, ${acc.tenant_id}, 'api_key', ${Buffer.from(s.ciphertext)}, ${Buffer.from(s.iv)}, ${Buffer.from(s.wrapped_dek)}, ${s.kek_id}, ${s.aad}, ${Buffer.from(fp)})`;
    await tx`update provider_accounts set credential_id = ${credId}, display_hint = ${`…${secret.slice(-4)}`}, status = 'active',
      attention_reason = null, cooldown_until = null, updated_at = now() where id = ${acc.id}`;
    await tx`update credentials set wrapped_dek = null, rotated_at = now() where id = ${acc.credential_id}`;
    await tx`insert into outbox (aggregate, aggregate_id, event_type, payload) values ('provider_account', ${acc.id}, 'account.rotated', '{}')`;
    await tx`insert into audit_logs (id, tenant_id, actor_type, action, target_type, target_id, after)
      values (${Bun.randomUUIDv7()}, ${acc.tenant_id}, 'system', 'account.rotate_credential', 'provider_account', ${acc.id}, ${tx.json({ via: "scripts/connectors.ts rotate" })})`;
  });
  console.log(`token akun ${label} (${providerKey}) diganti (secret disegel, tidak dicetak; credential lama di-crypto-shred)`);
}

async function verify(key: string, query: string, samples: number, apply: boolean, maxItems = 10, windowHours = 24) {
  const c = registry.get(key) as Connector | undefined;
  if (!c) throw new Error(`connector ${key} tidak ada di registry`);
  const [row] =
    await sql`select c.id, c.config, pa.id as account_id, pa.tenant_id, cr.id as cred_id, cr.ciphertext, cr.iv, cr.wrapped_dek, cr.kek_id, cr.aad
    from connectors c join provider_accounts pa on pa.provider_id = c.provider_id and pa.status = 'active' join credentials cr on cr.id = pa.credential_id
    where c.key = ${key} order by pa.created_at limit 1`;
  if (!row) throw new Error("tidak ada akun aktif untuk provider connector ini (jalankan account)");
  const cred = await open<Record<string, string>>(
    kmsEnv(),
    {
      ciphertext: new Uint8Array(row.ciphertext),
      iv: new Uint8Array(row.iv),
      wrapped_dek: new Uint8Array(row.wrapped_dek),
      kek_id: row.kek_id,
      aad: row.aad,
    },
    credentialAad(row.cred_id, row.tenant_id),
  );
  const report = await runVerify(
    c,
    { credential: { kind: "api_key", secret: cred }, config: (row.config ?? {}) as Record<string, unknown> },
    { query, samples, maxItems, windowHours },
  );
  const op = report.operation;
  const file = `docs/evidence/verify/verify-${key}.json`;
  await Bun.write(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({ file, status: report.status, items: report.items_valid, cost_usd: report.cost_usd, p50: report.latency_ms.p50 }),
  );
  if (apply) {
    const measured = measuredOf(report);
    await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE smip_system`;
      await tx`update connector_capabilities set status = ${report.status}::e_verify_status, measured = measured || ${tx.json(measured as never)},
        verified_at = now(), evidence_ref = ${file} where connector_id = ${row.id} and operation = ${op}`;
      await tx`insert into outbox (aggregate, aggregate_id, event_type, payload) values ('connector_capability', ${row.id}, 'capability.verified', ${tx.json({ status: report.status } as never)})`;
    });
    console.log(`capability ${key}/${op} → ${report.status}`);
  }
}

try {
  if (cmd === "register") await register();
  else if (cmd === "account") await account(args[0]!, args[1]!, args[2]!, args[3]);
  else if (cmd === "rotate") await rotate(args[0]!, args[1]!, args[2]!, args[3]);
  else if (cmd === "verify") {
    const opt = (f: string, d: number) => (args.indexOf(f) >= 0 ? Number(args[args.indexOf(f) + 1]) : d);
    await verify(args[0]!, args[1]!, opt("--samples", 1), args.includes("--apply"), opt("--max-items", 10), opt("--window-hours", 24));
  } else throw new Error("perintah: register | account | rotate | verify (lihat header skrip)");
} finally {
  await sql.end();
}
