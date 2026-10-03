import { describe, expect, test } from "bun:test";
import { ConfigError, loadConfig } from "../src";

const BASE = {
  DATABASE_URL: "postgres://app@127.0.0.1:5433/smip",
  REDIS_URL: "redis://127.0.0.1:6390",
  REDIS_CACHE_URL: "redis://127.0.0.1:6391",
};
const CH = { CLICKHOUSE_URL: "http://127.0.0.1:8123" };
const KMS_DEV = { KMS_ADAPTER: "local-dev", KMS_KEY_ID: "dev", KMS_LOCAL_DEV_KEK_B64: "AAAA" };
const API = {
  JWT_PRIVATE_KEY_PATH: "/run/secrets/jwt.pem",
  JWT_KID: "k1",
  CORS_ORIGINS: "https://app.contoh.id, https://admin.contoh.id",
  CREDENTIAL_PEPPER_B64: Buffer.alloc(32, 7).toString("base64"),
};

function err(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e;
    throw e;
  }
  throw new Error("tidak melempar ConfigError");
}

describe("loadConfig", () => {
  test("service valid → default terisi & tipe ter-coerce", () => {
    const c = loadConfig("api", { ...BASE, ...CH, ...KMS_DEV, ...API, API_PORT: "9090" });
    expect(c.service).toBe("api");
    expect(c.NODE_ENV).toBe("development");
    expect(c.API_PORT).toBe(9090);
    expect(c.CORS_ORIGINS).toEqual(["https://app.contoh.id", "https://admin.contoh.id"]);
    expect(c.CLICKHOUSE_USER).toBe("default");
  });

  test("scheduler hanya butuh base; SCHEDULER_TICK_MS default 15000", () => {
    expect(loadConfig("scheduler", BASE).SCHEDULER_TICK_MS).toBe(15000);
  });

  test("variabel hilang dilaporkan semua sekaligus", () => {
    const e = err(() => loadConfig("worker-sink", { REDIS_URL: BASE.REDIS_URL }));
    const vars = e.issues.map((i) => i.variable).sort();
    expect(vars).toEqual(
      [
        "CLICKHOUSE_URL",
        "DATABASE_URL",
        "KMS_ADAPTER", // alert O-05 membuka secret saluran notifikasi
        "KMS_KEY_ID",
        "REDIS_CACHE_URL",
        "S3_ACCESS_KEY_ID",
        "S3_BUCKET_EXPORTS",
        "S3_BUCKET_RAW",
        "S3_BUCKET_TRAINING",
        "S3_ENDPOINT",
        "S3_SECRET_ACCESS_KEY",
      ].sort(),
    );
  });

  test("Redis queue dan cache tidak boleh sama", () => {
    const e = err(() => loadConfig("scheduler", { ...BASE, REDIS_CACHE_URL: BASE.REDIS_URL }));
    expect(e.issues[0]!.variable).toBe("REDIS_CACHE_URL");
  });

  test("KMS local-dev ditolak di produksi", () => {
    const e = err(() => loadConfig("api", { ...BASE, ...CH, ...KMS_DEV, ...API, NODE_ENV: "production" }));
    expect(e.issues.some((i) => i.variable === "KMS_ADAPTER" && i.message.includes("production"))).toBe(true);
  });

  test("vault-transit wajib VAULT_ADDR & VAULT_TOKEN", () => {
    const e = err(() => loadConfig("worker-health", { ...BASE, KMS_ADAPTER: "vault-transit", KMS_KEY_ID: "smip-kek" }));
    expect(e.issues.map((i) => i.variable)).toContain("VAULT_ADDR");
  });

  test("pesan error tidak pernah memuat nilai secret", () => {
    const secret = "postgres://app:SuperRahasia123@db";
    const e = err(() => loadConfig("scheduler", { ...BASE, DATABASE_URL: `${secret}:notaport/x`, REDIS_URL: "http://salah" }));
    expect(e.message).not.toContain("SuperRahasia123");
    expect(e.message).toContain("DATABASE_URL");
    expect(e.message).toContain("REDIS_URL");
  });

  test("service tidak dikenal ditolak", () => {
    expect(() => loadConfig("worker-ai", BASE)).toThrow(ConfigError);
  });

  test("profil workers (single-node) menggabungkan kebutuhan semua worker", () => {
    const e = err(() => loadConfig("workers", BASE));
    const vars = new Set(e.issues.map((i) => i.variable));
    for (const v of ["CLICKHOUSE_URL", "S3_ENDPOINT", "KMS_ADAPTER"]) expect(vars.has(v)).toBe(true);
  });
});
