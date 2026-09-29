// Review 2026-09-30 (I-21 follow-up): konsumen health.probe & connector.verify — sebelumnya job Admin API tanpa konsumen.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeConnector, fakeItem } from "@smip/connector-fake";
import { credentialAad, LocalDevKms, seal } from "@smip/crypto";
import { createDb, up } from "@smip/db";
import { MemoryBlobStore } from "@smip/storage";
import postgres from "postgres";
import { dbAccountLoader, handleHealthProbe, handleVerify } from "../src";

const PG = process.env.TEST_PG_URL ?? "postgres://smip_owner:smip_owner_dev@127.0.0.1:55432/postgres";
const pgUp = await (async () => {
  try {
    const s = postgres(PG, { connect_timeout: 2, onnotice: () => {} });
    await s`select 1`;
    await s.end();
    return true;
  } catch {
    return false;
  }
})();
const id = (n: number) => `0192f000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const [PROV, CONN, CONN_PY, ACC1, ACC2, CRED1, CRED2] = [1, 2, 3, 4, 5, 6, 7].map((n) => id(0x500 + n)) as [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

describe.skipIf(!pgUp)("ops: health.probe & connector.verify", () => {
  const name = `smip_ops_${Date.now()}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  let created: ReturnType<typeof createDb>;
  const kms = new LocalDevKms({ v1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64") });
  const fake = new FakeConnector({ platform: "x" });
  const recorded: unknown[][] = [];
  const blobs = new MemoryBlobStore();
  const deps = () => ({
    db: created.db,
    connectors: new Map([[fake.manifest.key, fake]]),
    accounts: dbAccountLoader(created.db, kms),
    blobs,
    monitor: { record: async (...a: unknown[]) => void recorded.push(a) } as never,
  });

  beforeAll(async () => {
    admin = postgres(PG, { onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const url = PG.replace(/\/[^/]*$/, `/${name}`);
    sql = postgres(url, { onnotice: () => {} });
    await up(sql);
    await sql`insert into platforms (code, name, icon, content_types, enabled) values ('x', 'X', 'x', '{post}', true)`;
    await sql`insert into providers (id, key, name, kind, risk_level, enabled) values (${PROV}, 'fake', 'Fake', 'third_party', 'low', true)`;
    await sql`insert into connectors (id, key, provider_id, platform_code, runtime, version, enabled) values
      (${CONN}, 'fake.x', ${PROV}, 'x', 'bun', '0.1.0', true), (${CONN_PY}, 'fake.x.py', ${PROV}, 'x', 'python', '0.1.0', true)`;
    await sql`insert into connector_capabilities (connector_id, operation, declared) values (${CONN}, 'search_keyword', '{}')`;
    for (const [acc, cred, status] of [
      [ACC1, CRED1, "active"],
      [ACC2, CRED2, "disabled"],
    ] as const) {
      const s = await seal(kms, credentialAad(cred, null), { api_key: `k-${acc}` });
      await sql`insert into credentials (id, kind, ciphertext, iv, wrapped_dek, kek_id, aad, fingerprint)
        values (${cred}, 'api_key', ${Buffer.from(s.ciphertext)}, ${Buffer.from(s.iv)}, ${Buffer.from(s.wrapped_dek)}, ${s.kek_id}, ${s.aad}, '\\x00')`;
      await sql`insert into provider_accounts (id, provider_id, label, credential_id, status) values (${acc}, ${PROV}, ${acc.slice(-3)}, ${cred}, ${status})`;
    }
    created = createDb(url, { max: 2 });
  });
  afterAll(async () => {
    await created?.close();
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin?.end();
  });

  test("health.probe: hanya akun aktif, hasil masuk circuit breaker + audit; connector runtime lain → unsupported", async () => {
    const r = await handleHealthProbe(deps(), { connector_id: CONN, requested_by: null, job_id: id(0x600) });
    expect(r.status).toBe("done");
    expect(r.results.map((x) => [x.account_id, x.ok])).toEqual([[ACC1, true]]);
    expect(recorded).toEqual([[CONN, ACC1, { ok: true, latencyMs: expect.any(Number), failureWeight: 0 }]]);
    fake.setHealthy(false);
    const bad = await handleHealthProbe(deps(), { connector_id: CONN, requested_by: null, job_id: id(0x601) });
    expect(bad.results[0]).toMatchObject({ ok: false });
    expect((recorded[1] as [string, string, { failureWeight: number }])[2].failureWeight).toBe(1);
    fake.setHealthy(true);
    expect((await handleHealthProbe(deps(), { connector_id: CONN_PY, requested_by: null, job_id: id(0x602) })).status).toBe("unsupported");
    const audits = await sql`select action, after from audit_logs where target_id = ${CONN} order by at`;
    expect(audits.map((a) => a.action)).toEqual(["connector.health_check.result", "connector.health_check.result"]);
  });

  test("connector.verify: laporan ke blob, apply → capability verified + outbox; tanpa apply capability tak berubah", async () => {
    // fake menjanjikan metrics.likes & author.followers → item harus mengisinya (≥ 80%) agar verified
    const recent = (n: number) => {
      const it = fakeItem("x", n, { published_at: new Date(Date.now() - n * 60_000).toISOString() });
      return { ...it, author: { ...it.author, followers: 100 + n } };
    };
    const base = { connector_id: CONN, requested_by: null, query: "kopdes", samples: 2, max_items: 5, window_hours: 24 };
    fake.script([{ respond: { items: [recent(1), recent(2)] } }, { respond: { items: [recent(3)] } }]);
    const dry = await handleVerify(deps(), { ...base, job_id: id(0x610), apply: false });
    expect(dry.status).toBe("verified");
    expect((await sql`select status from connector_capabilities where connector_id = ${CONN}`)[0]!.status).toBe("declared");
    fake.script([{ respond: { items: [recent(4)] } }, { respond: { items: [recent(5)] } }]);
    const r = await handleVerify(deps(), { ...base, job_id: id(0x611), apply: true });
    expect(r.ref).toStartWith("mem://verify/fake.x/");
    expect((await blobs.getJsonl<{ items_valid: number }>(r.ref!))[0]!.items_valid).toBe(2);
    const [cap] = await sql`select status, evidence_ref, measured from connector_capabilities where connector_id = ${CONN}`;
    expect([cap!.status, cap!.evidence_ref, cap!.measured.sample_size]).toEqual(["verified", r.ref, 2]);
    expect((await sql`select count(*)::int as n from outbox where aggregate = 'connector_capability'`)[0]!.n).toBe(1);
  });
});
