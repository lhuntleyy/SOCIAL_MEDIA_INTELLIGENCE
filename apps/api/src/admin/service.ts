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
const hashPassword = (p: string) => Bun.password.hash(p, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });

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
  /** Operator: semua kantor/tenant + ringkasan (jumlah user, topik aktif, nama topik) — "administrator melihat semua". */
  async listTenants() {
    return withSystem(this.db, async (tx) => {
      const rows = (await tx.execute(sql`
        select t.id, t.slug, t.name, t.status, t.plan_id, t.created_at,
               (select count(*)::int from memberships m join users u on u.id = m.user_id
                 where m.tenant_id = t.id and not u.is_platform_operator) as users,
               (select count(*)::int from topics tp where tp.tenant_id = t.id and tp.deleted_at is null) as topics,
               (select count(*)::int from topics tp where tp.tenant_id = t.id and tp.deleted_at is null and tp.status = 'active') as active_topics,
               (select coalesce(array_agg(tp.name order by tp.name), '{}') from topics tp where tp.tenant_id = t.id and tp.deleted_at is null) as topic_names
        from tenants t where t.deleted_at is null and t.kind = 'office' order by t.name`)) as unknown as Record<string, unknown>[];
      return rows;
    });
  }

  /** Operator: undang user (mis. admin kantor) langsung ke tenant tertentu tanpa impersonasi. */
  async inviteToTenant(a: Actor, tenantId: string, b: { email: string; name: string; role: Role; password?: string }) {
    if (!(await this.tenantExists(tenantId))) throw new ApiError("NOT_FOUND", "Tenant tidak ditemukan");
    return this.inviteUser({ ...a, tenantId }, b);
  }

  // ---------- owner platform (operator) ----------
  private async platformTenantId(tx: Tx): Promise<string> {
    const [r] = (await tx.execute(sql`select id from tenants where kind = 'platform' limit 1`)) as unknown as { id: string }[];
    if (!r) throw new ApiError("INTERNAL", "Tenant platform belum dibuat (migrasi 0022)");
    return r.id;
  }

  async listOwners() {
    return withSystem(this.db, async (tx) =>
      tx
        .select({ id: users.id, email: users.email, name: users.name, status: users.status, last_login_at: users.lastLoginAt })
        .from(users)
        .where(eq(users.isPlatformOperator, true))
        .orderBy(asc(users.email)),
    );
  }

  /** Tambah owner platform: user baru (password langsung / link undangan) atau user lama dinaikkan. */
  async addOwner(a: Actor, b: { email: string; name: string; password?: string }) {
    const hash = b.password ? await hashPassword(b.password) : null;
    const r = await withSystem(this.db, async (tx) => {
      const pt = await this.platformTenantId(tx);
      const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.email, b.email));
      const userId = existing?.id ?? Bun.randomUUIDv7();
      if (existing) await tx.update(users).set({ isPlatformOperator: true, updatedAt: new Date() }).where(eq(users.id, userId));
      else
        await tx.insert(users).values({
          id: userId,
          email: b.email,
          name: b.name,
          isPlatformOperator: true,
          status: hash ? "active" : "invited",
          passwordHash: hash,
        });
      await tx.execute(sql`insert into memberships (tenant_id, user_id, role) values (${pt}, ${userId}, 'owner') on conflict do nothing`);
      await this.audit(tx, a, "platform_owner.add", { type: "user", id: userId }, { new_user: !existing, password_set: !!hash }, pt);
      return { userId, isNew: !existing };
    });
    const token = r.isNew && !hash ? await this.newToken("invite", r.userId) : undefined;
    return { user_id: r.userId, status: r.isNew && !hash ? "invited" : "active", invite_token: token };
  }

  async removeOwner(a: Actor, userId: string) {
    if (userId === a.userId) throw new ApiError("CONFLICT", "Tidak bisa mencabut status owner diri sendiri");
    await withSystem(this.db, async (tx) => {
      const pt = await this.platformTenantId(tx);
      const r = await tx
        .update(users)
        .set({ isPlatformOperator: false, updatedAt: new Date() })
        .where(and(eq(users.id, userId), eq(users.isPlatformOperator, true)))
        .returning({ id: users.id });
      if (!r.length) throw new ApiError("NOT_FOUND", "Owner tidak ditemukan");
      try {
        await tx.execute(sql`delete from memberships where tenant_id = ${pt} and user_id = ${userId}`);
      } catch (e) {
        if (pgCode(e) === "23514") throw new ApiError("CONFLICT", "Harus ada minimal satu owner platform");
        throw e;
      }
      await tx.execute(sql`update refresh_tokens set revoked_at = now() where user_id = ${userId} and revoked_at is null`);
      await this.audit(tx, a, "platform_owner.remove", { type: "user", id: userId }, undefined, pt);
    });
  }

  /** Owner platform: semua user semua kantor (tanpa owner platform) + kantor & perannya. */
  async listAllUsers() {
    return withSystem(this.db, async (tx) => {
      return (await tx.execute(sql`
        select u.id, u.email, u.name, u.status, u.last_login_at,
               coalesce(json_agg(json_build_object('tenant_id', t.id, 'tenant', t.name, 'role', m.role) order by t.name)
                 filter (where t.id is not null), '[]') as offices
        from users u
        left join memberships m on m.user_id = u.id
        left join tenants t on t.id = m.tenant_id and t.kind = 'office' and t.deleted_at is null
        where not u.is_platform_operator
        group by u.id order by u.email`)) as unknown as Record<string, unknown>[];
    });
  }

  // ---------- password: set langsung / link reset ----------
  private async newToken(kind: "invite" | "reset", userId: string) {
    const token = randomB64(32);
    await this.redis.send("SET", [`auth:${kind}:${hex(await sha256(token))}`, userId, "EX", String(INVITE_TTL_SEC)]);
    return token;
  }

  /**
   * Admin kantor (atau owner platform) mengganti password user: `password` → langsung aktif; tanpa `password` → link
   * reset sekali pakai (72 jam). Admin kantor HANYA untuk user yang seluruh keanggotaannya di kantornya sendiri
   * (user yang juga anggota kantor lain / owner platform → ditolak, cegah pengambilalihan lintas kantor). Sesi lama dicabut.
   */
  async setPassword(a: Actor, userId: string, b: { password?: string }, by: { role: Role; op: boolean; crossTenant: boolean }) {
    if (userId === a.userId) throw new ApiError("CONFLICT", "Gunakan menu ganti password untuk akun sendiri");
    const hash = b.password ? await hashPassword(b.password) : null;
    await withSystem(this.db, async (tx) => {
      const [u] = await tx
        .select({ id: users.id, op: users.isPlatformOperator, status: users.status })
        .from(users)
        .where(eq(users.id, userId));
      if (!u) throw new ApiError("NOT_FOUND", "User tidak ditemukan");
      if (!by.crossTenant) {
        const ms = (await tx.execute(sql`select tenant_id, role from memberships where user_id = ${userId}`)) as unknown as {
          tenant_id: string;
          role: Role;
        }[];
        const here = ms.find((m) => m.tenant_id === a.tenantId);
        if (!here) throw new ApiError("NOT_FOUND", "User tidak ditemukan");
        if (u.op || ms.some((m) => m.tenant_id !== a.tenantId))
          throw new ApiError("FORBIDDEN", "User ini juga terdaftar di kantor lain — hubungi owner platform");
        if (here.role === "owner" && by.role !== "owner" && !by.op)
          throw new ApiError("FORBIDDEN", "Hanya admin utama yang dapat mengganti password admin utama");
      } else if (u.op && !by.op) throw new ApiError("FORBIDDEN", "Tidak diizinkan");
      if (hash) {
        await tx.update(users).set({ passwordHash: hash, status: "active", updatedAt: new Date() }).where(eq(users.id, userId));
        await tx.execute(sql`update refresh_tokens set revoked_at = now() where user_id = ${userId} and revoked_at is null`);
      }
      await this.audit(tx, a, hash ? "user.password_set" : "user.password_reset_link", { type: "user", id: userId });
    });
    return hash ? { status: "active" as const } : { reset_token: await this.newToken("reset", userId) };
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
        .where(eq(users.isPlatformOperator, false)) // owner platform tidak "berada" di kantor
        .orderBy(asc(users.email)),
    );
  }

  /** Undang: user baru → status invited + token undangan (72 jam, sekali pakai); user lama → cukup tambah membership. */
  async inviteUser(a: Actor, b: { email: string; name: string; role: Role; password?: string }) {
    const hash = b.password ? await hashPassword(b.password) : null;
    // smip_system: pencarian email lintas tenant (users ber-RLS untuk smip_app). Otorisasi admin tenant sudah di middleware;
    // semua tulisan memakai a.tenantId eksplisit. Respons tidak membedakan user lama/baru selain token undangan.
    const result = await withSystem(this.db, async (tx) => {
      const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.email, b.email));
      const userId = existing?.id ?? Bun.randomUUIDv7();
      // password diisi admin → langsung aktif (tanpa link undangan). Untuk user lama password TIDAK diubah.
      if (!existing)
        await tx
          .insert(users)
          .values({ id: userId, email: b.email, name: b.name, status: hash ? "active" : "invited", passwordHash: hash });
      try {
        await tx.insert(memberships).values({ tenantId: a.tenantId, userId, role: b.role });
      } catch (e) {
        if (pgCode(e) === "23505") throw new ApiError("CONFLICT", "User sudah menjadi anggota tenant ini");
        throw e;
      }
      await this.audit(tx, a, "user.invite", { type: "user", id: userId }, { role: b.role, new_user: !existing, password_set: !!hash });
      return { userId, isNew: !existing };
    });
    const inviteToken = result.isNew && !hash ? await this.newToken("invite", result.userId) : undefined;
    return {
      user_id: result.userId,
      status: inviteToken ? "invited" : "active",
      invite_token: inviteToken,
      ...(!result.isNew && hash ? { password_ignored: true } : {}),
    };
  }

  /** Link undangan (user baru) ATAU link reset password (user aktif) — keduanya sekali pakai. */
  async acceptInvite(token: string, password: string) {
    const h = hex(await sha256(token));
    let kind: "invite" | "reset" = "invite";
    let userId = await this.redis.get(`auth:invite:${h}`);
    if (!userId) {
      kind = "reset";
      userId = await this.redis.get(`auth:reset:${h}`);
    }
    if (!userId) throw new ApiError("UNAUTHENTICATED", "Link tidak valid atau kedaluwarsa");
    await this.redis.del(`auth:${kind}:${h}`); // sekali pakai
    const hash = await hashPassword(password);
    await withAuthRole(this.db, async (tx) => {
      const r = await tx
        .update(users)
        .set({ passwordHash: hash, status: "active", updatedAt: new Date() })
        .where(and(eq(users.id, userId), eq(users.status, kind === "invite" ? "invited" : "active")))
        .returning({ id: users.id });
      if (!r.length) throw new ApiError("CONFLICT", kind === "invite" ? "Undangan sudah dipakai" : "Akun tidak aktif");
    });
    if (kind === "reset")
      await withSystem(this.db, (tx) =>
        tx.execute(sql`update refresh_tokens set revoked_at = now() where user_id = ${userId} and revoked_at is null`),
      );
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
