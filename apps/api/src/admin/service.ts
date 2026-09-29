// F-10: admin tenant / user / membership / API key (API_SPEC §10). Semua mutasi diaudit (SECURITY §8).
import type { TenantId } from "@smip/core";
import {
  apiKeys,
  auditLogs,
  type Db,
  memberships,
  plans,
  type Tx,
  tenants,
  users,
  withAuthRole,
  withSystem,
  withTenant,
  writeOutbox,
} from "@smip/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { AccessClaims, Role } from "../auth/jwt";
import { ApiError } from "../errors";

export const API_KEY_SCOPES = [
  "analytics:read",
  "topics:read",
  "topics:write",
  "posts:read",
  "posts:write",
  "exports:write",
  "alerts:read",
  "alerts:write",
] as const;
const INVITE_TTL_SEC = 72 * 3600;

const sha256 = async (s: string) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))) as Uint8Array<ArrayBuffer>;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const randomB64 = (n: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("base64url");
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const randomB62 = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (x) => B62[x % 62]).join("");

function pgCode(e: unknown): string | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur; i++) {
    const c = cur as { code?: string; errno?: string; cause?: unknown };
    if (typeof c.errno === "string" && /^[0-9A-Z]{5}$/.test(c.errno)) return c.errno;
    if (typeof c.code === "string" && /^[0-9A-Z]{5}$/.test(c.code)) return c.code;
    cur = c.cause;
  }
  return undefined;
}

export interface Actor {
  userId: string;
  tenantId: string;
  ip?: string;
  ua?: string;
  requestId?: string;
}

export class AdminService {
  constructor(
    private readonly db: Db,
    private readonly redis: Bun.RedisClient,
  ) {}

  private async audit(tx: Tx, a: Actor, action: string, target: { type: string; id: string }, after?: unknown, tenantId?: string) {
    await tx.insert(auditLogs).values({
      id: Bun.randomUUIDv7(),
      tenantId: tenantId ?? a.tenantId,
      actorType: "user",
      actorId: a.userId,
      action,
      targetType: target.type,
      targetId: target.id,
      after: after ?? null,
      ip: a.ip ?? null,
      userAgent: a.ua ?? null,
      requestId: a.requestId ?? null,
    });
  }

  // ---------- operator: tenant ----------
  async listTenants() {
    return withSystem(this.db, (tx) =>
      tx
        .select({ id: tenants.id, slug: tenants.slug, name: tenants.name, status: tenants.status, plan_id: tenants.planId })
        .from(tenants)
        .orderBy(asc(tenants.name)),
    );
  }

  async createTenant(a: Actor, b: { slug: string; name: string; plan_code?: string; timezone?: string }) {
    return withSystem(this.db, async (tx) => {
      const [plan] = b.plan_code ? await tx.select({ id: plans.id }).from(plans).where(eq(plans.code, b.plan_code)) : [undefined];
      if (b.plan_code && !plan) throw new ApiError("VALIDATION_FAILED", "Plan tidak dikenal", [{ path: "plan_code", issue: "tidak ada" }]);
      const id = Bun.randomUUIDv7();
      try {
        await tx
          .insert(tenants)
          .values({ id, slug: b.slug, name: b.name, planId: plan?.id ?? null, timezone: b.timezone ?? "Asia/Jakarta" });
      } catch (e) {
        if (pgCode(e) === "23505") throw new ApiError("CONFLICT", "Slug tenant sudah dipakai");
        throw e;
      }
      await this.audit(tx, a, "tenant.create", { type: "tenant", id }, { slug: b.slug, name: b.name }, id);
      return { id, slug: b.slug, name: b.name, status: "active" as const };
    });
  }

