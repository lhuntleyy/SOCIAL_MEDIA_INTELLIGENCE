// I-13 worker-dispatch (QUEUE_SPEC §5, ARCHITECTURE §4):
//   crawl.dispatch → CAS run queued→dispatching → Router.plan (reservasi) → compile sub-query → fetch.<runtime>
//   fetch.result   → CAS attempt → reportOutcome (settle + failover + health) → provider_attempts →
//                    pipeline.items (item diterima) + dispatch ulang / selesai / gagal.
// Semua enqueue lewat outbox dalam transaksi yang sama dengan update run (tidak ada job/run "hantu");
// pesan duplikat/terlambat diabaikan oleh compare-and-set status + nomor attempt.
import type { AttemptOutcome, FailoverDecision, RouteInput } from "@smip/core";
import type { CrawlDispatchPayload, FetchRequestPayload, FetchResultPayload, PipelineItemsPayload, QueryFeature } from "@smip/contracts";
import { type Db, finalizeRunIfDone, jsonbValue, settleGap, type Tx, withSystem, writeJobOutbox } from "@smip/db";
import type { Logger } from "@smip/observability";
import { compileGeneric, coverHashtags, type Node } from "@smip/query";
import { failureBackoffSec, type Router, shouldAlertConsecutive, type Snapshot } from "@smip/router";
import { sql } from "drizzle-orm";

export interface Routing {
  policy_id?: string;
  connector_id?: string;
  account_id?: string;
  reservation_id?: string;
  exclude_connector_ids: string[];
  exclude_account_ids: string[];
  same_retries: number;
  recompiled: boolean;
  /** Request fetch attempt aktif (dipakai ulang oleh fetch.resume). */
  fetch?: FetchRequestPayload;
  /** Jumlah resume async attempt aktif (= nomor bagian berikutnya yang diharapkan). */
  resumes?: number;
  /** Pemakaian yang dilaporkan bagian-bagian sebelumnya (di-commit sekali di hasil akhir). */
  usage_acc?: { requests: number; results: number; costUnits: number | null };
}

/** Batas resume per attempt (× pollAfterMs ≈ lama maksimum menunggu run async) sebelum dianggap TIMEOUT → failover. */
export const MAX_RESUMES = 40;

export interface DispatchDeps {
  db: Db;
  router: Pick<Router, "planWithTrace" | "reportOutcome" | "release">;
  snapshots: { get(): Promise<Snapshot> };
  now?: () => Date;
  logger?: Logger;
  fetch?: { pageLimit?: number; maxItems?: number; timeoutMs?: number };
  onAlert?: (e: { kind: "consecutive_failures"; planId: string; count: number }) => void;
}

type RunRow = {
  id: string;
  scheduled_for: Date;
  /** nilai persis (mikrodetik) untuk WHERE — Date JS hanya milidetik */
  sf: string;
  status: string;
  attempts: number;
  routing: Partial<Routing>;
  tenant_id: string | null;
  crawl_plan_id: string | null;
  kind: CrawlDispatchPayload["run_kind"];
  window_from: Date | null;
  window_to: Date | null;
  items_fetched: number;
};
type PlanRow = {
  plan_status: string;
  interval_sec: number;
  topic_id: string;
  topic_query_id: string;
  platform_code: string;
  operation: CrawlDispatchPayload["operation"];
  query_ast: Node & { version?: number };
  query_enabled: boolean;
  topic_status: string;
};

const RETRYABLE_WAIT_MIN_MS = 1000;
const iso = (d: Date) => d.toISOString();
const routingOf = (r: Partial<Routing> | null | undefined): Routing => ({
  exclude_connector_ids: [],
  exclude_account_ids: [],
  same_retries: 0,
  recompiled: false,
  ...(r ?? {}),
});

