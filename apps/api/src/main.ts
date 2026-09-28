// Bootstrap service `api` (DEPLOYMENT §5). Semua config divalidasi packages/config — gagal start bila invalid.
import { createClient } from "@clickhouse/client";
import { previewCandidates } from "@smip/analytics";
import { loadConfig } from "@smip/config";
import { createKms } from "@smip/crypto";
import { createDb } from "@smip/db";
import { createLogger } from "@smip/observability";
import { AdminService } from "./admin/service";
import { createApp } from "./app";
import { loadJwtKeys } from "./auth/jwt";
import { LoginLimiter } from "./auth/rate-limit";
import { AuthService } from "./auth/service";
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
const app = createApp({ auth, admin: new AdminService(db, redis), topics, keys, logger });

const INTERNAL_IP_HEADER = "x-smip-client-ip";
const server = Bun.serve({
  port: cfg.API_PORT,
  // idleTimeout default Bun 10 s memutus SSE (S-02); route SSE (D-03) akan memakai server.timeout(req, 0).
  async fetch(req, srv) {
    // Header IP internal SELALU ditimpa dari socket → klien tidak bisa memalsukan IP untuk mengakali rate limit.
    const headers = new Headers(req.headers);
    headers.set(INTERNAL_IP_HEADER, srv.requestIP(req)?.address ?? "unknown");
    return app.fetch(new Request(req, { headers }));
  },
});
logger.info("api listening", { port: server.port });
