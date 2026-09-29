// Redaksi secret untuk log/trace/error (SECURITY §5). Dipakai logger & HttpClient connector.
export const REDACTED = "[REDACTED]";

const SENSITIVE_KEYS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "password",
  "passwd",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "secret",
  "client_secret",
  "api_key",
  "apikey",
  "x-api-key",
  "sessionid",
  "session",
  "credential",
  "credentials",
  "private_key",
  "mfa_secret",
  "otp",
]);

const norm = (k: string) => k.toLowerCase().replace(/-/g, "_");
const SENSITIVE_NORM = new Set([...SENSITIVE_KEYS].map(norm));

export function isSensitiveKey(key: string): boolean {
  const k = norm(key);
  return SENSITIVE_NORM.has(k) || k.endsWith("_token") || k.endsWith("_secret") || k.endsWith("_password") || k.endsWith("_api_key");
}

// Pola nilai (berlaku di string mana pun, termasuk pesan log).
const VALUE_PATTERNS: [RegExp, string | ((m: string, ...g: string[]) => string)][] = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (_m, scheme: string) => `${scheme} ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, REDACTED], // JWT
  [
    /\b(sk-ant-[A-Za-z0-9_-]{8,}|apify_api_[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|xox[abp]-[A-Za-z0-9-]{10,})/g,
    REDACTED,
  ],
  [/(:\/\/[^:/?#\s@]+):([^@/\s]+)@/g, (_m, user: string) => `${user}:${REDACTED}@`], // kredensial di URL
  [
    /([?&](?:token|access_token|api_key|apikey|key|sig|signature|password|X-Amz-Signature|X-Amz-Credential)=)[^&\s#"']+/gi,
    (_m, p: string) => `${p}${REDACTED}`,
  ],
  // parameter query di pesan error ORM/driver (drizzle: "Failed query: …\nparams: a@b.id,1") → bisa berisi email/PII/secret
  [/(\bparams:\s*)[^\n]*/gi, (_m, p: string) => `${p}${REDACTED}`],
  // pasangan key=value / key: "value" / "key":"value" di teks bebas (pesan error provider, stack, JSON mentah)
  [
    /\b((?:access_|refresh_|id_)?token|api[_-]?key|x-api-key|password|passwd|secret|client_secret|sessionid|session_id)("?\s*[=:]\s*)(["']?)(?!\[REDACTED\])[^\s&,;"'}]+(["']?)/gi,
    (_m, k: string, sep: string, q1: string, q2: string) => `${k}${sep}${q1}${REDACTED}${q2}`,
  ],
];

export function redactString(s: string): string {
  let out = s;
  for (const [re, rep] of VALUE_PATTERNS) out = out.replace(re, rep as never);
  return out;
}

export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 8) return "[DEPTH]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message), stack: value.stack ? redactString(value.stack) : undefined };
  }
  if (value instanceof Headers) {
    const o: Record<string, string> = {};
    value.forEach((v, k) => {
      o[k] = isSensitiveKey(k) ? REDACTED : redactString(v);
    });
    return o;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = isSensitiveKey(k) ? REDACTED : redact(v, depth + 1, seen);
  }
  return out;
}
