// F-07: kontrak bersama TS ↔ Python (ARCHITECTURE §1.4, ADR-003). SATU sumber kebenaran:
// Zod di sini → JSON Schema (packages/contracts/schemas/*.json) → pydantic (workers-py/smip_contracts/generated.py)
// lewat `bun run gen:contracts`. Jangan edit hasil generate manual.
import { z } from "zod";

// ---------- enum & primitif ----------
/** Kode platform berasal dari registry DB (`platforms`), bukan enum — platform baru tanpa ubah kontrak (G6). */
export const PlatformCode = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);

export const Operation = z.enum([
  "search_keyword",
  "search_hashtag",
  "user_timeline",
  "post_comments",
  "post_detail",
  "profile",
  "health_probe",
]);
export type Operation = z.infer<typeof Operation>;

/** Fitur boolean yang didukung provider secara native (CONNECTOR_SPEC §2). */
export const QueryFeature = z.enum(["term", "phrase", "or", "and", "not", "group", "lang_filter", "since", "until"]);
export type QueryFeature = z.infer<typeof QueryFeature>;

export const ContentType = z.enum(["post", "reply", "repost", "quote", "comment"]);
export const RunKind = z.enum(["incremental", "backfill", "engagement_refresh", "verify", "comments"]);
export const Sentiment = z.enum(["negative", "neutral", "positive"]);
export const Emotion = z.enum(["anger", "anticipation", "disgust", "trust", "joy", "sadness", "surprise", "fear", "unknown"]);
export const Gender = z.enum(["male", "female", "unknown"]);
/** Tanpa `below_18` di level akun (ADR-007 amandemen v0.4, data anak). */
export const AgeRange = z.enum(["18_21", "22_30", "31_45", "46_55", "above_55", "unknown"]);

export const ConnectorErrorCode = z.enum([
  "RATE_LIMITED",
  "QUOTA_EXHAUSTED",
  "AUTH_INVALID",
  "CHALLENGE_REQUIRED",
  "FORBIDDEN",
  "BLOCKED",
  "NOT_SUPPORTED",
  "INVALID_QUERY",
  "UPSTREAM_5XX",
  "TIMEOUT",
  "NETWORK",
  "PARSE_ERROR",
  "ASYNC_PENDING",
  "UNKNOWN",
]);
export type ConnectorErrorCode = z.infer<typeof ConnectorErrorCode>;

const Uuid = z.uuid();
/** ISO-8601 UTC dengan `Z` (CONNECTOR_SPEC §4 aturan 2). */
const UtcDateTime = z.iso.datetime({ offset: false });
/** Kunci idempotensi = BullMQ jobId → dilarang ':' (S-03). */
export const IdempotencyKey = z.string().regex(/^[A-Za-z0-9._-]{1,200}$/, "hanya [A-Za-z0-9._-], tanpa ':' (BullMQ jobId)");
const Count = z.number().int().nonnegative();

// ---------- Canonical Item v1 (CONNECTOR_SPEC §4) ----------
// Field tidak diketahui = null, BUKAN 0 / "" (Golden rule AGENTS §3).
export const AuthorRef = z.strictObject({
  platform_user_id: z.string().min(1),
  handle: z.string().nullable(),
});

export const CanonicalAuthor = z.strictObject({
  platform_user_id: z.string().min(1),
  handle: z.string().min(1),
  display_name: z.string().nullable(),
  followers: Count.nullable(),
  following: Count.nullable(),
  verified: z.boolean().nullable(),
  created_at: UtcDateTime.nullable(),
  location_raw: z.string().nullable(),
  avatar_url: z.url().nullable(),
});

export const CanonicalMetrics = z.strictObject({
  likes: Count.nullable(),
  comments: Count.nullable(),
  shares: Count.nullable(),
  views: Count.nullable(),
  quotes: Count.nullable(),
  saves: Count.nullable(),
  captured_at: UtcDateTime,
});