/** Fitur query yang dipakai AST (router: eliminasi FEATURES_UNSUPPORTED). */
export function astFeatures(n: Node, depth = 0, out = new Set<QueryFeature>()): QueryFeature[] {
  switch (n.type) {
    case "term":
      out.add("term");
      break;
    case "phrase":
      out.add("phrase");
      break;
    case "not":
      out.add("not");
      astFeatures(n.child, depth + 1, out);
      break;
    default:
      out.add(n.type);
      if (depth > 0) out.add("group");
      for (const c of n.children) astFeatures(c, depth + 1, out);
  }
  return [...out];
}

async function loadRun(tx: Tx, where: ReturnType<typeof sql>): Promise<RunRow | undefined> {
  const [r] =
    (await tx.execute(sql`select id, scheduled_for, scheduled_for::text as sf, status, attempts, routing, tenant_id, crawl_plan_id, kind, window_from, window_to, items_fetched
    from crawl_runs where ${where} for update`)) as unknown as RunRow[];
  return r;
}
async function loadPlan(tx: Tx, planId: string): Promise<PlanRow | undefined> {
  const [p] =
    (await tx.execute(sql`select p.status as plan_status, p.interval_sec, p.topic_id, p.topic_query_id, p.platform_code, p.operation,
      q.query_ast, q.enabled as query_enabled, t.status as topic_status
    from crawl_plans p join topic_queries q on q.id = p.topic_query_id join topics t on t.id = p.topic_id
    where p.id = ${planId}`)) as unknown as PlanRow[];
  return p;
}

async function finishRun(
  tx: Tx,
  run: RunRow,
  status: "succeeded" | "failed" | "skipped" | "cancelled",
  now: Date,
  error?: { code: string; message: string },
) {
  await tx.execute(sql`update crawl_runs set status = ${status}::e_run_status, finished_at = ${iso(now)}::timestamptz,
    error_code = ${error?.code ?? null}, error_message = ${error?.message ?? null}
    where id = ${run.id} and scheduled_for = ${run.sf}::timestamptz`);
}

/** Plan dibebaskan; gagal → consecutive_failures++ dan backoff eksponensial next_run_at (R-08, cap 4× interval). */
async function releasePlan(
  tx: Tx,
  d: DispatchDeps,
  run: RunRow,
  outcome: "success" | "failure" | "neutral",
  intervalSec: number,
  now: Date,
) {
  if (!run.crawl_plan_id) return;
  if (run.kind === "backfill") await settleGap(tx, run.crawl_plan_id, run.id, false);
  if (outcome === "failure") {
    const [p] = (await tx.execute(sql`update crawl_plans set consecutive_failures = consecutive_failures + 1, updated_at = now(),
        inflight_run_id = case when inflight_run_id = ${run.id} then null else inflight_run_id end
      where id = ${run.crawl_plan_id} returning consecutive_failures`)) as unknown as { consecutive_failures: number }[];
    const n = p?.consecutive_failures ?? 1;
    const next = new Date(now.getTime() + failureBackoffSec(intervalSec, n) * 1000);
    await tx.execute(
      sql`update crawl_plans set next_run_at = greatest(next_run_at, ${iso(next)}::timestamptz) where id = ${run.crawl_plan_id}`,
    );
    if (shouldAlertConsecutive(n)) {
      d.logger?.warn("plan gagal berturut-turut", { plan_id: run.crawl_plan_id, count: n });
      d.onAlert?.({ kind: "consecutive_failures", planId: run.crawl_plan_id, count: n });
    }
    return;
  }
  await tx.execute(sql`update crawl_plans set updated_at = now(),
      inflight_run_id = case when inflight_run_id = ${run.id} then null else inflight_run_id end
      ${outcome === "success" ? sql`, consecutive_failures = 0` : sql``}
    where id = ${run.crawl_plan_id}`);
}

