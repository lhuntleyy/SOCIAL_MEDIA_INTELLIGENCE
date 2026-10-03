// Bootstrap service `api` (DEPLOYMENT §5). Semua config divalidasi packages/config — gagal start bila invalid.
import { createClient } from "@clickhouse/client";
import { previewCandidates } from "@smip/analytics";
import { loadConfig } from "@smip/config";
import { HttpClient } from "@smip/connector-sdk";
import { createKms } from "@smip/crypto";
import { createDb } from "@smip/db";
import { createLogger, Registry } from "@smip/observability";
import { BullMqQueue } from "@smip/queue";
import { LlmAdminService } from "./admin/llm";
import { ProviderAdminService } from "./admin/providers";
import { AdminService } from "./admin/service";
import { AlertService } from "./alerts/service";
import { createApp } from "./app";
import { loadJwtKeys } from "./auth/jwt";
import { LoginLimiter } from "./auth/rate-limit";
import { AuthService } from "./auth/service";
import { Realtime, RT_CHANNEL } from "./realtime";
import { TopicService } from "./topics/service";

const cfg = loadConfig("api");
const logger = createLogger({ service: "api", version: cfg.SERVICE_VERSION, env: cfg.NODE_ENV, level: cfg.LOG_LEVEL });
const keys = await loadJwtKeys(await Bun.file(cfg.JWT_PRIVATE_KEY_PATH!).text(), cfg.JWT_KID!);
const { db } = createDb(cfg.DATABASE_URL);
const redis = new Bun.RedisClient(cfg.REDIS_CACHE_URL);
const kms = createKms(cfg);
const auth = new AuthService({ db, keys, kms, redis, limiter: new LoginLimiter(redis), logger });
const ch = createClient({
  url: cfg.CLICKHOUSE_URL,
  database: cfg.CLICKHOUSE_DB,
  username: cfg.CLICKHOUSE_USER,
  password: cfg.CLICKHOUSE_PASSWORD,
});
const topics = new TopicService(db, { previewer: (q) => previewCandidates(ch, q) });
// API hanya membaca/menghapus DLQ; enqueue job normal lewat outbox (Golden Rule 5).
const queue = new BullMqQueue({ connection: { url: cfg.REDIS_URL }, logger });
const providers = new ProviderAdminService(db, {
  kms,
  fingerprintPepper: new Uint8Array(Buffer.from(cfg.CREDENTIAL_PEPPER_B64!, "base64")),
  dlq: queue,
});
const llm = new LlmAdminService(db, {
  kms,
  fingerprintPepper: new Uint8Array(Buffer.from(cfg.CREDENTIAL_PEPPER_B64!, "base64")),
  http: new HttpClient({ timeoutMs: 30_000 }),
});
const alerts = new AlertService(db, {
  kms,
  fingerprintPepper: new Uint8Array(Buffer.from(cfg.CREDENTIAL_PEPPER_B64!, "base64")),
  http: new HttpClient({ timeoutMs: 15_000 }),
});
// D-03: satu koneksi subscriber per replika API → klien SSE lokal
const realtime = new Realtime(redis);
const rtSub = new Bun.RedisClient(cfg.REDIS_CACHE_URL);
await rtSub.subscribe(RT_CHANNEL, (m: string) => realtime.onMessage(m));
const metrics = new Registry();
const sse = metrics.gauge("smip_sse_connections", "Koneksi SSE terbuka di replika ini");
const app = createApp({
  metrics,
  auth,
  admin: new AdminService(db, redis),
  topics,
  providers,
  llm,
  alerts,
  realtime,
  analytics: { db, ch, cache: redis },
  keys,
  logger,
});

const INTERNAL_IP_HEADER = "x-smip-client-ip";
const isPrivate = (ip: string) =>
  /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|::1$|::ffff:(10|127|192\.168|172\.(1[6-9]|2\d|3[01]))\.)/.test(ip);
const server = Bun.serve({
  port: cfg.API_PORT,
  // idleTimeout default Bun 10 s memutus SSE (S-02); route SSE (D-03) akan memakai server.timeout(req, 0).
  async fetch(req, srv) {
    // SSE: koneksi panjang → matikan idle timeout untuk request ini saja (heartbeat 25 s)
    if (new URL(req.url).pathname === "/v1/stream") srv.timeout(req, 0);
    // Header IP internal SELALU ditimpa dari socket → klien tidak bisa memalsukan IP untuk mengakali rate limit.
    const headers = new Headers(req.headers);
    const peer = srv.requestIP(req)?.address ?? "unknown";
    // di belakang proxy tepercaya (jaringan privat) → IP klien = entri X-Forwarded-For paling kanan (ditulis proxy)
    const xff = cfg.API_TRUST_PROXY && isPrivate(peer) ? req.headers.get("x-forwarded-for")?.split(",").pop()?.trim() : undefined;
    headers.set(INTERNAL_IP_HEADER, xff || peer);
    return app.fetch(new Request(req, { headers }));
  },
});
logger.info("api listening", { port: server.port });
// O-07: /metrics di port internal terpisah (tidak lewat ingress — API_SPEC §11)
if (cfg.API_METRICS_PORT)
  Bun.serve({
    port: cfg.API_METRICS_PORT,
    hostname: "0.0.0.0",
    fetch: (req) => {
      if (new URL(req.url).pathname !== "/metrics") return new Response("not found", { status: 404 });
      sse.set({}, realtime.connections);
      return metrics.handler();
    },
  });