export const CanonicalItem = z.strictObject({
  schema: z.literal("canonical-item/v1"),
  platform: PlatformCode,
  platform_post_id: z.string().min(1),
  content_type: ContentType,
  url: z.url().nullable(),
  text: z.string(),
  lang_hint: z.string().nullable(),
  published_at: UtcDateTime,
  parent: z.strictObject({ platform_post_id: z.string().min(1), author: AuthorRef.nullable() }).nullable(),
  root_post_id: z.string().nullable(),
  author: CanonicalAuthor,
  metrics: CanonicalMetrics,
  hashtags: z.array(z.string()),
  mentions: z.array(z.string()),
  media: z.array(z.strictObject({ type: z.enum(["image", "video", "gif"]), url: z.url(), thumb: z.url().nullable().optional() })),
  geo: z.strictObject({
    lat: z.number().min(-90).max(90).nullable(),
    lng: z.number().min(-180).max(180).nullable(),
    place_name: z.string().nullable(),
  }),
  is_ad: z.boolean().nullable(),
  /** Data mentah per provider — core DILARANG membaca (CONNECTOR_SPEC §4 aturan 3). */
  extra: z.record(z.string(), z.unknown()),
  provenance: z.strictObject({
    connector_key: z.string().min(1),
    connector_version: z.string().min(1),
    fetched_at: UtcDateTime,
    raw_ref: z.string().nullable(),
  }),
});
export type CanonicalItem = z.infer<typeof CanonicalItem>;

// ---------- Usage (CONNECTOR_SPEC §4a) ----------
export const Usage = z.strictObject({
  requests: Count,
  /** Hasil yang DIKEMBALIKAN provider (bukan yang disimpan). */
  results: Count,
  costUnits: z.number().nonnegative().nullable(),
  costUnitLabel: z.string().nullable(),
});

// ---------- Envelope v1 (QUEUE_SPEC §2) ----------
export const Envelope = z.strictObject({
  v: z.literal(1),
  type: z.string().regex(/^[a-z]+(\.[a-z_]+)+$/),
  id: Uuid,
  idempotency_key: IdempotencyKey,
  tenant_id: Uuid.nullable(),
  created_at: UtcDateTime,
  trace: z.strictObject({
    traceparent: z
      .string()
      .regex(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/)
      .optional(),
  }),
  payload: z.unknown(),
});
export type Envelope<T = unknown> = Omit<z.infer<typeof Envelope>, "payload"> & { payload: T };

// ---------- Payload yang melintasi TS ↔ Python (QUEUE_SPEC §4) ----------
const Window = z.strictObject({ since: UtcDateTime.optional(), until: UtcDateTime.optional() });

/** QUEUE_SPEC §4.1 — scheduler/API (backfill)/dispatch (failover) → worker-dispatch. Hanya TS (tidak diekspor ke Python). */
export const CrawlDispatchPayload = z.strictObject({
  crawl_run_id: Uuid,
  /** crawl_runs dipartisi per scheduled_for → wajib ikut agar update tidak memindai semua partisi. */
  scheduled_for: UtcDateTime,
  /** Run plan per-query; null untuk run collection stream (ADR-009). */
  crawl_plan_id: Uuid.nullable(),
  collection_stream_id: Uuid.nullable().optional(),
  topic_id: Uuid.nullable(),
  topic_query_id: Uuid.nullable(),
  platform: PlatformCode,
  operation: Operation,
  run_kind: RunKind,
  window: Window,
  interval_sec: z.number().int().positive(),
  attempt_no: z.number().int().min(1),
  exclude_connector_ids: z.array(Uuid),
  exclude_account_ids: z.array(Uuid),
  /** INVALID_QUERY → compile ulang konservatif (hanya term) sekali (CONNECTOR_SPEC §7). */
  recompile: z.boolean().optional(),
});
export type CrawlDispatchPayload = z.infer<typeof CrawlDispatchPayload>;

