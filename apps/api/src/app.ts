// F-09: komposisi aplikasi Hono (API_SPEC). Dependency disuntik → test memakai app.request() tanpa server.
import type { Logger, Registry } from "@smip/observability";
import { Hono } from "hono";
import type { LlmAdminService } from "./admin/llm";
import type { ProviderAdminService } from "./admin/providers";
import type { AdminService } from "./admin/service";
import type { AlertService } from "./alerts/service";
import type { JwtKeys } from "./auth/jwt";
import type { AuthService } from "./auth/service";
import type { AppEnv } from "./context";
import { ApiError, errorBody } from "./errors";
import { authn, viewerReadOnly } from "./middleware/auth";
import { requestId } from "./middleware/request-id";
import type { Realtime } from "./realtime";
import { adminRoutes, publicAdminRoutes } from "./routes/admin";
import { llmAdminRoutes } from "./routes/admin-llm";
import { providerAdminRoutes } from "./routes/admin-providers";
import { alertRoutes } from "./routes/alerts";
import { analyticsRoutes } from "./routes/analytics";
import { authRoutes } from "./routes/auth";
import { streamRoutes, streamTicketRoutes } from "./routes/stream";
import { topicRoutes } from "./routes/topics";
import type { TopicService } from "./topics/service";

export interface AppDeps {
  auth: AuthService;
  admin?: AdminService;
  topics?: TopicService;
  /** API_SPEC §9 (I-21). */
  providers?: ProviderAdminService;
  /** D-03 realtime SSE (butuh analytics.db untuk cek topik). */
  realtime?: Realtime;
  /** O-05 alert & saluran notifikasi. */
  alerts?: AlertService;
  /** Pengaturan LLM (Fase 3). */
  llm?: LlmAdminService;
  /** D-01/D-02: analitik & feed (ClickHouse). */
  analytics?: Parameters<typeof analyticsRoutes>[0];
  keys: JwtKeys;
  logger?: Logger;
  /** IP klien: di belakang ingress pakai header tepercaya yang diset ingress; default = socket (via header internal). */
  clientIp?: (req: Request) => string;
  /** O-07 metrik HTTP (`smip_http_requests_total`, `smip_http_request_duration_seconds`) — diekspos main.ts di port internal. */
  metrics?: Registry;
  /** Rute tambahan per fitur (dipasang di bawah /v1, sudah melewati authn + viewerReadOnly). */
  mount?: (protectedApp: Hono<AppEnv>) => void;
}

export function createApp(d: AppDeps) {
  const app = new Hono<AppEnv>().basePath("/v1");
  app.use("*", requestId);
  if (d.metrics) {
    const reqs = d.metrics.counter("smip_http_requests_total", "Request HTTP API", ["route", "method", "status"]);
    const dur = d.metrics.histogram(
      "smip_http_request_duration_seconds",
      "Durasi request HTTP API",
      ["route"],
      [0.05, 0.1, 0.25, 0.5, 1, 1.5, 2.5, 5, 10],
    );
    app.use("*", async (c, next) => {
      const t0 = performance.now();
      await next();
      // route = pola terdaftar (bukan path mentah → kardinalitas rendah, tanpa id); SSE dicatat saat header terkirim
      const route = c.req.routePath && c.req.routePath !== "*" && c.req.routePath !== "/v1/*" ? c.req.routePath : "unmatched";
      reqs.inc({ route, method: c.req.method, status: String(c.res.status) });
      dur.observe({ route }, (performance.now() - t0) / 1000);
    });
  }
  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
  });

  app.route("/", authRoutes(d.auth, d.keys, { clientIp: d.clientIp ?? ((r) => r.headers.get("x-smip-client-ip") ?? "unknown") }));

  const admin = d.admin;
  if (admin) app.route("/", publicAdminRoutes(admin));
  // SSE: autentikasi via cookie tiket (bukan Bearer) → di luar middleware authn
  if (d.realtime) app.route("/", streamRoutes({ rt: d.realtime }));

  const prot = new Hono<AppEnv>();
  const ext = admin
    ? {
        verifyApiKey: (raw: string) => admin.verifyApiKey(raw),
        impersonation: {
          tenantExists: (t: string) => admin.tenantExists(t),
          audit: (
            op: { sub: string; tid: string },
            t: string,
            detail: { method: string; path: string; reason: string },
            m: { ip?: string; ua?: string; requestId: string },
          ) => admin.auditImpersonation({ userId: op.sub, tenantId: op.tid, ip: m.ip, ua: m.ua, requestId: m.requestId }, t, detail),
        },
      }
    : {};
  prot.use("*", authn(d.keys, ext));
  prot.use("*", viewerReadOnly);
  if (admin) prot.route("/", adminRoutes(admin));
  if (d.providers) prot.route("/", providerAdminRoutes(d.providers));
  if (d.llm) prot.route("/", llmAdminRoutes(d.llm));
  if (d.analytics) prot.route("/", analyticsRoutes(d.analytics));
  if (d.topics) prot.route("/", topicRoutes(d.topics));
  if (d.alerts) prot.route("/", alertRoutes(d.alerts));
  if (d.realtime && d.analytics) prot.route("/", streamTicketRoutes({ db: d.analytics.db, rt: d.realtime }));
  d.mount?.(prot);
  app.route("/", prot);

  app.notFound((c) => c.json(errorBody("NOT_FOUND", "Rute tidak ditemukan", c.get("requestId") ?? "req_unknown"), 404));
  app.onError((err, c) => {
    const rid = c.get("requestId") ?? "req_unknown";
    if (err instanceof ApiError) {
      if (err.retryAfterSec) c.header("Retry-After", String(err.retryAfterSec));
      return c.json(errorBody(err.code, err.message, rid, err.details), err.status as 400);
    }
    d.logger?.error("unhandled error", { request_id: rid, error: err });
    return c.json(errorBody("INTERNAL", "Terjadi kesalahan internal", rid), 500);
  });
  return app;
}