async function redispatch(
  tx: Tx,
  run: RunRow,
  plan: PlanRow,
  attemptNo: number,
  routing: Routing,
  delayMs: number,
  key: string,
  recompile = false,
) {
  await tx.execute(sql`update crawl_runs set status = 'queued', routing = ${jsonbValue(routing)}
    where id = ${run.id} and scheduled_for = ${run.sf}::timestamptz`);
  const payload: CrawlDispatchPayload = {
    crawl_run_id: run.id,
    scheduled_for: iso(run.scheduled_for),
    crawl_plan_id: run.crawl_plan_id!,
    topic_id: plan.topic_id,
    topic_query_id: plan.topic_query_id,
    platform: plan.platform_code,
    operation: plan.operation,
    run_kind: run.kind,
    window: { since: run.window_from ? iso(run.window_from) : undefined, until: run.window_to ? iso(run.window_to) : undefined },
    interval_sec: plan.interval_sec,
    attempt_no: attemptNo,
    exclude_connector_ids: routing.exclude_connector_ids,
    exclude_account_ids: routing.exclude_account_ids,
    ...(recompile ? { recompile: true } : {}),
  };
  await writeJobOutbox(tx, run.id, {
    queue: "crawl.dispatch",
    idempotencyKey: key,
    type: "crawl.dispatch",
    tenantId: run.tenant_id,
    payload,
    delayMs: delayMs > 0 ? delayMs : undefined,
  });
}

/** Sub-query sesuai kemampuan connector terpilih; recompile → paling konservatif (hanya term). */
export function compileFor(
  snap: Snapshot,
  connectorId: string,
  operation: string,
  ast: Node,
  recompile: boolean,
): { native: string; sourceNodeIds: string[] }[] {
  if (operation === "search_hashtag") return coverHashtags(ast).map((h) => ({ native: `#${h}`, sourceNodeIds: [h] }));
  const cap = snap.connectors.get(connectorId)?.capabilities.get(operation);
  const caps = recompile
    ? { queryFeatures: ["term"] as QueryFeature[], maxQueryLength: null }
    : { queryFeatures: cap?.queryFeatures ?? ["term"], maxQueryLength: cap?.maxQueryLength ?? null };
  return compileGeneric(ast, caps).map((s) => ({ native: s.native, sourceNodeIds: s.leaves }));
}