export const FetchRequestPayload = z.strictObject({
  crawl_run_id: Uuid,
  attempt_no: z.number().int().min(1),
  connector_id: Uuid,
  connector_key: z.string().min(1),
  connector_version: z.string().min(1),
  provider_account_id: Uuid,
  reservation_id: z.string().min(1),
  request: z.strictObject({
    requestId: Uuid,
    idempotencyKey: IdempotencyKey,
    platform: PlatformCode,
    operation: Operation,
    /** Sub-query hasil compiler (CONNECTOR_SPEC §5); worker menjalankan SEMUA berurutan dalam satu attempt. */
    queries: z
      .array(z.strictObject({ native: z.string(), sourceNodeIds: z.array(z.string()) }))
      .max(50)
      .optional(),
    targetIds: z.array(z.string()).optional(),
    window: Window.optional(),
    cursor: z.string().nullable().optional(),
    pageLimit: z.number().int().min(1),
    maxItems: z.number().int().min(1),
  }),
  deadline_at: UtcDateTime,
  /** fetch.resume: lanjutkan eksekusi async (ASYNC_PENDING) dari sub-query/halaman ini. `seq` ≥ 1 = bagian ke-n. */
  resume: z
    .strictObject({
      async_handle: z.strictObject({ kind: z.string(), id: z.string(), startedAt: UtcDateTime, pollAfterMs: Count }),
      query_index: Count,
      page: z.number().int().min(1),
      seq: z.number().int().min(1),
    })
    .optional(),
});

export const FetchResultPayload = z.strictObject({
  crawl_run_id: Uuid,
  attempt_no: z.number().int().min(1),
  connector_id: Uuid,
  provider_account_id: Uuid,
  reservation_id: z.string().min(1),
  outcome: z.enum(["success", "error"]),
  error: z
    .strictObject({
      code: ConnectorErrorCode,
      message: z.string(),
      retry_after_ms: z.number().int().nonnegative().nullable(),
      scope: z.enum(["request", "account", "connector"]),
      http_status: z.number().int().nullable(),
    })
    .nullable(),
  items_ref: z.string().nullable(),
  items_count: Count,
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
  async_handle: z.strictObject({ kind: z.string(), id: z.string(), startedAt: UtcDateTime, pollAfterMs: Count }).nullable(),
  usage: Usage,
  duration_ms: Count,
  rate_limit_info: z.strictObject({ remaining: Count.nullable(), resetAt: UtcDateTime.nullable() }),
  /** Bagian eksekusi (0 = awal, n = resume ke-n) — kunci batch item unik per bagian. */
  part: Count.optional(),
  /** Posisi lanjutan bila outcome ASYNC_PENDING. */
  resume_state: z
    .strictObject({ query_index: Count, page: z.number().int().min(1) })
    .nullable()
    .optional(),
});

/** QUEUE_SPEC §4.4 — worker-dispatch → worker-pipeline (TS saja). Run stream: tenant/topic/query null + collection_stream_id. */
export const PipelineItemsPayload = z.strictObject({
  crawl_run_id: Uuid,
  attempt_no: z.number().int().min(1),
  tenant_id: Uuid.nullable(),
  topic_id: Uuid.nullable(),
  topic_query_id: Uuid.nullable(),
  collection_stream_id: Uuid.nullable().optional(),
  query_ast_version: z.number().int().min(1),
  /** Bagian eksekusi attempt (resume async) — ikut kunci idempotensi hilir. */
  part: Count.optional(),
  items_ref: z.string().min(1),
  items_count: Count,
});
export type PipelineItemsPayload = z.infer<typeof PipelineItemsPayload>;
export type FetchRequestPayload = z.infer<typeof FetchRequestPayload>;
export type FetchResultPayload = z.infer<typeof FetchResultPayload>;

/** Baris file `posts_ref` (pipeline → sink, TS saja): item canonical + turunan pipeline. */
export const PostRecord = CanonicalItem.extend({
  geo_region_code: z.string().nullable(),
  geo_confidence: z.number().min(0).max(1).nullable(),
  matched: z.boolean(),
});
export type PostRecord = z.infer<typeof PostRecord>;

export const AiEnrichPayload = z.strictObject({
  batch_id: Uuid,
  crawl_run_id: Uuid,
  tenant_id: Uuid,
  topic_id: Uuid,
  priority_class: z.enum(["realtime", "backfill"]),
  items: z.array(
    z.strictObject({
      platform: PlatformCode,
      post_id: z.string().min(1),
      text: z.string(),
      lang_hint: z.string().nullable(),
      is_new_post: z.boolean(),
      author: z.strictObject({
        platform_user_id: z.string().min(1),
        display_name: z.string().nullable(),
        created_at: UtcDateTime.nullable(),
      }),
      match: z.strictObject({ topic_query_id: Uuid }),
    }),
  ),
  items_ref: z.string().nullable(),
  models: z.record(z.string(), z.string()),
  /** relabel (A-06): match lama diberi label model aktif → sink menulis koreksi sign −1/+1 (bukan match baru). */
  mode: z.enum(["ingest", "relabel"]).optional(),
});

