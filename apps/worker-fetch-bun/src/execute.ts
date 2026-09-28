// I-13 worker-fetch-bun: satu job = satu ATTEMPT pada satu connector — semua sub-query × halaman berurutan
// (pageLimit per sub-query, maxItems total, deadline_at). Item unik per attempt → JSONL.gz di blob store → items_ref.
// Error connector di tengah jalan: item yang sudah diterima TETAP diteruskan (sudah dibayar; CONNECTOR_SPEC §4a).
import { CanonicalItem, type FetchRequestPayload, type FetchResultPayload } from "@smip/contracts";
import {
  type AsyncHandle,
  type Connector,
  type ConnectorContext,
  ConnectorError,
  type FetchRequest,
  HttpClient,
  type RateLimitInfo,
  toConnectorError,
} from "@smip/connector-sdk";
import { type Logger, redactString } from "@smip/observability";
import { createEnvelope } from "@smip/queue";
import type { BlobStore } from "@smip/storage";
import type { AccountLoader } from "./accounts";

export interface FetchDeps {
  connectors: Map<string, Connector>;
  accounts: AccountLoader;
  blobs: BlobStore;
  logger?: Logger;
  now?: () => number;
  /** Retry-After / header rate limit dari provider → rl:dyn (router). */
  onRateLimit?: (accountId: string, info: RateLimitInfo) => Promise<void>;
  /** HANYA test lokal: izinkan http/IP privat pada HttpClient connector. */
  allowPrivateNetwork?: boolean;
}

