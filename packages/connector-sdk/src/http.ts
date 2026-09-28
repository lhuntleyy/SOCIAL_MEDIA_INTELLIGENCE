// HttpClient connector (SECURITY §1 SSRF, §5 redaction; CONNECTOR_SPEC §3 ConnectorContext.http).
// Guard SSRF di sini = lapis aplikasi; kontrol utama produksi tetap egress proxy + NetworkPolicy (SECURITY §6).
// Residual risk: DNS rebinding antara resolve & connect (Bun fetch tidak bisa mem-pin IP) — ditutup oleh egress proxy.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { type Logger, redactString } from "@smip/observability";
import { ConnectorError, codeForStatus } from "./errors";

export interface HttpClientOptions {
  /** Host yang boleh dihubungi (exact atau sufiks ".domain"). Kosong = semua host publik. */
  allowedHosts?: string[];
  timeoutMs?: number;
  logger?: Logger;
  /** HANYA test/dev lokal: izinkan http:// & IP privat. Dilarang di produksi (dicek pemanggil via config). */
  allowPrivateNetwork?: boolean;
  resolver?: (host: string) => Promise<string[]>;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export interface RequestOptions extends Omit<RequestInit, "signal"> {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Default true: status non-2xx → ConnectorError terklasifikasi. */
  throwOnStatus?: boolean;
}

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}
const V4_BLOCKS: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // termasuk metadata cloud 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/** true bila alamat BUKAN publik (privat, loopback, link-local, CGNAT, multicast, reserved, IPv6 ULA/link-local/mapped). */
export function isNonPublicIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const n = v4ToInt(ip);
    return V4_BLOCKS.some(([base, bits]) => (n & (bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0)) >>> 0 === v4ToInt(base));
  }
  if (v === 6) {
    const s = ip.toLowerCase().replace(/^\[|\]$/g, "");
    const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isNonPublicIp(mapped[1]!);
    return s === "::" || s === "::1" || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s);
  }
  return true; // bukan IP valid → anggap tidak aman
}

const hostAllowed = (host: string, allow: string[]) => allow.some((a) => host === a || host.endsWith(`.${a}`));

export class HttpClient {
  private readonly o: Required<Pick<HttpClientOptions, "timeoutMs" | "allowedHosts">> & HttpClientOptions;
  constructor(opts: HttpClientOptions = {}) {
    this.o = { timeoutMs: 30_000, allowedHosts: [], ...opts };
  }

  /** Validasi URL tujuan (dipanggil juga saat admin menyimpan config connector — SEC-07). */
  async assertSafeUrl(raw: string): Promise<URL> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ConnectorError("INVALID_QUERY", "URL tidak valid", { scope: "connector" });
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (url.protocol !== "https:" && !(this.o.allowPrivateNetwork && url.protocol === "http:")) {
      throw new ConnectorError("FORBIDDEN", `SSRF guard: skema ${url.protocol} ditolak (wajib https)`, { scope: "connector" });
    }
    if (url.username || url.password)
      throw new ConnectorError("FORBIDDEN", "SSRF guard: kredensial di URL ditolak", { scope: "connector" });
    if (this.o.allowedHosts.length && !hostAllowed(host, this.o.allowedHosts)) {
      throw new ConnectorError("FORBIDDEN", `SSRF guard: host ${host} di luar allowlist connector`, { scope: "connector" });
    }
    if (!this.o.allowPrivateNetwork) {
      const addrs = isIP(host)
        ? [host]
        : await (this.o.resolver ?? (async (h: string) => (await lookup(h, { all: true })).map((a) => a.address)))(host).catch(() => {
            throw new ConnectorError("NETWORK", `DNS gagal untuk ${host}`, { scope: "connector" });
          });
      if (!addrs.length || addrs.some(isNonPublicIp)) {
        throw new ConnectorError("FORBIDDEN", `SSRF guard: ${host} mengarah ke alamat non-publik`, { scope: "connector" });
      }
    }
    return url;
  }

  async request(raw: string, opts: RequestOptions = {}): Promise<Response> {
    const url = await this.assertSafeUrl(raw);
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? this.o.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const t0 = performance.now();
    let res: Response;
    try {
      // redirect manual: tujuan redirect juga harus lolos guard SSRF
      res = await (this.o.fetchImpl ?? fetch)(url, { ...opts, signal, redirect: "manual" });
    } catch (e) {
      const err = e as Error;
      if (err.name === "AbortError" || err.name === "TimeoutError" || signal.aborted) {
        throw new ConnectorError("TIMEOUT", `timeout/abort setelah ${Math.round(performance.now() - t0)} ms`, { cause: e });
      }
      throw new ConnectorError("NETWORK", redactString(err.message), { cause: e });
    }
    this.o.logger?.debug("http", {
      method: opts.method ?? "GET",
      url: redactString(url.toString()),
      status: res.status,
      ms: Math.round(performance.now() - t0),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      const next = new URL(res.headers.get("location")!, url).toString();
      return this.request(next, { ...opts, signal: opts.signal });
    }
    if (!res.ok && opts.throwOnStatus !== false) {
      const body = redactString((await res.text().catch(() => "")).slice(0, 300));
      throw new ConnectorError(codeForStatus(res.status), `HTTP ${res.status}${body ? `: ${body}` : ""}`, {
        httpStatus: res.status,
        retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
      });
    }
    return res;
  }

  async json<T>(raw: string, opts: RequestOptions = {}): Promise<{ data: T; res: Response }> {
    const res = await this.request(raw, opts);
    try {
      return { data: (await res.json()) as T, res };
    } catch (e) {
      throw new ConnectorError("PARSE_ERROR", "respons bukan JSON valid", { cause: e, httpStatus: res.status });
    }
  }
}

/** Retry-After: detik atau HTTP-date → ms. */
export function parseRetryAfter(v: string | null, now = Date.now()): number | undefined {
  if (!v) return undefined;
  if (/^\d+$/.test(v.trim())) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : Math.max(0, t - now);
}
