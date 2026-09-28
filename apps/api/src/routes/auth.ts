// API_SPEC §2 — /auth/login, /auth/refresh, /auth/logout, /me, /me/mfa/setup, /me/mfa/verify
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { JwtKeys } from "../auth/jwt";
import { type AuthService, REFRESH_TTL_SEC } from "../auth/service";
import type { AppEnv } from "../context";
import { ApiError } from "../errors";
import { authn } from "../middleware/auth";
import { parseJson } from "../validate";

export const REFRESH_COOKIE = "smip_rt";
const COOKIE = { httpOnly: true, secure: true, sameSite: "Strict", path: "/v1/auth" } as const;

const Login = z.strictObject({
  email: z.email().max(254),
  password: z.string().min(1).max(512),
  otp: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
  tenant_id: z.uuid().optional(),
});
const Verify = z.strictObject({ code: z.string().regex(/^\d{6}$/) });

export function authRoutes(svc: AuthService, keys: JwtKeys, opts: { clientIp: (req: Request) => string }) {
  const r = new Hono<AppEnv>();
  const meta = (c: { req: { raw: Request; header: (n: string) => string | undefined } }) => ({
    ip: opts.clientIp(c.req.raw),
    ua: c.req.header("user-agent"),
  });

  r.post("/auth/login", async (c) => {
    const b = await parseJson(c, Login);
    const res = await svc.login({ email: b.email, password: b.password, otp: b.otp, tenantId: b.tenant_id, ...meta(c) });
    setCookie(c, REFRESH_COOKIE, res.issued.refreshToken, { ...COOKIE, maxAge: REFRESH_TTL_SEC });
    return c.json({
      data: {
        access_token: res.issued.accessToken,
        expires_in: res.issued.expiresIn,
        token_type: "Bearer",
        mfa: res.issued.mfa,
        user: res.user,
        tenants: res.tenants,
      },
      meta: { request_id: c.get("requestId") },
    });
  });

  r.post("/auth/refresh", async (c) => {
    const rt = getCookie(c, REFRESH_COOKIE);
    if (!rt) throw new ApiError("UNAUTHENTICATED", "Sesi tidak ditemukan");
    try {
      const issued = await svc.refresh({ refreshToken: rt, ...meta(c) });
      setCookie(c, REFRESH_COOKIE, issued.refreshToken, { ...COOKIE, maxAge: REFRESH_TTL_SEC });
      return c.json({
        data: { access_token: issued.accessToken, expires_in: issued.expiresIn, token_type: "Bearer", mfa: issued.mfa },
        meta: { request_id: c.get("requestId") },
      });
    } catch (e) {
      deleteCookie(c, REFRESH_COOKIE, COOKIE);
      throw e;
    }
  });

  r.post("/auth/logout", async (c) => {
    const rt = getCookie(c, REFRESH_COOKIE);
    if (rt) await svc.logout(rt);
    deleteCookie(c, REFRESH_COOKIE, COOKIE);
    return c.body(null, 204);
  });

  r.get("/me", authn(keys), async (c) => {
    const a = c.get("auth");
    const me = await svc.me(a.sub);
    return c.json({ data: { ...me, current_tenant: { id: a.tid, role: a.role }, mfa: a.mfa }, meta: { request_id: c.get("requestId") } });
  });

  r.post("/me/mfa/setup", authn(keys), async (c) => {
    const a = c.get("auth");
    const me = await svc.me(a.sub);
    const s = await svc.mfaSetup(a.sub, me.user.email);
    return c.json({ data: { secret: s.secret, otpauth_uri: s.otpauthUri }, meta: { request_id: c.get("requestId") } });
  });

  r.post("/me/mfa/verify", authn(keys), async (c) => {
    const a = c.get("auth");
    const b = await parseJson(c, Verify);
    await svc.mfaVerify(a.sub, b.code, { ...meta(c), tenantId: a.tid });
    return c.json({
      data: { enabled: true, next: "panggil /v1/auth/refresh untuk token dengan mfa=ok" },
      meta: { request_id: c.get("requestId") },
    });
  });

  return r;
}
