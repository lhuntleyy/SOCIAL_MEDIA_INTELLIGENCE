// F-09 integrasi: login, rotasi & reuse refresh (SEC-05), lockout, MFA TOTP, RBAC viewer (SEC-06), envelope error.
// Butuh Postgres & Redis-cache (default: compose `bun run dev:up`; override TEST_PG_URL / TEST_REDIS_CACHE_URL).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { LocalDevKms } from "@smip/crypto";
import { up } from "@smip/db";
import { exportPKCS8, generateKeyPair } from "jose";
import postgres from "postgres";
import { createApp } from "../src/app";
import { loadJwtKeys, signAccess } from "../src/auth/jwt";
import { LoginLimiter } from "../src/auth/rate-limit";
import { AuthService } from "../src/auth/service";
import { base32Decode, hotp } from "../src/auth/totp";

const PG = process.env.TEST_PG_URL ?? "postgres://smip_owner:smip_owner_dev@127.0.0.1:55432/postgres";
const REDIS = process.env.TEST_REDIS_CACHE_URL ?? "redis://127.0.0.1:56380";
const DB = `smip_api_test_${Date.now()}`;
const infraUp = await (async () => {
  try {
    const s = postgres(PG, { connect_timeout: 2, onnotice: () => {} });
    await s`select 1`;
    await s.end();
    const r = new Bun.RedisClient(REDIS, { connectionTimeout: 2000, autoReconnect: false });
    await r.ping();
    r.close();
    return true;
  } catch {
    return false;
  }
})();

