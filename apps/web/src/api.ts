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

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  return (await apiFull<T>(path, init)).data;
}

/** Seperti api(), tapi juga mengembalikan `meta` (mis. total untuk drill-down post). */
export async function apiFull<T>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
  retry = true,
): Promise<{ data: T; meta: Record<string, unknown> }> {
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
  if (res.status === 401 && retry && path !== "/auth/login" && (await refreshSession())) return apiFull<T>(path, init, false);
  if (res.status === 204) return { data: undefined as T, meta: {} };
  const body = (await res.json().catch(() => ({}))) as {
    data?: T;
    meta?: Record<string, unknown>;
    error?: { code: string; message: string; details?: { path: string; issue: string }[] };
  };
  if (!res.ok) throw new ApiError(res.status, body.error?.code ?? "HTTP", body.error?.message ?? `HTTP ${res.status}`, body.error?.details);
  return { data: body.data as T, meta: body.meta ?? {} };
}

/** Unduh file dari API (auth header ikut) → disimpan browser dengan nama dari Content-Disposition. */
export async function apiDownload(path: string, retry = true): Promise<{ rows: number; truncated: boolean }> {
  const headers = new Headers();
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  if (viewAs) {
    headers.set("x-tenant-id", viewAs.tenantId);
    headers.set("x-impersonation-reason", viewAs.reason);
  }
  const res = await fetch(`/v1${path}`, { headers, credentials: "same-origin" });
  if (res.status === 401 && retry && (await refreshSession())) return apiDownload(path, false);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } };
    throw new ApiError(res.status, body.error?.code ?? "HTTP", body.error?.message ?? `HTTP ${res.status}`);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "smip-export";
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { rows: Number(res.headers.get("x-smip-rows") ?? 0), truncated: res.headers.get("x-smip-truncated") === "true" };
}

export interface Me {
  user: { id: string; name: string; email: string; is_platform_operator: boolean; mfa_enabled: boolean };
  current_tenant: { id: string; role: "owner" | "admin" | "analyst" | "viewer" };
  mfa: "ok" | "setup_required";
  tenants: { id: string; name: string; role: string; kind?: "office" | "platform" }[];
}
