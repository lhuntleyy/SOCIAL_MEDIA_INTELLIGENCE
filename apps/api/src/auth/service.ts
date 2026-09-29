// F-09: layanan autentikasi (SECURITY §2, API_SPEC §2). Semua akses DB lewat withAuthRole (role smip_auth).
import { type KmsAdapter, open, seal } from "@smip/crypto";
import { auditLogs, type Db, memberships, refreshTokens, type Tx, tenants, users, withAuthRole } from "@smip/db";
import type { Logger } from "@smip/observability";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { ApiError } from "../errors";
import { ACCESS_TTL_SEC, type AccessClaims, type JwtKeys, type Role, signAccess } from "./jwt";
import type { LoginLimiter } from "./rate-limit";
import { newTotpSecret, otpauthUri, verifyTotp } from "./totp";

export const REFRESH_TTL_SEC = 14 * 86_400;
const MFA_REQUIRED_ROLES: Role[] = ["owner", "admin"];
// Hash tiruan: verifikasi tetap dijalankan walau user tidak ada → waktu respons tidak membocorkan keberadaan email.
const DUMMY_HASH = await Bun.password.hash("dummy-password-for-timing", { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });

export interface AuthDeps {
  db: Db;
  keys: JwtKeys;
  kms: KmsAdapter;
  limiter: LoginLimiter;
  redis: Bun.RedisClient;
  logger?: Logger;
  now?: () => Date;
}

export interface Issued {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  mfa: AccessClaims["mfa"];
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64")) as Uint8Array<ArrayBuffer>;
async function sha256(s: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}
const mfaAad = (userId: string) => `mfa:${userId}`;

async function sealMfa(kms: KmsAdapter, userId: string, secret: string): Promise<Uint8Array<ArrayBuffer>> {
  const s = await seal(kms, mfaAad(userId), { secret });
  const json = JSON.stringify({ c: b64(s.ciphertext), i: b64(s.iv), w: b64(s.wrapped_dek), k: s.kek_id, a: s.aad });
  return new TextEncoder().encode(json);
}
async function openMfa(kms: KmsAdapter, userId: string, blob: Uint8Array): Promise<string> {
  const j = JSON.parse(new TextDecoder().decode(blob)) as { c: string; i: string; w: string; k: string; a: string };
  const r = await open<{ secret: string }>(
    kms,
    { ciphertext: unb64(j.c), iv: unb64(j.i), wrapped_dek: unb64(j.w), kek_id: j.k, aad: j.a },
    mfaAad(userId),
  );
  return r.secret;
}

export class AuthService {
  constructor(private readonly d: AuthDeps) {}
  private now() {
    return this.d.now?.() ?? new Date();
  }

  private async audit(
    tx: Tx,
    action: string,
    e: { tenantId: string | null; actorId: string | null; ip?: string; ua?: string; after?: unknown },
  ) {
    await tx.insert(auditLogs).values({
      id: Bun.randomUUIDv7(),
      tenantId: e.tenantId,
      actorType: e.actorId ? "user" : "system",
      actorId: e.actorId,
      action,
      targetType: "user",
      targetId: e.actorId,
      after: e.after ?? null,
      ip: e.ip ?? null,
      userAgent: e.ua ?? null,
      at: this.now(),
    });
  }

  private async memberTenants(tx: Tx, userId: string) {
    return tx
      .select({ id: tenants.id, name: tenants.name, role: memberships.role, kind: tenants.kind })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(and(eq(memberships.userId, userId), eq(tenants.status, "active"), isNull(tenants.deletedAt)))
      .orderBy(asc(tenants.name));
  }

