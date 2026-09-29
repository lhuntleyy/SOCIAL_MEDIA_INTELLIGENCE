// Skema drizzle bertipe untuk query aplikasi. SUMBER KEBENARAN DDL = migrations/*.sql;
// file ini dicocokkan dengan DB hasil migrasi oleh test/schema-sync.test.ts (kolom & nullability).
// Tambahkan tabel di sini saat task yang memakainya dikerjakan (F-09 auth: identitas & tenancy).
import { sql } from "drizzle-orm";
import { boolean, customType, inet, pgEnum, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({ dataType: () => "bytea" });
const citext = customType<{ data: string }>({ dataType: () => "citext" });

/**
 * jsonb yang BENAR untuk driver bun-sql. `jsonb()` bawaan drizzle melakukan JSON.stringify lalu Bun.SQL meng-encode
 * string itu lagi → tersimpan sebagai STRING JSON ter-encode ganda (jsonb_typeof = 'string'; `->>` selalu NULL).
 * Bun.SQL sudah meng-encode objek/array/string dengan benar bila diberi nilai mentah; angka/boolean ditolak
 * (dianggap integer/boolean) → dibungkus to_jsonb(). Ditemukan & diuji 2026-09-28 (test/schema-sync.test.ts).
 */
const jsonb = customType<{ data: unknown; driverData: unknown }>({
  dataType: () => "jsonb",
  toDriver: (v) => (typeof v === "number" || typeof v === "boolean" ? sql`to_jsonb(${v})` : v),
  fromDriver: (v) => v,
});

export const eTenantStatus = pgEnum("e_tenant_status", ["active", "suspended", "closed"]);
export const eUserStatus = pgEnum("e_user_status", ["active", "disabled", "invited"]);
export const eRole = pgEnum("e_role", ["owner", "admin", "analyst", "viewer"]);
export const eActorType = pgEnum("e_actor_type", ["user", "api_key", "system"]);

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const plans = pgTable("plans", {
  id: uuid("id").primaryKey(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  limits: jsonb("limits").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey(),
  slug: citext("slug").notNull(),
  name: text("name").notNull(),
  status: eTenantStatus("status").notNull().default("active"),
  planId: uuid("plan_id"),
  timezone: text("timezone").notNull().default("Asia/Jakarta"),
  settings: jsonb("settings").notNull().default({}),
  /** 'platform' = rumah sesi owner platform (satu saja, tersembunyi dari daftar kantor) — migrasi 0022 */
  kind: text("kind").notNull().default("office"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  deletedAt: ts("deleted_at"),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  email: citext("email").notNull(),
  name: text("name").notNull(),
  passwordHash: text("password_hash"),
  mfaSecretEnc: bytea("mfa_secret_enc"),
  isPlatformOperator: boolean("is_platform_operator").notNull().default(false),
  status: eUserStatus("status").notNull().default("active"),
  lastLoginAt: ts("last_login_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const memberships = pgTable(
  "memberships",
  {
    tenantId: uuid("tenant_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: eRole("role").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId] })],
);

export const refreshTokens = pgTable("refresh_tokens", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  tokenHash: bytea("token_hash").notNull(),
  familyId: uuid("family_id").notNull(),
  tenantId: uuid("tenant_id"),
  expiresAt: ts("expires_at").notNull(),
  revokedAt: ts("revoked_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  ip: inet("ip"),
  userAgent: text("user_agent"),
});

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  keyHash: bytea("key_hash").notNull(),
  scopes: text("scopes").array().notNull().default([]),
  expiresAt: ts("expires_at"),
  lastUsedAt: ts("last_used_at"),
  revokedAt: ts("revoked_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").notNull(),
    tenantId: uuid("tenant_id"),
    actorType: eActorType("actor_type").notNull(),
    actorId: uuid("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    ip: inet("ip"),
    userAgent: text("user_agent"),
    requestId: text("request_id"),
    at: ts("at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.id, t.at] })],
);

export const ALL_TABLES = { plans, tenants, users, memberships, refreshTokens, apiKeys, auditLogs };