export async function executeFetch(d: FetchDeps, msg: FetchRequestPayload, outer?: AbortSignal): Promise<FetchResultPayload> {
  const now = d.now ?? Date.now;
  const t0 = now();
  const r = msg.request;
  const base = {
    crawl_run_id: msg.crawl_run_id,
    attempt_no: msg.attempt_no,
    connector_id: msg.connector_id,
    provider_account_id: msg.provider_account_id,
    reservation_id: msg.reservation_id,
  };
  const usage = { requests: 0, results: 0, costUnits: null as number | null, costUnitLabel: null as string | null };
  const items = new Map<string, CanonicalItem>();
  let dropped = 0;
  let rate: RateLimitInfo | null = null;
  let error: ConnectorError | null = null;
  let lastCursor: string | null = null;
  let hasMore = false;
  /** Connector mengembalikan asyncHandle → berhenti; dispatch menjadwalkan fetch.resume dari posisi ini. */
  let pending: { handle: AsyncHandle; queryIndex: number; page: number } | null = null;
  const part = msg.resume?.seq ?? 0;
  const log = d.logger?.child({ crawl_run_id: msg.crawl_run_id, attempt: msg.attempt_no, connector: msg.connector_key });

  const remainingMs = new Date(msg.deadline_at).getTime() - now();
  const signal = AbortSignal.any([...(outer ? [outer] : []), AbortSignal.timeout(Math.max(1, remainingMs))]);
  try {
    const conn = d.connectors.get(msg.connector_key);
    if (!conn)
      throw new ConnectorError("NOT_SUPPORTED", `connector ${msg.connector_key} tidak terdaftar di worker ini`, { scope: "connector" });
    if (conn.manifest.version !== msg.connector_version) {
      log?.warn("versi connector berbeda dengan registry", { registry: msg.connector_version, worker: conn.manifest.version });
    }
    if (remainingMs <= 0) throw new ConnectorError("TIMEOUT", "deadline_at sudah lewat sebelum mulai");
    const acc = await d.accounts(msg.provider_account_id, msg.connector_id);
    const ctx: ConnectorContext = {
      credential: acc.credential,
      config: acc.config,
      http: new HttpClient({ logger: log, allowPrivateNetwork: d.allowPrivateNetwork }),
      logger: log ?? ({ debug() {}, info() {}, warn() {}, error() {}, child: () => ctx.logger } as unknown as Logger),
      signal,
      reportRateLimit: (i) => {
        rate = i;
        if (i.retryAfterMs && d.onRateLimit) void d.onRateLimit(msg.provider_account_id, i).catch(() => {});
      },
      archiveRaw: (page, m) =>
        d.blobs.putJsonl(`raw/${m.platform}/${msg.crawl_run_id}/${msg.attempt_no}-${m.page}-${Bun.randomUUIDv7()}.jsonl.gz`, [page]),
    };
    const queries = r.queries?.length ? r.queries : [undefined];
    const start = msg.resume ? { qi: msg.resume.query_index, page: msg.resume.page } : { qi: 0, page: 1 };
    queryLoop: for (const [qi, q] of queries.entries()) {
      if (qi < start.qi) continue;
      let cursor = r.cursor ?? null;
      for (let page = qi === start.qi ? start.page : 1; page <= r.pageLimit; page++) {
        if (items.size >= r.maxItems) break queryLoop;
        const req: FetchRequest = {
          requestId: Bun.randomUUIDv7(),
          idempotencyKey: `${r.idempotencyKey}.q${qi}.page.${page}`,
          platform: r.platform,
          operation: r.operation,
          query: q,
          targetIds: r.targetIds,
          window: r.window,
          cursor,
          pageLimit: r.pageLimit,
          maxItems: r.maxItems - items.size,
        };
        const resuming = msg.resume && qi === start.qi && page === start.page;
        if (resuming && !conn.resume)
          throw new ConnectorError("NOT_SUPPORTED", "connector tidak mendukung resume async", { scope: "connector" });
        const res = resuming ? await conn.resume!(msg.resume!.async_handle, ctx, req) : await conn.fetch(req, ctx);
        usage.requests += res.usage.requests;
        usage.results += res.usage.results;
        if (res.usage.costUnits !== null) usage.costUnits = (usage.costUnits ?? 0) + res.usage.costUnits;
        usage.costUnitLabel ??= res.usage.costUnitLabel;
        for (const it of res.items) {
          const v = CanonicalItem.safeParse(it);
          if (!v.success) {
            dropped++;
            continue;
          }
          items.set(`${v.data.platform}|${v.data.platform_post_id}`, v.data);
        }
        if (res.asyncHandle) {
          pending = { handle: res.asyncHandle, queryIndex: qi, page };
          break queryLoop;
        }
        lastCursor = res.nextCursor;
        hasMore = res.hasMore && !!res.nextCursor;
        if (!hasMore) break;
        cursor = res.nextCursor;
      }
    }
    if (dropped) log?.warn("item tidak valid dibuang", { dropped });
  } catch (e) {
    error = toConnectorError(e);
    if (signal.aborted && error.code !== "TIMEOUT") error = new ConnectorError("TIMEOUT", "deadline attempt terlampaui", { cause: e });
  }

  const list = [...items.values()];
  const items_ref = list.length
    ? await d.blobs.putJsonl(`batches/${msg.crawl_run_id}/${msg.attempt_no}${part ? `-${part}` : ""}.jsonl.gz`, list)
    : null;
  if (pending && !error) {
    error = new ConnectorError("ASYNC_PENDING", "eksekusi provider masih berjalan", {
      retryAfterMs: pending.handle.pollAfterMs,
      scope: "request",
    });
  }
  const rl = rate as RateLimitInfo | null;
  return {
    ...base,
    outcome: error ? "error" : "success",
    error: error
      ? {
          code: error.code,
          message: redactString(error.message).slice(0, 500),
          retry_after_ms: error.retryAfterMs ?? null,
          scope: error.scope,
          http_status: error.httpStatus ?? null,
        }
      : null,
    items_ref,
    items_count: list.length,
    next_cursor: lastCursor,
    has_more: hasMore,
    async_handle: pending && error?.code === "ASYNC_PENDING" ? pending.handle : null,
    usage,
    duration_ms: Math.max(0, Math.round(now() - t0)),
    rate_limit_info: { remaining: rl?.remaining ?? null, resetAt: rl?.resetAt ?? null },
    part,
    resume_state: pending && error?.code === "ASYNC_PENDING" ? { query_index: pending.queryIndex, page: pending.page } : null,
  };
}

/** jobId fetch.result — unik per bagian (resume async), kalau tidak BullMQ membuang hasil bagian berikutnya. */
export const fetchResultKey = (r: Pick<FetchResultPayload, "crawl_run_id" | "attempt_no" | "part">) =>
  `run.${r.crawl_run_id}.attempt.${r.attempt_no}.result${r.part ? `.${r.part}` : ""}`;

/** Handler bersama consumer fetch.bun & fetch.resume: eksekusi lalu laporkan ke fetch.result. */
export async function fetchAndReport(
  d: FetchDeps,
  queue: { enqueue: (q: "fetch.result", env: ReturnType<typeof createEnvelope<FetchResultPayload>>) => Promise<void> },
  msg: FetchRequestPayload,
  tenantId: string | null,
  signal?: AbortSignal,
): Promise<FetchResultPayload> {
  const res = await executeFetch(d, msg, signal);
  await queue.enqueue(
    "fetch.result",
    createEnvelope({ type: "fetch.result", idempotencyKey: fetchResultKey(res), tenantId, payload: res }),
  );
  return res;
}
