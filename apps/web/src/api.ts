// Klien API: access token HANYA di memori (bukan localStorage — SECURITY §7); sesi dipulihkan lewat cookie refresh
// HttpOnly (`POST /v1/auth/refresh`). 401 → satu kali refresh lalu ulang request.
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: { path: string; issue: string }[],
  ) {
    super(message);
  }
}

type TokenListener = (t: string | null) => void;
let accessToken: string | null = null;
const listeners = new Set<TokenListener>();
export const setToken = (t: string | null) => {
  accessToken = t;
  for (const l of listeners) l(t);
};
export const onToken = (l: TokenListener) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

let refreshing: Promise<boolean> | null = null;
export function refreshSession(): Promise<boolean> {
  refreshing ??= fetch("/v1/auth/refresh", { method: "POST", credentials: "same-origin" })
    .then(async (r) => {
      if (!r.ok) {
        setToken(null);
        return false;
      }
      const j = (await r.json()) as { data: { access_token: string } };
      setToken(j.data.access_token);
      return true;
    })
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/** Administrator platform "melihat sebagai" kantor lain (impersonasi, SECURITY §3): header X-Tenant-Id + alasan, diaudit per request. */
export interface ViewAs {
  tenantId: string;
  tenantName: string;
  reason: string;
}
const VIEW_KEY = "smip.viewAs";
let viewAs: ViewAs | null = (() => {
  try {
    return JSON.parse(sessionStorage.getItem(VIEW_KEY) ?? "null") as ViewAs | null;
  } catch {
    return null;
  }
})();
export const getViewAs = () => viewAs;
export function setViewAs(v: ViewAs | null) {
  viewAs = v;
  try {
    if (v) sessionStorage.setItem(VIEW_KEY, JSON.stringify(v));
    else sessionStorage.removeItem(VIEW_KEY);
  } catch {
    /* sessionStorage tidak tersedia → hanya di memori */
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  if (viewAs && !path.startsWith("/auth/") && !path.startsWith("/me")) {
    headers.set("x-tenant-id", viewAs.tenantId);
    headers.set("x-impersonation-reason", viewAs.reason);
  }
  if (init.json !== undefined) headers.set("content-type", "application/json");
  const res = await fetch(`/v1${path}`, {
    ...init,
    headers,
    credentials: "same-origin",
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  if (res.status === 401 && retry && path !== "/auth/login" && (await refreshSession())) return api<T>(path, init, false);
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as {
    data?: T;
    error?: { code: string; message: string; details?: { path: string; issue: string }[] };
  };
  if (!res.ok) throw new ApiError(res.status, body.error?.code ?? "HTTP", body.error?.message ?? `HTTP ${res.status}`, body.error?.details);
  return body.data as T;
}

export interface Me {
  user: { id: string; name: string; email: string; is_platform_operator: boolean; mfa_enabled: boolean };
  current_tenant: { id: string; role: "owner" | "admin" | "analyst" | "viewer" };
  mfa: "ok" | "setup_required";
  tenants: { id: string; name: string; role: string }[];
}
