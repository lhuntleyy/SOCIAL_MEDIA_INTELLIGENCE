// Access JWT EdDSA 15 menit (SECURITY §2). `kid` untuk rotasi: verifikasi menerima kunci publik lama selama transisi (RUNBOOK §9).
import { type CryptoKey, exportJWK, importJWK, importPKCS8, type JWTPayload, errors as joseErrors, jwtVerify, SignJWT } from "jose";

export const ISSUER = "smip";
export const AUDIENCE = "smip-api";
export const ACCESS_TTL_SEC = 900;

export type Role = "owner" | "admin" | "analyst" | "viewer";
export interface AccessClaims {
  sub: string;
  tid: string;
  role: Role;
  op: boolean;
  /** "ok" = MFA terpenuhi/tidak wajib; "setup_required" = token terbatas ke /me & /me/mfa/* */
  mfa: "ok" | "setup_required";
  jti: string;
  /** Diisi authn (bukan klaim JWT): jenis kredensial & scope API key; impersonasi operator. */
  kind?: "user" | "api_key";
  scopes?: string[];
  impersonating?: boolean;
}

export interface JwtKeys {
  kid: string;
  privateKey: CryptoKey;
  publicKeys: Map<string, CryptoKey>;
}

export async function loadJwtKeys(
  pem: string,
  kid: string,
  previous: { kid: string; publicJwk: Record<string, unknown> }[] = [],
): Promise<JwtKeys> {
  const privateKey = (await importPKCS8(pem, "EdDSA", { extractable: true })) as CryptoKey;
  const { d: _d, ...pubJwk } = await exportJWK(privateKey);
  const publicKeys = new Map<string, CryptoKey>([[kid, (await importJWK(pubJwk, "EdDSA")) as CryptoKey]]);
  for (const p of previous) publicKeys.set(p.kid, (await importJWK(p.publicJwk, "EdDSA")) as CryptoKey);
  return { kid, privateKey, publicKeys };
}

export async function signAccess(keys: JwtKeys, c: AccessClaims, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  return new SignJWT({ tid: c.tid, role: c.role, op: c.op, mfa: c.mfa })
    .setProtectedHeader({ alg: "EdDSA", kid: keys.kid, typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(c.sub)
    .setJti(c.jti)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + ACCESS_TTL_SEC)
    .sign(keys.privateKey);
}

export type VerifyResult = { ok: true; claims: AccessClaims } | { ok: false; reason: "expired" | "invalid" };

export async function verifyAccess(keys: JwtKeys, token: string, nowSec?: number): Promise<VerifyResult> {
  try {
    const { payload } = await jwtVerify(
      token,
      async (header) => {
        const k = header.kid ? keys.publicKeys.get(header.kid) : undefined;
        if (!k) throw new joseErrors.JWKSNoMatchingKey();
        return k;
      },
      { issuer: ISSUER, audience: AUDIENCE, algorithms: ["EdDSA"], currentDate: nowSec ? new Date(nowSec * 1000) : undefined },
    );
    const p = payload as JWTPayload & Partial<AccessClaims>;
    if (!p.sub || !p.tid || !p.role || typeof p.op !== "boolean" || !p.mfa || !p.jti) return { ok: false, reason: "invalid" };
    return { ok: true, claims: { sub: p.sub, tid: p.tid, role: p.role, op: p.op, mfa: p.mfa, jti: p.jti } };
  } catch (e) {
    return { ok: false, reason: e instanceof joseErrors.JWTExpired ? "expired" : "invalid" };
  }
}