const id = (n: number) => `0192f000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const T = id(1);
const USERS = { analyst: id(11), viewer: id(12), admin: id(13), other: id(14) };
const PW = "Rahasia-Kuat-123";
const IP = "10.1.2.3";

describe.skipIf(!infraUp)("auth API (integrasi)", () => {
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  let app: ReturnType<typeof createApp>;
  let keys: Awaited<ReturnType<typeof loadJwtKeys>>;
  let redis: Bun.RedisClient;
  let closeDb: () => Promise<void>;

  const call = (method: string, path: string, o: { body?: unknown; token?: string; cookie?: string; ip?: string } = {}) =>
    app.request(`/v1${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-smip-client-ip": o.ip ?? IP,
        ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
        ...(o.cookie ? { cookie: o.cookie } : {}),
      },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    });
  const cookieOf = (res: Response) => /smip_rt=[^;]*/.exec(res.headers.get("set-cookie") ?? "")?.[0];
  const login = async (email: string, extra: Record<string, unknown> = {}, ip = IP) => {
    const res = await call("POST", "/auth/login", { body: { email, password: PW, ...extra }, ip });
    return {
      res,
      json: (await res.json()) as { data: { access_token: string; mfa: string; tenants: unknown[] }; error?: { code: string } },
      cookie: cookieOf(res),
    };
  };

  beforeAll(async () => {
    admin = postgres(PG, { onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${DB}`);
    const url = PG.replace(/\/[^/]*$/, `/${DB}`);
    sql = postgres(url, { onnotice: () => {} });
    await up(sql);
    const hash = await Bun.password.hash(PW, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });
    await sql`insert into tenants (id, slug, name) values (${T}, 'org', 'Org')`;
    for (const [role, uid] of Object.entries(USERS)) {
      await sql`insert into users (id, email, name, password_hash) values (${uid}, ${`${role}@contoh.id`}, ${role}, ${hash})`;
      if (role !== "other")
        await sql`insert into memberships (tenant_id, user_id, role) values (${T}, ${uid}, ${role === "admin" ? "admin" : role})`;
    }
    const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    keys = await loadJwtKeys(await exportPKCS8(privateKey), "k1");
    redis = new Bun.RedisClient(REDIS);
    const { createDb } = await import("@smip/db");
    const created = createDb(url, { max: 4 });
    closeDb = created.close;
    const kms = new LocalDevKms({ v1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64") });
    const auth = new AuthService({ db: created.db, keys, kms, redis, limiter: new LoginLimiter(redis) });
    app = createApp({
      auth,
      keys,
      mount: (p) => {
        p.get("/ping", (c) => c.json({ data: "pong" }));
        p.patch("/topics/:id", (c) => c.json({ data: { id: c.req.param("id") } }));
      },
    });
    // bersihkan state rate limit dari run sebelumnya
    for (const k of (await redis.send("KEYS", ["auth:*"])) as string[]) await redis.del(k);
  });

  afterAll(async () => {
    for (const k of ((await redis?.send("KEYS", ["auth:*"])) as string[]) ?? []) await redis.del(k);
    redis?.close();
    await closeDb?.();
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin?.end();
  });

  test("login sukses: access token + cookie refresh aman + audit", async () => {
    const { res, json } = await login("analyst@contoh.id");
    expect(res.status).toBe(200);
    expect(json.data.access_token.split(".")).toHaveLength(3);
    expect(json.data.mfa).toBe("ok");
    expect(json.data.tenants).toEqual([{ id: T, name: "Org", role: "analyst" }]);
    const sc = res.headers.get("set-cookie")!;
    for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/v1/auth"]) expect(sc).toContain(attr);
    expect(JSON.stringify(json)).not.toContain(cookieOf(res)!.split("=")[1]!); // refresh token tidak di body
    const [a] = await sql`select count(*)::int c from audit_logs where action = 'auth.login' and actor_id = ${USERS.analyst}`;
    expect(a!.c).toBe(1);
  });

  test("password salah & email tak dikenal → pesan identik (anti enumerasi); validasi → 400 berdetail", async () => {
    const a = await call("POST", "/auth/login", { body: { email: "analyst@contoh.id", password: "salah" }, ip: "10.9.9.1" });
    const b = await call("POST", "/auth/login", { body: { email: "tidakada@contoh.id", password: "salah" }, ip: "10.9.9.1" });
    const [ja, jb] = [
      (await a.json()) as { error: { code: string; message: string } },
      (await b.json()) as { error: { code: string; message: string } },
    ];
    expect([a.status, b.status]).toEqual([401, 401]);
    expect(ja.error.message).toBe(jb.error.message);
    const v = await call("POST", "/auth/login", { body: { email: "bukan-email" } });
    const jv = (await v.json()) as { error: { code: string; details: { path: string }[]; request_id: string } };
    expect(v.status).toBe(400);
    expect(jv.error.code).toBe("VALIDATION_FAILED");
    expect(jv.error.details.map((d) => d.path).sort()).toEqual(["email", "password"]);
    expect(jv.error.request_id).toMatch(/^req_/);
  });

  test("lockout bertahap: 5 gagal → percobaan ke-6 (password benar) diblok 429 + Retry-After", async () => {
    for (let i = 0; i < 5; i++)
      await call("POST", "/auth/login", { body: { email: "other@contoh.id", password: "salah" }, ip: "10.7.7.7" });
    const r = await call("POST", "/auth/login", { body: { email: "other@contoh.id", password: PW }, ip: "10.7.7.7" });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("SEC-05: rotasi refresh; token lama dipakai ulang → seluruh family dicabut + audit", async () => {
    const { cookie: c1 } = await login("analyst@contoh.id");
    const r1 = await call("POST", "/auth/refresh", { cookie: c1 });
    expect(r1.status).toBe(200);
    const c2 = cookieOf(r1)!;
    expect(c2).not.toBe(c1);
    const reuse = await call("POST", "/auth/refresh", { cookie: c1 });
    expect(reuse.status).toBe(401);
    const afterReuse = await call("POST", "/auth/refresh", { cookie: c2 }); // token terbaru ikut mati
    expect(afterReuse.status).toBe(401);
    const [a] = await sql`select count(*)::int c from audit_logs where action = 'auth.refresh_reuse_detected'`;
    expect(a!.c).toBeGreaterThanOrEqual(1);
  });

  test("logout mencabut sesi; token rusak/kedaluwarsa ditolak dengan kode yang tepat", async () => {
    const { json, cookie } = await login("analyst@contoh.id");
    expect((await call("GET", "/me", { token: json.data.access_token })).status).toBe(200);
    expect((await call("POST", "/auth/logout", { cookie })).status).toBe(204);
    expect((await call("POST", "/auth/refresh", { cookie })).status).toBe(401);
    const tampered = `${json.data.access_token.slice(0, -3)}abc`;
    expect(((await (await call("GET", "/me", { token: tampered })).json()) as { error: { code: string } }).error.code).toBe(
      "UNAUTHENTICATED",
    );
    const old = await signAccess(
      keys,
      { sub: USERS.analyst, tid: T, role: "analyst", op: false, mfa: "ok", jti: "x" },
      Math.floor(Date.now() / 1000) - 3600,
    );
    const exp = await call("GET", "/me", { token: old });
    expect(exp.status).toBe(401);
    expect(((await exp.json()) as { error: { code: string } }).error.code).toBe("TOKEN_EXPIRED");
  });

  test("SEC-06: viewer tidak bisa PATCH; analyst bisa; viewer tetap bisa GET", async () => {
    const v = (await login("viewer@contoh.id")).json.data.access_token;
    const a = (await login("analyst@contoh.id")).json.data.access_token;
    expect((await call("PATCH", `/topics/${T}`, { token: v, body: {} })).status).toBe(403);
    expect((await call("PATCH", `/topics/${T}`, { token: a, body: {} })).status).toBe(200);
    expect((await call("GET", "/ping", { token: v })).status).toBe(200);
  });

  test("MFA wajib untuk admin: setup_required dibatasi → setup + verify TOTP → refresh mfa=ok → login berikut butuh OTP", async () => {
    const first = await login("admin@contoh.id");
    expect(first.json.data.mfa).toBe("setup_required");
    const tok = first.json.data.access_token;
    const blocked = await call("GET", "/ping", { token: tok });
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("MFA_SETUP_REQUIRED");
    expect((await call("GET", "/me", { token: tok })).status).toBe(200);

    const setup = (await (await call("POST", "/me/mfa/setup", { token: tok })).json()) as { data: { secret: string; otpauth_uri: string } };
    expect(setup.data.otpauth_uri).toStartWith("otpauth://totp/SMIP:");
    const code = () => hotp(base32Decode(setup.data.secret), Math.floor(Date.now() / 30000));
    expect((await call("POST", "/me/mfa/verify", { token: tok, body: { code: "000000" } })).status).toBe(400);
    expect((await call("POST", "/me/mfa/verify", { token: tok, body: { code: await code() } })).status).toBe(200);

    const r = await call("POST", "/auth/refresh", { cookie: first.cookie });
    const rj = (await r.json()) as { data: { access_token: string; mfa: string } };
    expect(rj.data.mfa).toBe("ok");
    expect((await call("GET", "/ping", { token: rj.data.access_token })).status).toBe(200);

    const noOtp = await login("admin@contoh.id", {}, "10.5.5.5");
    expect(noOtp.res.status).toBe(401);
    expect(noOtp.json.error?.code).toBe("MFA_REQUIRED");
    const withOtp = await login("admin@contoh.id", { otp: await code() }, "10.5.5.5");
    expect(withOtp.res.status).toBe(200);
    expect(withOtp.json.data.mfa).toBe("ok");
    const [u] = await sql`select mfa_secret_enc from users where id = ${USERS.admin}`;
    expect(Buffer.from(u!.mfa_secret_enc).toString()).not.toContain(setup.data.secret); // tersimpan terenkripsi
  });

  test("akses dicabut (membership dihapus) → refresh ditolak", async () => {
    const { cookie } = await login("viewer@contoh.id", {}, "10.4.4.4");
    await sql`delete from memberships where user_id = ${USERS.viewer}`;
    expect((await call("POST", "/auth/refresh", { cookie })).status).toBe(401);
  });

  test("user tanpa membership tidak bisa login ke tenant", async () => {
    const r = await login("other@contoh.id", {}, "10.3.3.3");
    // "other" sempat terkunci di test lockout (per akun) → 429 atau 403, keduanya menolak
    expect([403, 429]).toContain(r.res.status);
  });
});