  private async issue(
    tx: Tx,
    u: { id: string; op: boolean; hasMfa: boolean },
    tenant: { id: string; role: Role },
    family: string,
    meta: { ip?: string; ua?: string },
  ): Promise<Issued> {
    const needMfa = u.op || MFA_REQUIRED_ROLES.includes(tenant.role);
    const mfa: AccessClaims["mfa"] = needMfa && !u.hasMfa ? "setup_required" : "ok";
    const refreshToken = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const now = this.now();
    await tx.insert(refreshTokens).values({
      id: Bun.randomUUIDv7(),
      userId: u.id,
      tokenHash: await sha256(refreshToken),
      familyId: family,
      tenantId: tenant.id,
      expiresAt: new Date(now.getTime() + REFRESH_TTL_SEC * 1000),
      ip: meta.ip ?? null,
      userAgent: meta.ua?.slice(0, 300) ?? null,
      createdAt: now,
    });
    const accessToken = await signAccess(
      this.d.keys,
      { sub: u.id, tid: tenant.id, role: tenant.role, op: u.op, mfa, jti: Bun.randomUUIDv7() },
      Math.floor(now.getTime() / 1000),
    );
    return { accessToken, expiresIn: ACCESS_TTL_SEC, refreshToken, mfa };
  }

  async login(i: { email: string; password: string; otp?: string; tenantId?: string; ip: string; ua?: string }) {
    const wait = await this.d.limiter.check(i.ip, i.email);
    if (wait > 0) throw new ApiError("RATE_LIMITED", "Terlalu banyak percobaan login. Coba lagi nanti.", undefined, wait);

    const result = await withAuthRole(this.d.db, async (tx) => {
      const [u] = await tx.select().from(users).where(eq(users.email, i.email)).limit(1);
      const passOk = await Bun.password.verify(i.password, u?.passwordHash ?? DUMMY_HASH);
      if (!u?.passwordHash || !passOk || u.status !== "active") return { fail: "credentials" as const };

      // tenant platform hanya untuk owner platform; owner platform masuk ke "rumah" platform-nya secara default
      const member = (await this.memberTenants(tx, u.id)).filter((m) => m.kind === "office" || u.isPlatformOperator);
      const chosen = i.tenantId
        ? member.find((m) => m.id === i.tenantId)
        : (member.find((m) => m.kind === "platform" && u.isPlatformOperator) ?? member[0]);
      if (!chosen) return { fail: "no_tenant" as const };

      if (u.mfaSecretEnc) {
        if (!i.otp) return { fail: "otp_missing" as const };
        const secret = await openMfa(this.d.kms, u.id, u.mfaSecretEnc);
        if (!(await verifyTotp(secret, i.otp, this.now().getTime()))) return { fail: "otp_invalid" as const };
      }
      const issued = await this.issue(tx, { id: u.id, op: u.isPlatformOperator, hasMfa: !!u.mfaSecretEnc }, chosen, Bun.randomUUIDv7(), i);
      await tx.update(users).set({ lastLoginAt: this.now() }).where(eq(users.id, u.id));
      await this.audit(tx, "auth.login", { tenantId: chosen.id, actorId: u.id, ip: i.ip, ua: i.ua, after: { mfa: issued.mfa } });
      return {
        issued,
        user: { id: u.id, name: u.name, email: u.email },
        tenants: member.map((m) => ({ id: m.id, name: m.name, role: m.role, kind: m.kind })),
      };
    });

    if ("fail" in result) {
      if (result.fail === "otp_missing") throw new ApiError("MFA_REQUIRED", "Kode OTP diperlukan");
      await this.d.limiter.failure(i.email);
      if (result.fail === "otp_invalid") throw new ApiError("MFA_REQUIRED", "Kode OTP salah");
      if (result.fail === "no_tenant") throw new ApiError("FORBIDDEN", "Akun tidak punya akses ke tenant yang diminta");
      throw new ApiError("UNAUTHENTICATED", "Email atau password salah");
    }
    await this.d.limiter.success(i.email);
    return result;
  }

