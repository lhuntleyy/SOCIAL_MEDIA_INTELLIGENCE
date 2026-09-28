// Taksonomi error connector (CONNECTOR_SPEC §7). Connector WAJIB melempar ConnectorError — router memutuskan failover.
import type { ConnectorErrorCode } from "@smip/contracts";

export type ErrorScope = "request" | "account" | "connector";

const DEFAULT_SCOPE: Record<ConnectorErrorCode, ErrorScope> = {
  RATE_LIMITED: "account",
  QUOTA_EXHAUSTED: "account",
  AUTH_INVALID: "account",
  CHALLENGE_REQUIRED: "account",
  FORBIDDEN: "account",
  BLOCKED: "account",
  NOT_SUPPORTED: "connector",
  INVALID_QUERY: "request",
  UPSTREAM_5XX: "connector",
  TIMEOUT: "connector",
  NETWORK: "connector",
  PARSE_ERROR: "connector",
  ASYNC_PENDING: "request",
  UNKNOWN: "connector",
};

export class ConnectorError extends Error {
  readonly retryAfterMs?: number;
  readonly httpStatus?: number;
  readonly scope: ErrorScope;
  constructor(
    public readonly code: ConnectorErrorCode,
    message: string,
    opts: { retryAfterMs?: number; httpStatus?: number; scope?: ErrorScope; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = "ConnectorError";
    this.retryAfterMs = opts.retryAfterMs;
    this.httpStatus = opts.httpStatus;
    this.scope = opts.scope ?? DEFAULT_SCOPE[code];
  }
}

/** Klasifikasi status HTTP → kode (connector boleh override untuk kasus khusus provider). */
export function codeForStatus(status: number): ConnectorErrorCode {
  if (status === 429) return "RATE_LIMITED";
  if (status === 401) return "AUTH_INVALID";
  if (status === 402) return "QUOTA_EXHAUSTED";
  if (status === 403) return "FORBIDDEN";
  if (status === 400 || status === 422) return "INVALID_QUERY";
  if (status === 404 || status === 501) return "NOT_SUPPORTED";
  if (status >= 500) return "UPSTREAM_5XX";
  return "UNKNOWN";
}

/** Error apa pun → ConnectorError (pesan di-sanitize oleh logger/HttpClient). */
export function toConnectorError(e: unknown): ConnectorError {
  if (e instanceof ConnectorError) return e;
  if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError"))
    return new ConnectorError("TIMEOUT", "deadline terlampaui", { cause: e });
  return new ConnectorError("UNKNOWN", e instanceof Error ? e.message : String(e), { cause: e });
}
