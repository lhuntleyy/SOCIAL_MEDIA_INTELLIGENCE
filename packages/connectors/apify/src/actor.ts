// Connector generik "satu actor Apify = satu connector" (I-17). Alur per sub-query:
//   start run (waitForFinish ≤ 60 s) → SUCCEEDED: ambil dataset → normalisasi
//                                    → masih berjalan: kembalikan asyncHandle (worker menjadwalkan fetch.resume)
// Angka biaya/memori TIDAK di kode: dari connectors.config (operator) — Golden Rule 1.
import type { CanonicalItem } from "@smip/contracts";
import {
  type AsyncHandle,
  type Connector,
  type ConnectorContext,
  ConnectorError,
  type ConnectorManifest,
  type FetchRequest,
  type FetchResult,
  type HealthProbeResult,
  type OperationSupport,
} from "@smip/connector-sdk";
import { APIFY_HOSTS, type ApifyRun, datasetItems, failIfBad, getRun, PLAN_LIMIT_LOG, RUNNING, runLog, startRun } from "./client";

export interface ActorConfig {
  /** Override id actor (mis. fork) — default dari spec. */
  actorId?: string;
  memoryMb?: number;
  maxTotalChargeUsd?: number;
  timeoutSecs?: number;
  /** Detik menunggu dalam satu request fetch/resume (≤ 60). */
  waitSecs?: number;
  pollAfterMs?: number;
}

export const ACTOR_CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    actorId: { type: "string", pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" },
    memoryMb: { type: "integer", minimum: 128 },
    maxTotalChargeUsd: { type: "number", exclusiveMinimum: 0 },
    timeoutSecs: { type: "integer", minimum: 10 },
    waitSecs: { type: "integer", minimum: 0, maximum: 60 },
    pollAfterMs: { type: "integer", minimum: 1000 },
  },
} as const;

export interface ActorSpec {
  key: string;
  platform: string;
  actorId: string;
  version: string;
  displayName: string;
  docsUrl: string;
  operations: ConnectorManifest["operations"];
  buildInput(req: FetchRequest, cfg: ActorConfig): Record<string, unknown>;
  /** null = item dibuang (field wajib hilang / waktu tak pasti). Hanya memetakan field CanonicalItem (minimisasi PII). */
  normalize(
    raw: Record<string, unknown>,
    meta: { key: string; version: string; fetchedAt: string; rawRef: string | null },
  ): CanonicalItem | null;
}

const ASYNC_KIND = "apify-run";

export class ApifyActorConnector implements Connector {
  readonly manifest: ConnectorManifest;
  constructor(private readonly spec: ActorSpec) {
    this.manifest = {
      key: spec.key,
      version: spec.version,
      providerKey: spec.key.split(".")[0]!,
      platform: spec.platform,
      runtime: "bun",
      displayName: spec.displayName,
      credentialKinds: ["api_key"],
      configSchema: ACTOR_CONFIG_SCHEMA,
      operations: spec.operations,
      costModel: { unit: "result", reportsUsageInResponse: true },
      docsUrl: spec.docsUrl,
    };
  }

  private cfg(ctx: ConnectorContext): ActorConfig {
    return ctx.config as ActorConfig;
  }