  /** Rotasi refresh token. Token yang sudah dirotasi dipakai lagi → seluruh family dicabut (SEC-05). */
  async refresh(i: { refreshToken: string; ip: string; ua?: string }): Promise<Issued> {
    const hash = await sha256(i.refreshToken);
    const res = await withAuthRole(this.d.db, async (tx) => {
      const [row] = await tx.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, hash)).for("update").limit(1);
      if (!row) return { fail: "unknown" as const };
      if (row.revokedAt) {
        const revoked = await tx
          .update(refreshTokens)
          .set({ revokedAt: this.now() })
          .where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)))
          .returning({ id: refreshTokens.id });
        await this.audit(tx, "auth.refresh_reuse_detected", {
          tenantId: row.tenantId,
          actorId: row.userId,
          ip: i.ip,
          ua: i.ua,
          after: { family_id: row.familyId, revoked: revoked.length },
        });
        return { fail: "reuse" as const, userId: row.userId };
      }
      if (row.expiresAt.getTime() <= this.now().getTime()) return { fail: "expired" as const };

      const [u] = await tx.select().from(users).where(eq(users.id, row.userId)).limit(1);
      const member = u?.status === "active" ? (await this.memberTenants(tx, row.userId)).find((m) => m.id === row.tenantId) : undefined;
      await tx.update(refreshTokens).set({ revokedAt: this.now() }).where(eq(refreshTokens.id, row.id));
      if (!u || !member) return { fail: "access_revoked" as const };
      return { issued: await this.issue(tx, { id: u.id, op: u.isPlatformOperator, hasMfa: !!u.mfaSecretEnc }, member, row.familyId, i) };
    });
    if ("issued" in res && res.issued) return res.issued;
    if (res.fail === "reuse") this.d.logger?.warn("refresh token reuse — family dicabut", { user_id: res.userId });
    if (res.fail === "expired") throw new ApiError("TOKEN_EXPIRED", "Sesi kedaluwarsa, silakan login ulang");
    throw new ApiError("UNAUTHENTICATED", "Sesi tidak valid, silakan login ulang");
  }

  async logout(refreshToken: string): Promise<void> {
    const hash = await sha256(refreshToken);
    await withAuthRole(this.d.db, async (tx) => {
      const [row] = await tx
        .select({ familyId: refreshTokens.familyId })
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, hash))
        .limit(1);
      if (row) {
        await tx
          .update(refreshTokens)
          .set({ revokedAt: this.now() })
          .where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
      }
    });
  }

  async me(userId: string) {
    return withAuthRole(this.d.db, async (tx) => {
      const [u] = await tx
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          op: users.isPlatformOperator,
          mfa: sql<boolean>`${users.mfaSecretEnc} is not null`,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!u) throw new ApiError("UNAUTHENTICATED", "User tidak ditemukan");
      return {
        user: { id: u.id, name: u.name, email: u.email, is_platform_operator: u.op, mfa_enabled: u.mfa },
        tenants: await this.memberTenants(tx, userId),
      };
    });
  }

  /** Buat secret TOTP tertunda (10 menit, terenkripsi di Redis) — baru aktif setelah verifikasi kode. */
  async mfaSetup(userId: string, email: string): Promise<{ secret: string; otpauthUri: string }> {
    const secret = newTotpSecret();
    const sealed = await sealMfa(this.d.kms, userId, secret);
    await this.d.redis.send("SET", [`auth:mfa_pending:${userId}`, Buffer.from(sealed).toString("base64"), "EX", "600"]);
    return { secret, otpauthUri: otpauthUri(secret, email) };
  }

  async mfaVerify(userId: string, code: string, meta: { ip?: string; ua?: string; tenantId: string }): Promise<void> {
    const pending = await this.d.redis.get(`auth:mfa_pending:${userId}`);
    if (!pending) throw new ApiError("VALIDATION_FAILED", "Tidak ada setup MFA yang tertunda (kedaluwarsa 10 menit)");
    const blob = new Uint8Array(Buffer.from(pending, "base64")) as Uint8Array<ArrayBuffer>;
    const secret = await openMfa(this.d.kms, userId, blob);
    if (!(await verifyTotp(secret, code, this.now().getTime())))
      throw new ApiError("VALIDATION_FAILED", "Kode OTP salah", [{ path: "code", issue: "tidak cocok" }]);
    await withAuthRole(this.d.db, async (tx) => {
      await tx.update(users).set({ mfaSecretEnc: blob, updatedAt: this.now() }).where(eq(users.id, userId));
      await this.audit(tx, "auth.mfa_enabled", { tenantId: meta.tenantId, actorId: userId, ip: meta.ip, ua: meta.ua });
    });
    await this.d.redis.del(`auth:mfa_pending:${userId}`);
  }
}