  async updateTenant(
    a: Actor,
    id: string,
    b: { status?: "active" | "suspended" | "closed"; plan_code?: string; name?: string; deny_high_risk_providers?: boolean },
  ) {
    return withSystem(this.db, async (tx) => {
      const patch: Partial<typeof tenants.$inferInsert> = { updatedAt: new Date() };
      if (b.status) patch.status = b.status;
      if (b.name) patch.name = b.name;
      if (b.plan_code) {
        const [plan] = await tx.select({ id: plans.id }).from(plans).where(eq(plans.code, b.plan_code));
        if (!plan) throw new ApiError("VALIDATION_FAILED", "Plan tidak dikenal", [{ path: "plan_code", issue: "tidak ada" }]);
        patch.planId = plan.id;
      }
      if (b.deny_high_risk_providers !== undefined) {
        // opt-out provider berisiko tinggi (unofficial) — dibaca snapshot router (I-19); outbox → snapshot invalidasi
        patch.settings =
          sql`${tenants.settings} || ${JSON.stringify({ deny_high_risk_providers: b.deny_high_risk_providers })}::text::jsonb` as never;
        await writeOutbox(tx, { aggregate: "tenant", aggregateId: id, eventType: "tenant.risk_setting" });
      }
      const r = await tx.update(tenants).set(patch).where(eq(tenants.id, id)).returning({ id: tenants.id, status: tenants.status });
      if (!r.length) throw new ApiError("NOT_FOUND", "Tenant tidak ditemukan");
      await this.audit(tx, a, "tenant.update", { type: "tenant", id }, b, id);
      return r[0]!;
    });
  }

  async tenantExists(id: string): Promise<boolean> {
    return withSystem(
      this.db,
      async (tx) =>
        (
          await tx
            .select({ id: tenants.id })
            .from(tenants)
            .where(and(eq(tenants.id, id), isNull(tenants.deletedAt)))
        ).length > 0,
    );
  }

  async auditImpersonation(a: Actor, targetTenant: string, detail: { method: string; path: string; reason: string }) {
    await withSystem(this.db, (tx) =>
      this.audit(tx, a, "operator.impersonate", { type: "tenant", id: targetTenant }, detail, targetTenant),
    );
  }

  // ---------- tenant admin: user & membership (RLS tenant) ----------
  async listUsers(tenantId: TenantId) {
    return withTenant(this.db, tenantId, (tx) =>
      tx
        .select({ id: users.id, email: users.email, name: users.name, status: users.status, role: memberships.role })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .orderBy(asc(users.email)),
    );
  }

