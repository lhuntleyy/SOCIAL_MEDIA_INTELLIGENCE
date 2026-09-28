// Envelope error API (API_SPEC §1.2). Pesan untuk klien tidak pernah memuat detail internal/secret.
export const ERROR_STATUS = {
  VALIDATION_FAILED: 400,
  INVALID_QUERY: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  MFA_REQUIRED: 401,
  FORBIDDEN: 403,
  MFA_SETUP_REQUIRED: 403,
  PLAN_LIMIT: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VERSION_MISMATCH: 409,
  QUOTA_WOULD_EXCEED: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  UNAVAILABLE: 503,
} as const;
export type ErrorCode = keyof typeof ERROR_STATUS;

export class ApiError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: { path: string; issue: string }[],
    public readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

export function errorBody(code: ErrorCode, message: string, requestId: string, details?: { path: string; issue: string }[]) {
  return { error: { code, message, ...(details?.length ? { details } : {}), request_id: requestId } };
}
