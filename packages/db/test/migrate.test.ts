// F-04 integrasi: migrasi up/down + RLS (SEC-01 subset) + constraint. Butuh Postgres :5433 (scripts/spike-infra.sh start).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { down, loadMigrations, status, up } from "../src";

// default: Postgres compose (`bun run dev:up`); override TEST_PG_URL (mis. spike: postgres://postgres@127.0.0.1:5433/postgres)
const PG_URL = new URL(process.env.TEST_PG_URL ?? "postgres://smip_owner:smip_owner_dev@127.0.0.1:55432/postgres");
const HOST = {
  host: PG_URL.hostname,
  port: Number(PG_URL.port),
  user: decodeURIComponent(PG_URL.username),
  password: PG_URL.password ? decodeURIComponent(PG_URL.password) : undefined,
  onnotice: () => {},
};
const DB = `smip_test_${Date.now()}`;
const pgUp = await (async () => {
  const s = postgres({ ...HOST, database: "postgres", connect_timeout: 2 });
  try {
    await s`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await s.end();
  }
})();

const A = "0192f000-0000-7000-8000-00000000000a";
const B = "0192f000-0000-7000-8000-00000000000b";
/** postgres-js query = lazy thenable; `expect().rejects` Bun tidak men-trigger-nya → bungkus jadi Promise nyata. */
const run = (q: PromiseLike<unknown>) => new Promise<unknown>((res, rej) => q.then(res, rej));
const id = (n: number) => `0192f000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const U = id(0x100);

describe.skipIf(!pgUp)("db migrations & RLS (integrasi Postgres)", () => {
  let admin: postgres.Sql;
  let sql: postgres.Sql;

  /** Jalankan sebagai role aplikasi dengan konteks tenant (pola API, S-08). */
  const asApp = <T>(tenant: string | null, fn: (tx: postgres.TransactionSql) => Promise<T>) =>
    sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE smip_app`;
      if (tenant) await tx`select set_config('app.tenant_id', ${tenant}, true)`;
      return fn(tx);
    }) as Promise<T>;
  const asRole = <T>(role: string, fn: (tx: postgres.TransactionSql) => Promise<T>) =>
    sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${role}`);
      return fn(tx);
    }) as Promise<T>;

  beforeAll(async () => {
    admin = postgres({ ...HOST, database: "postgres" });
    await admin.unsafe(`CREATE DATABASE ${DB}`);
    sql = postgres({ ...HOST, database: DB, max: 2 });
  });
  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin?.end();
  });

  test("up menerapkan semua migrasi; down --to 0 bersih; up lagi idempoten", async () => {
    const all = await loadMigrations();
    expect(await up(sql)).toEqual(all.map((m) => m.version));
    expect((await status(sql)).pending).toHaveLength(0);
    expect(await down(sql, { to: 0 })).toEqual(all.map((m) => m.version).reverse());
    const [left] = await sql<{ t: number; e: number; f: number }[]>`
      select (select count(*) from pg_tables where schemaname = 'public' and tablename <> 'smip_schema_migrations')::int t,
             (select count(*) from pg_type where typname like 'e\\_%')::int e,
             (select count(*) from pg_proc where proname like 'smip\\_%')::int f`;
    expect(left).toEqual({ t: 0, e: 0, f: 0 });
    expect(await up(sql)).toHaveLength(all.length);
    expect(await up(sql)).toHaveLength(0);
  });

  test("migrasi yang diedit setelah diterapkan ditolak (checksum)", async () => {
    const all = await loadMigrations();
    const tampered = all.map((m) => (m.version === 2 ? { ...m, checksum: "deadbeef" } : m));
    await expect(status(sql, tampered)).rejects.toThrow(/checksum/);
  });

  describe("RLS & grant (SEC-01 subset)", () => {
    beforeAll(async () => {
      // seed sebagai pemilik skema (superuser tidak tunduk RLS)
      await sql`insert into tenants (id, slug, name) values (${A}, 'org-a', 'Org A'), (${B}, 'org-b', 'Org B')`;
      await sql`insert into users (id, email, name, password_hash) values (${U}, 'a@contoh.id', 'Analis A', '$argon2id$rahasia')`;
      await sql`insert into platforms (code, name, icon, content_types, enabled) values ('x', 'X', 'x', '{post}', true)`;
      await sql`insert into topics (id, tenant_id, name) values (${id(1)}, ${A}, 'Topik A'), (${id(2)}, ${B}, 'Topik B')`;
      await sql`insert into routing_policies (id, tenant_id, platform_code, operation) values
        (${id(10)}, null, 'x', 'search_keyword'), (${id(11)}, ${A}, 'x', 'search_hashtag'), (${id(12)}, ${B}, 'x', 'search_hashtag')`;
      await sql`insert into providers (id, key, name, kind, risk_level, enabled) values (${id(20)}, 'fake', 'Fake', 'third_party', 'low', true)`;
      await sql`insert into connectors (id, key, provider_id, platform_code, runtime, version) values (${id(21)}, 'fake.x', ${id(20)}, 'x', 'bun', '0.1.0')`;
      await sql`insert into routing_rules (id, policy_id, connector_id, priority, weight) values
        (${id(30)}, ${id(10)}, ${id(21)}, 1, 100), (${id(31)}, ${id(12)}, ${id(21)}, 1, 100)`;
      const cred = (cid: number, tenant: string | null) =>
        sql`insert into credentials (id, tenant_id, kind, ciphertext, iv, wrapped_dek, kek_id, aad, fingerprint)
            values (${id(cid)}, ${tenant}, 'api_key', '\\x00', ${Buffer.alloc(12)}, '\\x00', 'local:v1', 'x', '\\x00')`;
      await cred(40, null);
      await cred(41, A);
      await cred(42, B);
    });

    test("tenant A hanya melihat datanya; tenants hanya dirinya", async () => {
      const r = await asApp(A, async (tx) => ({
        topics: (await tx`select name from topics`).map((x) => x.name),
        tenants: (await tx`select slug from tenants`).map((x) => x.slug),
      }));
      expect(r).toEqual({ topics: ["Topik A"], tenants: ["org-a"] });
    });

    test("tanpa konteks tenant → 0 baris (deny), BUKAN error (fix nullif S-08)", async () => {
      expect(await asApp(null, async (tx) => (await tx`select count(*)::int c from topics`)[0]!.c)).toBe(0);
    });

    test("tulis ke tenant lain ditolak (WITH CHECK) & update lintas tenant tidak berefek", async () => {
      await expect(asApp(A, (tx) => tx`insert into topics (id, tenant_id, name) values (${id(3)}, ${B}, 'Selundup')`)).rejects.toThrow(
        /row-level security/,
      );
      const n = await asApp(A, async (tx) => (await tx`update topics set name = 'dibajak' where id = ${id(2)}`).count);
      expect(n).toBe(0);
    });

    test("routing: policy global + milik sendiri terlihat, milik B tidak; policy global tidak bisa ditulis tenant", async () => {
      const r = await asApp(A, async (tx) => ({
        policies: (await tx`select id from routing_policies order by id`).map((x) => x.id),
        rules: (await tx`select id from routing_rules order by id`).map((x) => x.id),
      }));
      expect(r).toEqual({ policies: [id(10), id(11)], rules: [id(30)] });
      await expect(
        asApp(
          A,
          (tx) => tx`insert into routing_policies (id, tenant_id, platform_code, operation) values (${id(13)}, null, 'x', 'profile')`,
        ),
      ).rejects.toThrow(/row-level security/);
    });

    test("credentials: tenant hanya BYO miliknya (operator/tenant lain tak terlihat); py_reader melihat semua", async () => {
      expect(await asApp(A, async (tx) => (await tx`select id from credentials`).map((x) => x.id))).toEqual([id(41)]);
      expect(await asRole("smip_py_reader", async (tx) => (await tx`select count(*)::int c from credentials`)[0]!.c)).toBe(3);
      await expect(asRole("smip_py_reader", (tx) => tx`delete from credentials`)).rejects.toThrow(/permission denied/);
    });

    test("users ber-RLS (migrasi 0009): tenant hanya melihat anggotanya; kolom rahasia tetap tak terbaca", async () => {
      expect(await asApp(A, async (tx) => (await tx`select name from users`).map((x) => x.name))).toEqual([]); // U belum anggota A
      await sql`insert into memberships (tenant_id, user_id, role) values (${A}, ${U}, 'analyst')`;
      expect(await asApp(A, async (tx) => (await tx`select name from users`).map((x) => x.name))).toEqual(["Analis A"]);
      expect(await asApp(B, async (tx) => (await tx`select count(*)::int c from users`)[0]!.c)).toBe(0);
      await expect(asApp(A, (tx) => tx`select password_hash from users`)).rejects.toThrow(/permission denied/);
    });

    test("audit_logs append-only: tenant insert miliknya, tak bisa insert tenant lain; UPDATE/DELETE ditolak bahkan untuk superuser", async () => {
      await asApp(
        A,
        (tx) => tx`insert into audit_logs (id, tenant_id, actor_type, action) values (${id(50)}, ${A}, 'user', 'topic.create')`,
      );
      await expect(
        asApp(A, (tx) => tx`insert into audit_logs (id, tenant_id, actor_type, action) values (${id(51)}, ${B}, 'user', 'x')`),
      ).rejects.toThrow(/row-level security/);
      await expect(run(sql`update audit_logs set action = 'ubah'`)).rejects.toThrow(/append-only/);
      await expect(run(sql`delete from audit_logs`)).rejects.toThrow(/append-only/);
      await expect(asRole("smip_system", (tx) => tx`delete from audit_logs`)).rejects.toThrow(/permission denied|append-only/);
    });
  });

  describe("constraint & partisi", () => {
    const planId = id(60);
    beforeAll(async () => {
      await sql`insert into topic_queries (id, tenant_id, topic_id, kind, query_text, query_ast, ast_hash) values
        (${id(61)}, ${A}, ${id(1)}, 'main', '"kdmp"', '{"type":"phrase","value":"kdmp"}', '\\x01')`;
      await sql`insert into crawl_plans (id, tenant_id, topic_id, topic_query_id, platform_code, operation, interval_sec, next_run_at)
        values (${planId}, ${A}, ${id(1)}, ${id(61)}, 'x', 'search_keyword', 900, now())`;
    });

    test("interval hanya 5m/15m/30m/45m/1h (10m ditolak)", async () => {
      await expect(run(sql`update topics set default_interval_sec = 600 where id = ${id(1)}`)).rejects.toThrow(/check constraint/);
    });

    test("crawl_runs: tepat satu pemilik (plan XOR stream); run plan wajib tenant", async () => {
      await expect(run(sql`insert into crawl_runs (id, scheduled_for, kind) values (${id(70)}, now(), 'incremental')`)).rejects.toThrow(
        /crawl_runs_owner_ck/,
      );
      await expect(
        run(sql`insert into crawl_runs (id, crawl_plan_id, scheduled_for, kind) values (${id(70)}, ${planId}, now(), 'incremental')`),
      ).rejects.toThrow(/crawl_runs_tenant_ck/);
    });

    test("FK ke tabel partisi (id, scheduled_for); run tanpa induk ditolak", async () => {
      const at = new Date();
      await sql`insert into crawl_runs (id, tenant_id, crawl_plan_id, scheduled_for, kind) values (${id(71)}, ${A}, ${planId}, ${at}, 'incremental')`;
      await sql`insert into provider_attempts (id, crawl_run_id, crawl_run_scheduled_for, tenant_id, connector_id, attempt_no, started_at, outcome)
        values (${id(72)}, ${id(71)}, ${at}, ${A}, ${id(21)}, 1, now(), 'success')`;
      await expect(
        run(sql`insert into provider_attempts (id, crawl_run_id, crawl_run_scheduled_for, connector_id, attempt_no, started_at, outcome)
            values (${id(73)}, ${id(99)}, ${at}, ${id(21)}, 1, now(), 'success')`),
      ).rejects.toThrow(/foreign key/);
    });

    test("partisi bulanan terisi; tanggal jauh masuk partisi DEFAULT; fungsi partisi idempoten", async () => {
      const far = new Date("2030-01-15T00:00:00Z");
      await sql`insert into crawl_runs (id, tenant_id, crawl_plan_id, scheduled_for, kind) values (${id(74)}, ${A}, ${planId}, ${far}, 'backfill')`;
      const [p] = await sql`select tableoid::regclass::text t from crawl_runs where id = ${id(74)}`;
      expect(p!.t).toBe("crawl_runs_default");
      const [now] = await sql`select tableoid::regclass::text t from crawl_runs where id = ${id(71)}`;
      expect(now!.t).toMatch(/^crawl_runs_y\d{4}m\d{2}$/);
      const [again] = await sql`select smip_ensure_monthly_partitions('crawl_runs', date_trunc('month', now())::date, 2) n`;
      expect(again!.n).toBe(0);
    });

    test("aturan data: unofficial wajib high risk; capability verified wajib evidence; nlp_labels tanpa below_18 & teks di bucket training", async () => {
      await expect(
        run(sql`insert into providers (id, key, name, kind, risk_level) values (${id(80)}, 'instagrapi', 'x', 'unofficial', 'low')`),
      ).rejects.toThrow(/providers_unofficial_high_risk/);
      await expect(
        run(
          sql`insert into connector_capabilities (connector_id, operation, declared, status) values (${id(21)}, 'search_keyword', '{}', 'verified')`,
        ),
      ).rejects.toThrow(/capabilities_verified_evidence/);
      await expect(
        run(sql`insert into nlp_labels (id, platform, post_id, task, text_ref, label, source, model_version)
            values (${id(81)}, 'x', '1', 'age_range', 's3://smip-training/x/1.txt', 'below_18', 'model', 'v1')`),
      ).rejects.toThrow(/check constraint/);
      await expect(
        run(sql`insert into nlp_labels (id, platform, post_id, task, text_ref, label, source, model_version)
            values (${id(82)}, 'x', '1', 'sentiment', 's3://smip-raw/raw/x/1.json.gz', 'negative', 'model', 'v1')`),
      ).rejects.toThrow(/check constraint/);
    });

    test("routing_policies: satu policy global per (platform, operation)", async () => {
      await expect(
        run(sql`insert into routing_policies (id, tenant_id, platform_code, operation) values (${id(90)}, null, 'x', 'search_keyword')`),
      ).rejects.toThrow(/routing_policies_uniq/);
    });
  });
});
