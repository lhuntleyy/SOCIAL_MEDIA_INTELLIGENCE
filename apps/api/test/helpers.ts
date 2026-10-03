// Harness test integrasi API: DB baru per suite (migrasi penuh), Redis-cache compose, kunci JWT in-memory.
import { LocalDevKms } from "@smip/crypto";
import { createDb, type Db, up } from "@smip/db";
import { exportPKCS8, generateKeyPair } from "jose";
import postgres from "postgres";
import { AdminService } from "../src/admin/service";
import { type AppDeps, createApp } from "../src/app";
import { type AccessClaims, type JwtKeys, loadJwtKeys, signAccess } from "../src/auth/jwt";
import { LoginLimiter } from "../src/auth/rate-limit";
import { AuthService } from "../src/auth/service";

export const PG = process.env.TEST_PG_URL ?? "postgres://smip_owner:smip_owner_dev@127.0.0.1:55432/postgres";
export const REDIS = process.env.TEST_REDIS_CACHE_URL ?? "redis://127.0.0.1:56380";

export async function infraUp(): Promise<boolean> {
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
}

export const tid = (n: number) => `0192f000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

export interface ApiHarness {
  sql: postgres.Sql;
  app: ReturnType<typeof createApp>;
  keys: JwtKeys;
  redis: Bun.RedisClient;
  token: (c: Partial<AccessClaims> & { sub: string; tid: string; role: AccessClaims["role"] }) => Promise<string>;
  call: (
    method: string,
    path: string,
    o?: { body?: unknown; token?: string; headers?: Record<string, string>; signal?: AbortSignal },
  ) => Promise<Response>;
  close: () => Promise<void>;
}

export async function apiHarness(name: string, mount?: AppDeps["mount"], extra?: (db: Db) => Partial<AppDeps>): Promise<ApiHarness> {
  const db = `smip_${name}_${Date.now()}`;
  const admin = postgres(PG, { onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${db}`);
  const url = PG.replace(/\/[^/]*$/, `/${db}`);
  const sql = postgres(url, { onnotice: () => {} });
  await up(sql);
  const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const keys = await loadJwtKeys(await exportPKCS8(privateKey), "k1");
  const redis = new Bun.RedisClient(REDIS);
  const created = createDb(url, { max: 4 });
  const kms = new LocalDevKms({ v1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64") });
  const auth = new AuthService({ db: created.db, keys, kms, redis, limiter: new LoginLimiter(redis) });
  const app = createApp({ auth, admin: new AdminService(created.db, redis), keys, mount, ...extra?.(created.db) });
  return {
    sql,
    app,
    keys,
    redis,
    token: (c) => signAccess(keys, { op: false, mfa: "ok", jti: Bun.randomUUIDv7(), ...c }),
    call: async (method, path, o = {}) =>
      await app.request(`/v1${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          "x-smip-client-ip": "10.0.0.1",
          ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
          ...o.headers,
        },
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        ...(o.signal ? { signal: o.signal } : {}),
      }),
    close: async () => {
      redis.close();
      await created.close();
      await sql.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await admin.end();
    },
  };
}
