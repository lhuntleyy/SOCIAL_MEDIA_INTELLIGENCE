// authn → rbac (SECURITY §3: requestId → authn → tenantContext → rbac → validate → handler).
import { createMiddleware } from "hono/factory";
import { type AccessClaims, type JwtKeys, type Role, verifyAccess } from "../auth/jwt";
import type { AppEnv } from "../context";
import { ApiError } from "../errors";

/** Path yang boleh diakses token `mfa=setup_required` (hanya untuk menyelesaikan setup MFA). */
const MFA_SETUP_ALLOWED = [/^\/v1\/me$/, /^\/v1\/me\/mfa\/(setup|verify)$/, /^\/v1\/auth\/logout$/];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuthnExt {
  /** Verifikasi header X-API-Key (F-10); null = tidak valid. */
  verifyApiKey?: (raw: string) => Promise<AccessClaims | null>;
  /** Impersonasi operator via X-Tenant-Id (API_SPEC header; SECURITY §3) — wajib alasan & diaudit per request. */
  impersonation?: {
    tenantExists: (tenantId: string) => Promise<boolean>;
    audit: (
      op: AccessClaims,
      tenantId: string,
      detail: { method: string; path: string; reason: string },
      meta: { ip?: string; ua?: string; requestId: string },
    ) => Promise<void>;
  };
}

export const authn = (keys: JwtKeys, ext: AuthnExt = {}) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const h = c.req.header("authorization");
    const token = h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
    const apiKey = c.req.header("x-api-key");
    let claims: AccessClaims;
    if (token) {
      const r = await verifyAccess(keys, token);
      if (!r.ok) {
        throw new ApiError(
          r.reason === "expired" ? "TOKEN_EXPIRED" : "UNAUTHENTICATED",
          r.reason === "expired" ? "Token kedaluwarsa" : "Token tidak valid",
        );
      }
      claims = { ...r.claims, kind: "user" };
    } else if (apiKey && ext.verifyApiKey) {
      const k = await ext.verifyApiKey(apiKey);
      if (!k) throw new ApiError("UNAUTHENTICATED", "API key tidak valid");
      claims = k;
    } else {
      throw new ApiError("UNAUTHENTICATED", "Token akses diperlukan");
    }
    if (claims.mfa === "setup_required" && !MFA_SETUP_ALLOWED.some((re) => re.test(c.req.path))) {
      throw new ApiError("MFA_SETUP_REQUIRED", "Aktifkan MFA terlebih dahulu (wajib untuk admin/operator)");
    }

    const target = c.req.header("x-tenant-id");
    if (target) {
      if (!claims.op || claims.kind === "api_key" || !ext.impersonation)
        throw new ApiError("FORBIDDEN", "Impersonasi tenant khusus platform operator");
      const reason = c.req.header("x-impersonation-reason")?.trim() ?? "";
      if (reason.length < 10) {
        throw new ApiError("VALIDATION_FAILED", "Header X-Impersonation-Reason wajib (min. 10 karakter)", [
          { path: "X-Impersonation-Reason", issue: "wajib" },
        ]);
      }
      if (!UUID_RE.test(target) || !(await ext.impersonation.tenantExists(target)))
        throw new ApiError("NOT_FOUND", "Tenant tidak ditemukan");
      await ext.impersonation.audit(
        claims,
        target,
        { method: c.req.method, path: c.req.path, reason: reason.slice(0, 300) },
        { ip: c.req.header("x-smip-client-ip"), ua: c.req.header("user-agent"), requestId: c.get("requestId") },
      );
      claims = { ...claims, tid: target, role: "admin", impersonating: true };
    }
    c.set("auth", claims);
    await next();
  });

const RANK: Record<Role, number> = { viewer: 0, analyst: 1, admin: 2, owner: 3 };

/** Peran minimum di tenant token. Operator platform lolos untuk rute admin tenant. */
export const requireRole = (min: Role) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const a = c.get("auth");
    if (!a || (RANK[a.role] < RANK[min] && !a.op)) throw new ApiError("FORBIDDEN", "Peran tidak mencukupi");
    await next();
  });

export const requireOperator = createMiddleware<AppEnv>(async (c, next) => {
  const a = c.get("auth");
  if (!a?.op || a.kind === "api_key") throw new ApiError("FORBIDDEN", "Khusus platform operator");
  await next();
});

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
/** SEC-06: viewer tidak boleh mengubah apa pun, di rute mana pun (kecuali mengelola MFA/sesi dirinya). */
export const viewerReadOnly = createMiddleware<AppEnv>(async (c, next) => {
  const a = c.get("auth");
  if (a?.role === "viewer" && !a.op && !SAFE.has(c.req.method) && !/^\/v1\/(me\/mfa\/|auth\/|stream\/ticket$)/.test(c.req.path)) {
    throw new ApiError("FORBIDDEN", "Viewer hanya dapat membaca");
  }
  await next();
});
