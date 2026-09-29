// F-02: parsing & validasi env per service (DEPLOYMENT §5). Service gagal start bila env invalid.
// Pesan error hanya menyebut NAMA variabel — nilai tidak pernah dicetak (bisa berisi secret, SECURITY §5).
import { z } from "zod";

export const SERVICES = [
  "api",
  "scheduler",
  "worker-dispatch",
  "worker-fetch-bun",
  "worker-pipeline",
  "worker-sink",
  "worker-health",
  "worker-ops",
  "workers", // profil MVP single-node: semua consumer Bun dalam satu proses (DEPLOYMENT §3a)
] as const;
export type ServiceName = (typeof SERVICES)[number];

const url = (protocols: string[]) =>
  z
    .string()
    .min(1)
    .refine(
      (v) => {
        try {
          return protocols.includes(new URL(v).protocol);
        } catch {
          return false;
        }
      },
      `harus URL ${protocols.join("/")}`,
    );

const csv = z
  .string()
  .transform((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().url()).min(1));

const base = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  SERVICE_VERSION: z.string().default("0.0.0"),
  OTEL_EXPORTER_OTLP_ENDPOINT: url(["http:", "https:"]).optional(),
  OTEL_SERVICE_NAME: z.string().optional(),
  DATABASE_URL: url(["postgres:", "postgresql:"]),
  REDIS_URL: url(["redis:", "rediss:"]), // Redis-queue (BullMQ, noeviction)
  REDIS_CACHE_URL: url(["redis:", "rediss:"]), // Redis-cache/dedupe/rate/quota
});

const clickhouse = z.object({
  CLICKHOUSE_URL: url(["http:", "https:"]),
  CLICKHOUSE_DB: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/)
    .default("smip"),
  CLICKHOUSE_USER: z.string().default("default"),
  CLICKHOUSE_PASSWORD: z.string().default(""),
});

const s3 = z.object({
  S3_ENDPOINT: url(["http:", "https:"]),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET_RAW: z.string().min(3),
  S3_BUCKET_EXPORTS: z.string().min(3),
  S3_BUCKET_TRAINING: z.string().min(3), // teks korpus nlp_labels (DATA_MODEL §5.10)
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
});

const kms = z.object({
  KMS_ADAPTER: z.enum(["vault-transit", "aws-kms", "gcp-kms", "local-dev"]),
  KMS_KEY_ID: z.string().min(1),
  VAULT_ADDR: url(["http:", "https:"]).optional(),
  VAULT_TOKEN: z.string().optional(),
  KMS_LOCAL_DEV_KEK_B64: z.string().optional(), // hanya adapter local-dev
});

const api = z.object({
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  JWT_PRIVATE_KEY_PATH: z.string().min(1),
  JWT_KID: z.string().min(1),
  CORS_ORIGINS: csv,
  /** Pepper HMAC fingerprint credential (deteksi duplikat tanpa dekripsi, I-21). Secret; ≥ 32 byte. */
  CREDENTIAL_PEPPER_B64: z.string().refine((v) => Buffer.from(v, "base64").length >= 32, "harus base64 ≥ 32 byte"),
});

const scheduler = z.object({
  SCHEDULER_TICK_MS: z.coerce.number().int().min(1000).default(15000),
  /** Run non-final lebih tua dari ini → reaper menandai STUCK_RUN & membebaskan plan (QUEUE_SPEC §6). */
  SCHEDULER_STUCK_RUN_GRACE_SEC: z.coerce.number().int().min(60).default(900),
  /** Run pertama plan tanpa high_watermark: jendela mundur (detik). Kecil = hemat biaya provider. */
  SCHEDULER_INITIAL_LOOKBACK_SEC: z.coerce.number().int().min(60).default(3600),
  /** Backpressure: antrean fetch menunggu > ini → plan prioritas rendah ditunda. */
  SCHEDULER_BACKPRESSURE_WAITING: z.coerce.number().int().min(1).default(5000),
  /** Celah partial success lebih tua dari ini dibuang (data hilang yang disadari, CONNECTOR_SPEC §7). */
  SCHEDULER_MAX_GAP_AGE_SEC: z.coerce.number().int().min(3600).default(86_400),
  /** Dedup planner collection stream (ADR-009). Additive: false → semua topik di-crawl per query (fallback). */
  SCHEDULER_STREAMS_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  SCHEDULER_STREAM_PLAN_MS: z.coerce.number().int().min(10_000).default(300_000),
  /** Cost guard (I-23): interval efektif plan/stream saat soft cap biaya tercapai — throttle, bukan stop. */
  SCHEDULER_COST_GUARD_INTERVAL_SEC: z.coerce.number().int().min(300).max(86_400).default(3600),
});