  /** Undang: user baru → status invited + token undangan (72 jam, sekali pakai); user lama → cukup tambah membership. */
  async inviteUser(a: Actor, b: { email: string; name: string; role: Role }) {
    // smip_system: pencarian email lintas tenant (users ber-RLS untuk smip_app). Otorisasi admin tenant sudah di middleware;
    // semua tulisan memakai a.tenantId eksplisit. Respons tidak membedakan user lama/baru selain token undangan.
    const result = await withSystem(this.db, async (tx) => {
      const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.email, b.email));
      const userId = existing?.id ?? Bun.randomUUIDv7();
      if (!existing) await tx.insert(users).values({ id: userId, email: b.email, name: b.name, status: "invited" });
      try {
        await tx.insert(memberships).values({ tenantId: a.tenantId, userId, role: b.role });
      } catch (e) {
        if (pgCode(e) === "23505") throw new ApiError("CONFLICT", "User sudah menjadi anggota tenant ini");
        throw e;
      }
      await this.audit(tx, a, "user.invite", { type: "user", id: userId }, { role: b.role, new_user: !existing });
      return { userId, isNew: !existing };
    });
    let inviteToken: string | undefined;
    if (result.isNew) {
      inviteToken = randomB64(32);
      await this.redis.send("SET", [`auth:invite:${hex(await sha256(inviteToken))}`, result.userId, "EX", String(INVITE_TTL_SEC)]);
    }
    return { user_id: result.userId, status: result.isNew ? "invited" : "active", invite_token: inviteToken };
  }

  async acceptInvite(token: string, password: string) {
    const key = `auth:invite:${hex(await sha256(token))}`;
    const userId = await this.redis.get(key);
    if (!userId) throw new ApiError("UNAUTHENTICATED", "Undangan tidak valid atau kedaluwarsa");
    await this.redis.del(key); // sekali pakai
    const hash = await Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });
    await withAuthRole(this.db, async (tx) => {
      const r = await tx
        .update(users)
        .set({ passwordHash: hash, status: "active", updatedAt: new Date() })
        .where(and(eq(users.id, userId), eq(users.status, "invited")))
        .returning({ id: users.id });
      if (!r.length) throw new ApiError("CONFLICT", "Undangan sudah dipakai");
    });
  }

  /** Menetapkan owner, atau mengubah user yang sedang owner, hanya boleh oleh owner/operator. */
  private async guardOwner(tx: Tx, userId: string, tenantId: string, newRole: Role | null, by: { role: Role; op: boolean }) {
    if (by.op || by.role === "owner") return;
    const [cur] = await tx
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId)));
    if (newRole === "owner" || cur?.role === "owner") throw new ApiError("FORBIDDEN", "Hanya owner yang dapat mengubah peran owner");
  }

  async updateMemberRole(a: Actor, userId: string, role: Role, by: { role: Role; op: boolean }) {
    return withTenant(this.db, a.tenantId as TenantId, async (tx) => {
      await this.guardOwner(tx, userId, a.tenantId, role, by);
      try {
        const r = await tx
          .update(memberships)
          .set({ role })
          .where(eq(memberships.userId, userId))
          .returning({ user_id: memberships.userId, role: memberships.role });
        if (!r.length) throw new ApiError("NOT_FOUND", "User bukan anggota tenant ini");
        await this.audit(tx, a, "membership.update", { type: "user", id: userId }, { role });
        return r[0]!;
      } catch (e) {
        if (pgCode(e) === "23514") throw new ApiError("CONFLICT", "Tenant harus punya minimal satu owner");
        throw e;
      }
    });
  }

  async setUserStatus(a: Actor, userId: string, status: "active" | "disabled") {
    return withSystem(this.db, async (tx) => {
      const r = await tx
        .update(users)
        .set({ status, updatedAt: new Date() })
        .where(eq(users.id, userId))
        .returning({ id: users.id, status: users.status });
      if (!r.length) throw new ApiError("NOT_FOUND", "User tidak ditemukan");
      await this.audit(tx, a, "user.status", { type: "user", id: userId }, { status });
      return r[0]!;
    });
  }

  /** Operator: tambah membership lintas tenant. */
  async addMembership(a: Actor, userId: string, tenantId: string, role: Role) {
    return withSystem(this.db, async (tx) => {
      try {
        await tx.insert(memberships).values({ tenantId, userId, role });
      } catch (e) {
        const code = pgCode(e);
        if (code === "23505") throw new ApiError("CONFLICT", "Membership sudah ada");
        if (code === "23503") throw new ApiError("NOT_FOUND", "User atau tenant tidak ditemukan");
        throw e;
      }
      await this.audit(tx, a, "membership.create", { type: "user", id: userId }, { role }, tenantId);
      return { user_id: userId, tenant_id: tenantId, role };
    });
  }

  /** Tenant admin (tenant sendiri, via RLS) atau operator (tenant mana pun). */
  async removeMembership(a: Actor, userId: string, tenantId: string, by: { role: Role; op: boolean; crossTenant: boolean }) {
    const run = async (tx: Tx) => {
      await this.guardOwner(tx, userId, tenantId, null, by);
      try {
        const r = await tx
          .delete(memberships)
          .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId)))
          .returning({ u: memberships.userId });
        if (!r.length) throw new ApiError("NOT_FOUND", "Membership tidak ditemukan");
        await this.audit(tx, a, "membership.delete", { type: "user", id: userId }, undefined, tenantId);
      } catch (e) {
        if (pgCode(e) === "23514") throw new ApiError("CONFLICT", "Tenant harus punya minimal satu owner");
        throw e;
      }
    };
    if (by.crossTenant) return withSystem(this.db, run);
    if (tenantId !== a.tenantId) throw new ApiError("NOT_FOUND", "Membership tidak ditemukan");
    return withTenant(this.db, a.tenantId as TenantId, run);
  }

  // ---------- API key ----------
  async listApiKeys(tenantId: TenantId) {
    return withTenant(this.db, tenantId, (tx) =>
      tx
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          prefix: apiKeys.prefix,
          scopes: apiKeys.scopes,
          expires_at: apiKeys.expiresAt,
          last_used_at: apiKeys.lastUsedAt,
          revoked_at: apiKeys.revokedAt,
          created_at: apiKeys.createdAt,
        })
        .from(apiKeys)
        .orderBy(asc(apiKeys.createdAt)),
    );
  }

  /** Secret hanya dikembalikan SEKALI saat dibuat; DB menyimpan SHA-256 (DATA_MODEL §2.6). */
  async createApiKey(a: Actor, b: { name: string; scopes: string[]; expires_at?: string }) {
    const prefix = randomB62(8);
    const secret = `smip_${prefix}_${randomB64(32)}`;
    const id = Bun.randomUUIDv7();
    await withTenant(this.db, a.tenantId as TenantId, async (tx) => {
      await tx.insert(apiKeys).values({
        id,
        tenantId: a.tenantId,
        name: b.name,
        prefix,
        keyHash: await sha256(secret),
        scopes: b.scopes,
        expiresAt: b.expires_at ? new Date(b.expires_at) : null,
      });
      await this.audit(tx, a, "api_key.create", { type: "api_key", id }, { name: b.name, scopes: b.scopes, prefix });
    });
    return { id, name: b.name, prefix, scopes: b.scopes, secret };
  }

  async revokeApiKey(a: Actor, id: string) {
    await withTenant(this.db, a.tenantId as TenantId, async (tx) => {
      const r = await tx
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
        .returning({ id: apiKeys.id });
      if (!r.length) throw new ApiError("NOT_FOUND", "API key tidak ditemukan");
      await this.audit(tx, a, "api_key.revoke", { type: "api_key", id });
    });
  }

  /** Verifikasi header X-API-Key → klaim akses. null = tidak valid (pesan generik di authn). */
  async verifyApiKey(raw: string): Promise<AccessClaims | null> {
    const m = /^smip_([0-9A-Za-z]{8})_[A-Za-z0-9_-]{43}$/.exec(raw);
    if (!m) return null;
    const hash = await sha256(raw);
    return withAuthRole(this.db, async (tx) => {
      const [k] = await tx
        .select({
          id: apiKeys.id,
          tenantId: apiKeys.tenantId,
          keyHash: apiKeys.keyHash,
          scopes: apiKeys.scopes,
          expiresAt: apiKeys.expiresAt,
          revokedAt: apiKeys.revokedAt,
          lastUsedAt: apiKeys.lastUsedAt,
          status: tenants.status,
        })
        .from(apiKeys)
        .innerJoin(tenants, eq(tenants.id, apiKeys.tenantId))
        .where(eq(apiKeys.prefix, m[1]!));
      if (!k || k.revokedAt || (k.expiresAt && k.expiresAt.getTime() <= Date.now()) || k.status !== "active") return null;
      if (!crypto.timingSafeEqual(Buffer.from(k.keyHash), Buffer.from(hash))) return null;
      if (!k.lastUsedAt || Date.now() - k.lastUsedAt.getTime() > 300_000) {
        await tx.update(apiKeys).set({ lastUsedAt: sql`now()` }).where(eq(apiKeys.id, k.id));
      }
      const write = k.scopes.some((s) => s.endsWith(":write"));
      return {
        sub: k.id,
        tid: k.tenantId,
        role: write ? "analyst" : "viewer",
        op: false,
        mfa: "ok",
        jti: k.id,
        kind: "api_key",
        scopes: k.scopes,
      } satisfies AccessClaims;
    });
  }
}
