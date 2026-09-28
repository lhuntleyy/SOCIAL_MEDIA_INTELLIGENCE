// I-05: connector `fake` deterministik & dapat diskenariokan (TESTING §3) — dev (seed dev:up), test, chaos/failover.
//   const fake = new FakeConnector({ platform: "x", variant: "a" });
//   fake.script([{ op: "search_keyword", respond: { items: [...], nextCursor: null } },
//                { op: "search_keyword", fail: { code: "RATE_LIMITED", retryAfterMs: 30000 } },
//                { op: "search_keyword", delayMs: 5000 },            // untuk timeout
//                { op: "search_keyword", respond: { items: MALFORMED } }]);  // → PARSE_ERROR
import { CanonicalItem, type ConnectorErrorCode, type Operation } from "@smip/contracts";
import {
  type Connector,
  type ConnectorContext,
  ConnectorError,
  type ConnectorManifest,
  type FetchRequest,
  type FetchResult,
  type HealthProbeResult,
  type OperationSupport,
} from "@smip/connector-sdk";

export interface FakeRespond {
  items: unknown[];
  nextCursor?: string | null;
  /** Jumlah hasil yang "dikembalikan provider" (≥ items; simulasi item duplikat/terbuang — P-15). */
  returned?: number;
}
export interface FakeStep {
  op?: Operation;
  respond?: FakeRespond;
  fail?: { code: ConnectorErrorCode; retryAfterMs?: number; httpStatus?: number };
  delayMs?: number;
}

const OP: OperationSupport = {
  queryFeatures: ["term", "phrase", "or", "and", "not", "group"],
  maxQueryLength: 512,
  supportsSince: true,
  supportsUntil: true,
  supportsCursor: true,
  maxPageSize: 100,
  returnsFields: ["metrics.likes", "author.followers"],
  asyncExecution: false,
  resultOrder: "desc",
};

/** Item canonical valid untuk seed/test. */
export function fakeItem(platform: string, n: number, over: Partial<CanonicalItem> = {}): CanonicalItem {
  const at = new Date(Date.UTC(2026, 8, 27, 10, 0, 0) + n * 60_000).toISOString();
  return {
    schema: "canonical-item/v1",
    platform,
    platform_post_id: String(1830000000000000000n + BigInt(n)),
    content_type: "post",
    url: `https://example.invalid/${platform}/${n}`,
    text: `post fake ${n} tentang kopdes`,
    lang_hint: null,
    published_at: at,
    parent: null,
    root_post_id: null,
    author: {
      platform_user_id: `u${n % 7}`,
      handle: `akun${n % 7}`,
      display_name: null,
      followers: null,
      following: null,
      verified: null,
      created_at: null,
      location_raw: null,
      avatar_url: null,
    },
    metrics: { likes: n, comments: null, shares: null, views: null, quotes: null, saves: null, captured_at: at },
    hashtags: [],
    mentions: [],
    media: [],
    geo: { lat: null, lng: null, place_name: null },
    is_ad: null,
    extra: {},
    provenance: { connector_key: `fake.${platform}`, connector_version: "0.1.0", fetched_at: at, raw_ref: null },
    ...over,
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new ConnectorError("TIMEOUT", "dibatalkan sebelum mulai"));
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new ConnectorError("TIMEOUT", `deadline terlampaui setelah menunggu (delay ${ms} ms)`));
      },
      { once: true },
    );
  });
}

export class FakeConnector implements Connector {
  readonly manifest: ConnectorManifest;
  private steps: FakeStep[] = [];
  private healthy = true;
  /** Jejak panggilan (untuk assert di test router/failover). */
  readonly calls: FetchRequest[] = [];

  constructor(opts: { platform: string; variant?: string }) {
    const key = `fake.${opts.platform}${opts.variant ? `.${opts.variant}` : ""}`;
    this.manifest = {
      key,
      version: "0.1.0",
      providerKey: "fake",
      platform: opts.platform,
      runtime: "bun",
      displayName: `Fake ${opts.platform}${opts.variant ? ` (${opts.variant})` : ""}`,
      credentialKinds: ["api_key", "none"],
      configSchema: { type: "object", additionalProperties: false, properties: {} },
      operations: { search_keyword: OP, search_hashtag: OP, user_timeline: OP, post_detail: { ...OP, queryFeatures: [] } },
      costModel: { unit: "result", reportsUsageInResponse: true },
      docsUrl: "https://example.invalid/fake-connector",
    };
  }

  script(steps: FakeStep[]): this {
    this.steps.push(...steps);
    return this;
  }
  reset(): this {
    this.steps = [];
    this.calls.length = 0;
    this.healthy = true;
    return this;
  }
  setHealthy(ok: boolean): this {
    this.healthy = ok;
    return this;
  }

  async fetch(req: FetchRequest, ctx: ConnectorContext): Promise<FetchResult> {
    if (ctx.signal.aborted) throw new ConnectorError("TIMEOUT", "deadline sudah lewat");
    if (!this.manifest.operations[req.operation]) throw new ConnectorError("NOT_SUPPORTED", `operation ${req.operation} tidak didukung`);
    this.calls.push(req);
    const i = this.steps.findIndex((s) => !s.op || s.op === req.operation);
    const step = i >= 0 ? this.steps.splice(i, 1)[0]! : { respond: { items: [] } };
    if (step.delayMs) await sleep(step.delayMs, ctx.signal);
    if (step.fail) {
      if (step.fail.code === "RATE_LIMITED") {
        ctx.reportRateLimit({ remaining: 0, resetAt: null, retryAfterMs: step.fail.retryAfterMs ?? null, scope: "provider_account" });
      }
      throw new ConnectorError(step.fail.code, `fake: ${step.fail.code}`, {
        retryAfterMs: step.fail.retryAfterMs,
        httpStatus: step.fail.httpStatus,
      });
    }
    const raw = step.respond?.items ?? [];
    const items: CanonicalItem[] = [];
    for (const it of raw) {
      const v = CanonicalItem.safeParse(it);
      if (!v.success)
        throw new ConnectorError("PARSE_ERROR", `fake: output provider tidak sesuai schema (${v.error.issues[0]?.path.join(".")})`);
      items.push({ ...v.data, provenance: { ...v.data.provenance, connector_key: this.manifest.key } });
    }
    const since = req.window?.since;
    const inWindow = items.filter(
      (it) => (!since || it.published_at >= since) && (!req.window?.until || it.published_at <= req.window.until),
    );
    const page = inWindow.slice(0, req.maxItems);
    ctx.logger.debug("fake fetch", { op: req.operation, returned: raw.length, kept: page.length });
    const nextCursor = step.respond?.nextCursor ?? null;
    return {
      items: page,
      nextCursor,
      hasMore: !!nextCursor,
      rawRefs: [await ctx.archiveRaw(raw, { platform: this.manifest.platform, crawlRunId: req.idempotencyKey, attemptNo: 1, page: 1 })],
      usage: { requests: 1, results: Math.max(step.respond?.returned ?? 0, raw.length), costUnits: null, costUnitLabel: null },
      upstream: { httpStatuses: [200], requestIds: [] },
      warnings: [],
    };
  }

  async healthProbe(ctx: ConnectorContext): Promise<HealthProbeResult> {
    if (ctx.signal.aborted) return { ok: false, latencyMs: 0, errorCode: "TIMEOUT" };
    return this.healthy ? { ok: true, latencyMs: 1 } : { ok: false, latencyMs: 1, errorCode: "UPSTREAM_5XX" };
  }
}