export async function handleDispatch(
  d: DispatchDeps,
  m: CrawlDispatchPayload,
): Promise<"ignored" | "fetching" | "waiting" | "skipped" | "failed" | "cancelled"> {
  const now = d.now?.() ?? new Date();
  const f = { pageLimit: 3, maxItems: 300, timeoutMs: 120_000, ...d.fetch };
  return withSystem(d.db, async (tx) => {
    // cari per id (index PK tiap partisi); scheduled_for di payload bisa kehilangan presisi mikrodetik
    const run = await loadRun(tx, sql`id = ${m.crawl_run_id}`);
    if (run?.status !== "queued" || run.attempts >= m.attempt_no) return "ignored";
    const plan = run.crawl_plan_id ? await loadPlan(tx, run.crawl_plan_id) : undefined;
    if (!plan || plan.plan_status === "disabled" || plan.topic_status !== "active" || !plan.query_enabled) {
      await finishRun(tx, run, "cancelled", now, { code: "PLAN_INACTIVE", message: "plan/topik/query tidak aktif saat dispatch" });
      await releasePlan(tx, d, run, "neutral", plan?.interval_sec ?? m.interval_sec, now);
      return "cancelled";
    }
    await tx.execute(sql`update crawl_runs set status = 'dispatching' where id = ${run.id} and scheduled_for = ${run.sf}::timestamptz`);
    const routing = routingOf(run.routing);
    routing.exclude_connector_ids = [...new Set([...routing.exclude_connector_ids, ...m.exclude_connector_ids])];
    routing.exclude_account_ids = [...new Set([...routing.exclude_account_ids, ...m.exclude_account_ids])];
    if (m.recompile) routing.recompiled = true;
    const { version: _v, ...ast } = plan.query_ast;
    const input: RouteInput = {
      tenantId: run.tenant_id!,
      platform: plan.platform_code,
      operation: plan.operation,
      runKind: run.kind,
      requiredFeatures: astFeatures(ast as Node),
      intervalSec: plan.interval_sec,
      excludeConnectorIds: routing.exclude_connector_ids,
      excludeAccountIds: routing.exclude_account_ids,
      // results = 0: quota hasil dipotong saat commit (aktual); hard quota tetap memblok saat used ≥ limit
      estimatedUnits: { requests: f.pageLimit, results: 0 },
      topicId: plan.topic_id,
    };
    const { decision, trace } = await d.router.planWithTrace(input);
    if (decision.kind === "none_available") {
      d.logger?.info("tidak ada rute", { crawl_run_id: run.id, reason: decision.reason, trace });
      if (decision.reason === "QUOTA_EXHAUSTED") {
        await finishRun(tx, run, "skipped", now, { code: "QUOTA_EXHAUSTED", message: "hard quota habis (CONNECTOR_SPEC §11)" });
        await releasePlan(tx, d, run, "neutral", plan.interval_sec, now);
        return "skipped";
      }
      if (decision.reason === "ALL_THROTTLED") {
        const delay = Math.max(RETRYABLE_WAIT_MIN_MS, decision.retryAfterMs);
        await redispatch(
          tx,
          run,
          plan,
          m.attempt_no,
          routing,
          delay,
          `run.${run.id}.attempt.${m.attempt_no}.wait.${now.getTime()}`,
          routing.recompiled,
        );
        return "waiting";
      }
      await finishRun(tx, run, "failed", now, { code: decision.reason, message: "tidak ada connector yang layak" });
      await releasePlan(tx, d, run, "failure", plan.interval_sec, now);
      return "failed";
    }
    const snap = await d.snapshots.get();
    const queries = plan.operation.startsWith("search_")
      ? compileFor(snap, decision.connectorId, plan.operation, ast as Node, routing.recompiled)
      : undefined;
    if (queries && !queries.length) {
      await d.router.release(decision.reservationId);
      await finishRun(tx, run, "failed", now, { code: "INVALID_QUERY", message: "query tidak punya term positif untuk dicari" });
      await releasePlan(tx, d, run, "failure", plan.interval_sec, now);
      return "failed";
    }
    Object.assign(routing, {
      policy_id: decision.policyId,
      connector_id: decision.connectorId,
      account_id: decision.accountId,
      reservation_id: decision.reservationId,
    });
    await tx.execute(sql`update crawl_runs set status = 'fetching', attempts = ${m.attempt_no}, started_at = coalesce(started_at, ${iso(now)}::timestamptz),
      routing = ${jsonbValue(routing)} where id = ${run.id} and scheduled_for = ${run.sf}::timestamptz`);
    const payload: FetchRequestPayload = {
      crawl_run_id: run.id,
      attempt_no: m.attempt_no,
      connector_id: decision.connectorId,
      connector_key: decision.connectorKey,
      connector_version: snap.connectors.get(decision.connectorId)?.version ?? "0.0.0",
      provider_account_id: decision.accountId,
      reservation_id: decision.reservationId,
      request: {
        requestId: Bun.randomUUIDv7(),
        idempotencyKey: `run.${run.id}.attempt.${m.attempt_no}`,
        platform: plan.platform_code,
        operation: plan.operation,
        ...(queries ? { queries } : {}),
        window: { since: run.window_from ? iso(run.window_from) : undefined, until: run.window_to ? iso(run.window_to) : undefined },
        cursor: null,
        pageLimit: f.pageLimit,
        maxItems: f.maxItems,
      },
      deadline_at: iso(new Date(now.getTime() + f.timeoutMs)),
    };
    routing.fetch = payload;
    routing.resumes = 0;
    routing.usage_acc = { requests: 0, results: 0, costUnits: null };
    await tx.execute(
      sql`update crawl_runs set routing = ${jsonbValue(routing)} where id = ${run.id} and scheduled_for = ${run.sf}::timestamptz`,
    );
    await writeJobOutbox(tx, run.id, {
      queue: decision.runtime === "python" ? "fetch.py" : "fetch.bun",
      idempotencyKey: `run.${run.id}.attempt.${m.attempt_no}`,
      type: "fetch.request",
      tenantId: run.tenant_id,
      payload,
    });
    return "fetching";
  });
}

