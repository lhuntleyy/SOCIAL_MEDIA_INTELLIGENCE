// I-04: kontrak connector (CONNECTOR_SPEC §2–§3). Semua logic spesifik provider HANYA di packages/connectors/*.
import type { CanonicalItem, ConnectorErrorCode, Operation, QueryFeature } from "@smip/contracts";
import type { Logger } from "@smip/observability";
import type { HttpClient } from "./http";

export type Runtime = "bun" | "python";

export interface OperationSupport {
  queryFeatures: QueryFeature[];
  /** null = tidak diketahui → compiler memecah query per leaf. */
  maxQueryLength: number | null;
  supportsSince: boolean;
  supportsUntil: boolean;
  supportsCursor: boolean;
  maxPageSize: number | null;
  /** Path CanonicalItem yang diisi, mis. "metrics.likes" — diverifikasi connector.verify (≥ 80% non-null). */
  returnsFields: string[];
  /** true = provider berbasis run (start → poll → result), mis. actor Apify. */
  asyncExecution: boolean;
  /** Urutan hasil: desc (terbaru dulu) / asc / null (tak terurut) — dipakai celah partial success (§7). */
  resultOrder: "desc" | "asc" | null;
}

export interface ConnectorManifest {
  /** `<provider>.<platform>[.<varian>]` — DATA_MODEL §4.2 */
  key: string;
  version: string;
  providerKey: string;
  platform: string;
  runtime: Runtime;
  displayName: string;
  credentialKinds: Array<"api_key" | "oauth2" | "session" | "basic" | "cookie_jar" | "none">;
  /** JSON Schema config non-rahasia (actor id, base url, input template, allowedHosts). */
  configSchema: Record<string, unknown>;
  operations: Partial<Record<Operation, OperationSupport>>;
  /** HANYA jenis unit — angka harga & rate limit DILARANG di kode (Golden Rule 1). */
  costModel: { unit: "request" | "result" | "compute_unit" | "credit" | "unknown"; reportsUsageInResponse: boolean };
  /** Sumber fakta (dokumen provider). */
  docsUrl: string;
}

export interface DecryptedCredential {
  kind: "api_key" | "oauth2" | "session" | "basic" | "cookie_jar" | "none";
  /** Hanya di memori; tidak pernah di-log/serialize. */
  secret: Record<string, string>;
}

export interface RateLimitInfo {
  remaining: number | null;
  resetAt: string | null;
  retryAfterMs: number | null;
  scope: "provider" | "connector" | "provider_account";
}

export interface RawMeta {
  platform: string;
  crawlRunId: string;
  attemptNo: number;
  page: number;
}

export interface ConnectorContext {
  credential: DecryptedCredential;
  config: Record<string, unknown>;
  http: HttpClient;
  logger: Logger;
  signal: AbortSignal;
  reportRateLimit(info: RateLimitInfo): void;
  /** Arsipkan payload mentah (S3) → raw_ref. */
  archiveRaw(page: unknown, meta: RawMeta): Promise<string>;
}

export interface CompiledQueryRef {
  native: string;
  sourceNodeIds: string[];
}

export interface AsyncHandle {
  kind: string;
  id: string;
  startedAt: string;
  pollAfterMs: number;
}

export interface FetchRequest {
  requestId: string;
  /** run.{crawl_run_id}.attempt.{n}.page.{p} — tanpa ':' */
  idempotencyKey: string;
  platform: string;
  operation: Operation;
  query?: CompiledQueryRef;
  targetIds?: string[];
  window?: { since?: string; until?: string };
  cursor?: string | null;
  pageLimit: number;
  maxItems: number;
  asyncHandle?: AsyncHandle;
}

export interface Usage {
  requests: number;
  /** Hasil yang DIKEMBALIKAN provider (bukan yang disimpan) — dasar biaya (CONNECTOR_SPEC §4a). */
  results: number;
  costUnits: number | null;
  costUnitLabel: string | null;
}

export interface FetchResult {
  items: CanonicalItem[];
  nextCursor: string | null;
  hasMore: boolean;
  asyncHandle?: AsyncHandle;
  rawRefs: string[];
  usage: Usage;
  upstream: { httpStatuses: number[]; requestIds: string[] };
  warnings: Array<{ code: string; message: string }>;
}

export interface HealthProbeResult {
  ok: boolean;
  latencyMs: number;
  errorCode?: ConnectorErrorCode;
  details?: Record<string, unknown>;
}

export interface Connector {
  readonly manifest: ConnectorManifest;
  init?(ctx: Omit<ConnectorContext, "signal">): Promise<void>;
  /** Satu halaman/eksekusi. WAJIB menghormati ctx.signal dan melempar ConnectorError (bukan error mentah). */
  fetch(req: FetchRequest, ctx: ConnectorContext): Promise<FetchResult>;
  healthProbe(ctx: ConnectorContext): Promise<HealthProbeResult>;
  resume?(handle: AsyncHandle, ctx: ConnectorContext): Promise<FetchResult>;
  dispose?(): Promise<void>;
}