export const SinkMatch = z.strictObject({
  platform: PlatformCode,
  post_id: z.string().min(1),
  topic_query_id: Uuid,
  sentiment: Sentiment,
  sentiment_score: z.number().min(0).max(1),
  emotion: Emotion,
  emotion_score: z.number().min(0).max(1),
  author_gender: Gender,
  author_gender_conf: z.number().min(0).max(1),
  author_age_range: AgeRange,
  author_age_conf: z.number().min(0).max(1),
  author_followers: Count.nullable(),
  model_version: z.string().min(1),
  issues: z.array(z.string()),
  hashtags: z.array(z.string()),
  parent_author_id: z.string().nullable(),
  geo_region_code: z.string().nullable(),
  media: z.array(z.strictObject({ type: z.string(), url: z.string(), thumb: z.string().nullable() })),
  engagement: Count,
  engagement_known: z.boolean(),
});

export const SinkAnalyticsPayload = z.strictObject({
  batch_id: Uuid,
  crawl_run_id: Uuid,
  /** null untuk batch post tak-match / run collection stream (QUEUE_SPEC §4.4). */
  tenant_id: Uuid.nullable(),
  topic_id: Uuid.nullable(),
  posts_ref: z.string().min(1),
  matches: z.array(SinkMatch),
  /** engagement_refresh (I-20): posts_ref = item kanonik hasil `post_detail`; sink menulis snapshot + pasangan sign −1/+1. */
  mode: z.enum(["ingest", "engagement_refresh", "relabel"]).optional(),
  /** Informatif saja: penutupan run & watermark digerakkan counter DB (crawl_runs.pending_batches, migrasi 0014). */
  run_update: z
    .strictObject({
      items_fetched: Count,
      items_matched: Count,
      items_new: Count,
      new_high_watermark: UtcDateTime.nullable(),
      run_outcome: z.enum(["succeeded", "partial", "failed"]),
      gap_window: Window.nullable(),
    })
    .nullable(),
});

export type SinkAnalyticsPayload = z.infer<typeof SinkAnalyticsPayload>;

/** Admin API (I-21) → worker-fetch-bun: probe kesehatan connector (semua akun aktif, maks 5). Hanya TS. */
export const HealthProbePayload = z.strictObject({ connector_id: Uuid, requested_by: Uuid.nullable(), job_id: Uuid });
export type HealthProbePayload = z.infer<typeof HealthProbePayload>;

/** Admin API (I-21) → worker-fetch-bun: verify capability (panggilan provider SUNGGUHAN, bisa berbayar). Hanya TS. */
export const ConnectorVerifyPayload = z.strictObject({
  connector_id: Uuid,
  requested_by: Uuid.nullable(),
  job_id: Uuid,
  query: z.string().min(1).max(500),
  operation: Operation.optional(),
  samples: z.number().int().min(1).max(5),
  max_items: z.number().int().min(1).max(50),
  window_hours: z.number().int().min(1).max(168),
  apply: z.boolean(),
});
export type ConnectorVerifyPayload = z.infer<typeof ConnectorVerifyPayload>;

/** QUEUE_SPEC §4.8 — scheduler/planner → worker-dispatch; run `engagement_refresh` sudah dibuat bersama job ini (outbox). */
export const EngagementRefreshPayload = z.strictObject({
  crawl_run_id: Uuid,
  scheduled_for: UtcDateTime,
  platform: PlatformCode,
  post_ids: z.array(z.string().min(1).max(200)).min(1).max(50),
  reason: z.string().max(100),
});
export type EngagementRefreshPayload = z.infer<typeof EngagementRefreshPayload>;
export type SinkMatch = z.infer<typeof SinkMatch>;
export type AiEnrichPayload = z.infer<typeof AiEnrichPayload>;

/** Semua skema yang diekspor ke JSON Schema + pydantic. Nama = nama file & kelas Python. */
export const EXPORTED = {
  CanonicalItem,
  EngagementRefreshPayload,
  Envelope,
  FetchRequestPayload,
  FetchResultPayload,
  AiEnrichPayload,
  SinkAnalyticsPayload,
} as const;