const SHAPES: Record<ServiceName, z.ZodObject<z.ZodRawShape>[]> = {
  api: [base, clickhouse, kms, api],
  scheduler: [base, scheduler],
  "worker-dispatch": [base],
  "worker-fetch-bun": [base, s3, kms],
  "worker-pipeline": [base, s3],
  "worker-sink": [base, clickhouse, s3],
  "worker-health": [base, kms],
  "worker-ops": [base, clickhouse, s3],
  workers: [base, clickhouse, s3, kms, scheduler],
};

function schemaFor(service: ServiceName) {
  const merged = SHAPES[service].reduce((acc, s) => acc.extend(s.shape), z.object({}));
  return merged.superRefine((cfg, ctx) => {
    const c = cfg as Record<string, unknown>;
    if (c.REDIS_URL && c.REDIS_URL === c.REDIS_CACHE_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["REDIS_CACHE_URL"],
        message: "harus berbeda dari REDIS_URL (queue noeviction ≠ cache, DATA_MODEL §7)",
      });
    }
    if (c.KMS_ADAPTER === "local-dev" && c.NODE_ENV === "production") {
      ctx.addIssue({ code: "custom", path: ["KMS_ADAPTER"], message: "local-dev dilarang saat NODE_ENV=production (SECURITY §4)" });
    }
    if (c.KMS_ADAPTER === "vault-transit" && (!c.VAULT_ADDR || !c.VAULT_TOKEN)) {
      ctx.addIssue({ code: "custom", path: ["VAULT_ADDR"], message: "VAULT_ADDR & VAULT_TOKEN wajib untuk vault-transit" });
    }
    if (c.KMS_ADAPTER === "local-dev" && !c.KMS_LOCAL_DEV_KEK_B64) {
      ctx.addIssue({ code: "custom", path: ["KMS_LOCAL_DEV_KEK_B64"], message: "wajib untuk adapter local-dev" });
    }
  });
}

type Merge<T extends readonly unknown[]> = T extends readonly [infer H, ...infer R] ? H & Merge<R> : unknown;
type Out<S> = S extends z.ZodTypeAny ? z.output<S> : never;
type AllConfig = Merge<[Out<typeof base>, Out<typeof clickhouse>, Out<typeof s3>, Out<typeof kms>, Out<typeof api>, Out<typeof scheduler>]>;
/** Konfigurasi hasil validasi. Field di luar service tsb tidak dijamin ada — akses lewat service yang benar. */
export type Config = Partial<AllConfig> & Out<typeof base> & { service: ServiceName };

export class ConfigError extends Error {
  constructor(
    public readonly service: string,
    public readonly issues: { variable: string; message: string }[],
  ) {
    super(`konfigurasi ${service} tidak valid:\n${issues.map((i) => `  - ${i.variable}: ${i.message}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

export function loadConfig(service: string, env: Record<string, string | undefined> = process.env): Config {
  if (!(SERVICES as readonly string[]).includes(service)) {
    throw new ConfigError(service, [{ variable: "SERVICE", message: `tidak dikenal (pilihan: ${SERVICES.join(", ")})` }]);
  }
  const res = schemaFor(service as ServiceName).safeParse(env);
  if (!res.success) {
    // message zod bisa menyertakan nilai input → pakai pesan milik kita / kode issue saja
    const issues = res.error.issues.map((i) => ({
      variable: String(i.path[0] ?? "?"),
      message: i.code === "custom" ? i.message : i.code === "invalid_type" ? "wajib diisi" : `tidak valid (${i.code})`,
    }));
    throw new ConfigError(service, issues);
  }
  return { ...(res.data as object), service } as Config;
}