const OUTCOME: Record<FailoverDecision["action"], "success" | "retryable_error" | "failover_error" | "fatal_error"> = {
  done: "success",
  retry_same: "retryable_error",
  recompile: "retryable_error",
  resume: "retryable_error",
  failover: "failover_error",
  fail: "fatal_error",
};

export async function handleFetchResult(d: DispatchDeps, m: FetchResultPayload): Promise<FailoverDecision["action"] | "ignored"> {
  const now = d.now?.() ?? new Date();
  return withSystem(d.db, async (tx) => {
    const run = await loadRun(tx, sql`id = ${m.crawl_run_id}`);
    if (run?.status !== "fetching" || run.attempts !== m.attempt_no) return "ignored";
    const plan = (await loadPlan(tx, run.crawl_plan_id!))!;
    const routing = routingOf(run.routing);
    const part = m.part ?? 0;
    if (part !== (routing.resumes ?? 0)) return "ignored"; // hasil bagian basi/duplikat
    const acc = routing.usage_acc ?? { requests: 0, results: 0, costUnits: null };
    const usage = {
      requests: acc.requests + m.usage.requests,
      results: acc.results + m.usage.results,
      costUnits: acc.costUnits === null && m.usage.costUnits === null ? null : (acc.costUnits ?? 0) + (m.usage.costUnits ?? 0),
    };
    const tooLong = m.error?.code === "ASYNC_PENDING" && (routing.resumes ?? 0) >= MAX_RESUMES;
    const outcome: AttemptOutcome = {
      reservationId: m.reservation_id,
      connectorId: m.connector_id,
      accountId: m.provider_account_id,
      ok: m.outcome === "success",
      // terlalu lama menunggu run async → perlakukan TIMEOUT (failover), reservasi di-settle
      errorCode: tooLong ? "TIMEOUT" : m.error?.code,
      errorScope: tooLong ? "connector" : m.error?.scope,
      retryAfterMs: m.error?.retry_after_ms ?? undefined,
      latencyMs: m.duration_ms,
      usage,
    };
    let decision: FailoverDecision = await d.router.reportOutcome(outcome, {
      policyId: routing.policy_id ?? "",
      operation: plan.operation,
      attempt: m.attempt_no,
      sameRetries: routing.same_retries,
      recompiled: routing.recompiled,
    });
    if (decision.action === "resume" && !(m.async_handle && m.resume_state && routing.fetch)) {
      decision = { action: "fail", reason: "ASYNC_PENDING tanpa async_handle/state — tidak bisa dilanjutkan" };
    }

    if (decision.action !== "resume")
      await tx.execute(sql`insert into provider_attempts (id, crawl_run_id, crawl_run_scheduled_for, tenant_id, connector_id, provider_account_id, attempt_no,
        started_at, duration_ms, outcome, error_code, http_status, items, usage)
      values (${Bun.randomUUIDv7()}, ${run.id}, ${run.sf}::timestamptz, ${run.tenant_id}, ${m.connector_id}, ${m.provider_account_id}, ${m.attempt_no},
        ${iso(new Date(now.getTime() - m.duration_ms))}::timestamptz, ${m.duration_ms}, ${OUTCOME[decision.action]}::e_attempt_outcome,
        ${tooLong ? "TIMEOUT" : (m.error?.code ?? null)}, ${m.error?.http_status ?? null}, ${m.items_count}, ${jsonbValue(usage)})`);

    const itemsTotal = run.items_fetched + m.items_count;
    if (m.items_count > 0 && m.items_ref) {
      const payload: PipelineItemsPayload = {
        crawl_run_id: run.id,
        attempt_no: m.attempt_no,
        tenant_id: run.tenant_id,
        topic_id: plan.topic_id,
        topic_query_id: plan.topic_query_id,
        query_ast_version: plan.query_ast.version ?? 1,
        part,
        items_ref: m.items_ref,
        items_count: m.items_count,
      };
      await writeJobOutbox(tx, run.id, {
        queue: "pipeline.items",
        idempotencyKey: `pipe.${run.id}.${m.attempt_no}${part ? `.${part}` : ""}`,
        type: "pipeline.items",
        tenantId: run.tenant_id,
        payload,
      });
    }
    const queued = m.items_count > 0 && m.items_ref ? 1 : 0;
    await tx.execute(sql`update crawl_runs set items_fetched = ${itemsTotal}, routing = ${jsonbValue(routing)}, pending_batches = pending_batches + ${queued}
      ${decision.action === "done" ? sql`, final_connector_id = ${m.connector_id}` : sql``}
      where id = ${run.id} and scheduled_for = ${run.sf}::timestamptz`);

    const next = m.attempt_no + 1;
    if (decision.action === "resume") {
      // attempt masih berjalan di provider: pegang reservasi, jadwalkan fetch.resume dari posisi terakhir
      routing.resumes = (routing.resumes ?? 0) + 1;
      routing.usage_acc = usage;
      await tx.execute(
        sql`update crawl_runs set routing = ${jsonbValue(routing)} where id = ${run.id} and scheduled_for = ${run.sf}::timestamptz`,
      );
      const f = { timeoutMs: 120_000, ...d.fetch };
      const resume: FetchRequestPayload = {
        ...routing.fetch!,
        deadline_at: iso(new Date(now.getTime() + decision.delayMs + f.timeoutMs)),
        resume: {
          async_handle: m.async_handle!,
          query_index: m.resume_state!.query_index,
          page: m.resume_state!.page,
          seq: routing.resumes,
        },
      };
      await writeJobOutbox(tx, run.id, {
        queue: "fetch.resume",
        idempotencyKey: `run.${run.id}.attempt.${m.attempt_no}.resume.${routing.resumes}`,
        type: "fetch.resume",
        tenantId: run.tenant_id,
        payload: resume,
        delayMs: decision.delayMs,
      });
      return "resume";
    }
    switch (decision.action) {
      case "done":
        if (itemsTotal > 0) {
          // ditutup oleh yang terakhir menurunkan pending_batches (pipeline/sink) — atau di sini bila hilir sudah selesai
          await tx.execute(
            sql`update crawl_runs set status = 'processing' where id = ${run.id} and scheduled_for = ${run.sf}::timestamptz`,
          );
          await finalizeRunIfDone(tx, run.id, now);
        } else {
          await finishRun(tx, run, "succeeded", now);
          await releasePlan(tx, d, run, "success", plan.interval_sec, now);
        }
        break;
      case "failover":
        if (decision.excludeConnectorId) routing.exclude_connector_ids.push(decision.excludeConnectorId);
        if (decision.excludeAccountId) routing.exclude_account_ids.push(decision.excludeAccountId);
        routing.same_retries = 0;
        await redispatch(tx, run, plan, next, routing, decision.delayMs, `run.${run.id}.attempt.${next}`, routing.recompiled);
        break;
      case "retry_same":
        // tanpa exclude: router boleh memilih connector yang sama (bobot tertinggi) setelah backoff
        routing.same_retries++;
        await redispatch(tx, run, plan, next, routing, decision.delayMs, `run.${run.id}.attempt.${next}`, routing.recompiled);
        break;
      case "recompile":
        routing.recompiled = true;
        await redispatch(tx, run, plan, next, routing, 0, `run.${run.id}.attempt.${next}`, true);
        break;
      case "fail": {
        const err = { code: m.error?.code ?? "FAILED", message: decision.reason.slice(0, 500) };
        if (itemsTotal > 0) {
          // item yang sudah diterima tetap diproses; run ditutup sebagai partial saat hilir selesai
          await tx.execute(sql`update crawl_runs set status = 'processing', error_code = ${err.code}, error_message = ${err.message}
            where id = ${run.id} and scheduled_for = ${run.sf}::timestamptz`);
          await finalizeRunIfDone(tx, run.id, now);
        } else {
          await finishRun(tx, run, "failed", now, err);
          await releasePlan(tx, d, run, "failure", plan.interval_sec, now);
        }
        break;
      }
    }
    return decision.action;
  });
}