  private async finish(run: ApifyRun, req: FetchRequest, ctx: ConnectorContext, requests: number): Promise<FetchResult> {
    failIfBad(run);
    const cfg = this.cfg(ctx);
    if (RUNNING.has(run.status)) {
      const handle: AsyncHandle = {
        kind: ASYNC_KIND,
        id: run.id,
        startedAt: new Date(run.startedAt ?? Date.now()).toISOString(),
        pollAfterMs: cfg.pollAfterMs ?? 15_000,
      };
      return {
        items: [],
        nextCursor: null,
        hasMore: true,
        asyncHandle: handle,
        rawRefs: [],
        usage: { requests, results: 0, costUnits: null, costUnitLabel: null },
        upstream: { httpStatuses: [201], requestIds: [run.id] },
        warnings: [],
      };
    }
    const all = (await datasetItems(ctx, run.defaultDatasetId, req.maxItems)) as Record<string, unknown>[];
    // placeholder `{ noResults: true }` (konvensi sebagian actor) bukan hasil & tidak ditagih → jangan dihitung
    const raw = all.filter((r) => r?.noResults !== true);
    if (all.length && !raw.length) {
      const log = await runLog(ctx, run.id).catch(() => "");
      if (PLAN_LIMIT_LOG.test(log)) {
        throw new ConnectorError("QUOTA_EXHAUSTED", "actor menolak: batas run bulanan plan pengguna Apify habis", { scope: "account" });
      }
    }
    const fetchedAt = new Date().toISOString();
    const rawRef = raw.length
      ? await ctx.archiveRaw(raw, { platform: this.spec.platform, crawlRunId: req.idempotencyKey, attemptNo: 1, page: 1 })
      : null;
    const items: CanonicalItem[] = [];
    let dropped = 0;
    for (const r of raw) {
      const it = this.spec.normalize(r, { key: this.spec.key, version: this.spec.version, fetchedAt, rawRef });
      // actor sudah memfilter window; saring lokal sebagai jaring pengaman (contract: published_at ≥ since)
      if (!it || (req.window?.since && it.published_at < req.window.since) || (req.window?.until && it.published_at > req.window.until)) {
        dropped++;
        continue;
      }
      items.push(it);
    }
    if (dropped) ctx.logger.debug("item dibuang normalizer/window", { dropped, returned: raw.length });
    return {
      items: items.slice(0, req.maxItems),
      nextCursor: null, // actor mengembalikan seluruh hasil (≤ maxItems) dalam satu run; tanpa cursor
      hasMore: false,
      rawRefs: rawRef ? [rawRef] : [],
      // biaya dari yang DIKEMBALIKAN provider (CONNECTOR_SPEC §4a); costUnits = USD run menurut Apify
      usage: {
        requests: requests + 1,
        results: raw.length,
        costUnits: run.usageTotalUsd ?? null,
        costUnitLabel: run.usageTotalUsd !== undefined ? "usd" : null,
      },
      upstream: { httpStatuses: [200], requestIds: [run.id] },
      warnings: dropped ? [{ code: "ITEMS_DROPPED", message: `${dropped} item dibuang (normalisasi/window)` }] : [],
    };
  }

  async fetch(req: FetchRequest, ctx: ConnectorContext): Promise<FetchResult> {
    if (ctx.signal.aborted) throw new ConnectorError("TIMEOUT", "deadline sudah lewat");
    if (!this.spec.operations[req.operation])
      throw new ConnectorError("NOT_SUPPORTED", `operation ${req.operation} tidak didukung`, { scope: "connector" });
    const cfg = this.cfg(ctx);
    const actorId = cfg.actorId ?? this.spec.actorId;
    const run = await startRun(ctx, actorId, this.spec.buildInput(req, cfg), {
      memoryMb: cfg.memoryMb,
      maxTotalChargeUsd: cfg.maxTotalChargeUsd,
      timeoutSecs: cfg.timeoutSecs,
      waitSecs: cfg.waitSecs ?? 50,
    });
    return this.finish(run, req, ctx, 1);
  }

  async resume(handle: AsyncHandle, ctx: ConnectorContext, req?: FetchRequest): Promise<FetchResult> {
    if (handle.kind !== ASYNC_KIND)
      throw new ConnectorError("INVALID_QUERY", `async handle ${handle.kind} bukan milik connector Apify`, { scope: "request" });
    if (ctx.signal.aborted) throw new ConnectorError("TIMEOUT", "deadline sudah lewat");
    const run = await getRun(ctx, handle.id, this.cfg(ctx).waitSecs ?? 50);
    return this.finish(run, req ?? ({ maxItems: 1000, idempotencyKey: `resume.${handle.id}` } as FetchRequest), ctx, 1);
  }

  async healthProbe(ctx: ConnectorContext): Promise<HealthProbeResult> {
    // pasif saja untuk connector berbayar per run (CONNECTOR_SPEC §8.2); probe ringan = cek token & kuota akun (gratis)
    const t0 = performance.now();
    try {
      if (ctx.signal.aborted) return { ok: false, latencyMs: 0, errorCode: "TIMEOUT" };
      await ctx.http.request("https://api.apify.com/v2/users/me/limits", {
        signal: ctx.signal,
        headers: { Authorization: `Bearer ${ctx.credential.secret.api_token ?? ""}` },
      });
      return { ok: true, latencyMs: Math.round(performance.now() - t0) };
    } catch (e) {
      return { ok: false, latencyMs: Math.round(performance.now() - t0), errorCode: e instanceof ConnectorError ? e.code : "UNKNOWN" };
    }
  }
}

export const allowedHosts = APIFY_HOSTS;
export type { OperationSupport };
