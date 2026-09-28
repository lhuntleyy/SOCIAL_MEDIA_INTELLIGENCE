import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import {
  REDACTED,
  Registry,
  context,
  createLogger,
  extractTrace,
  initTracing,
  injectTrace,
  redact,
  redactString,
  trace,
  tracer,
} from "../src";

describe("redact (SEC-02 — secret tidak muncul di log)", () => {
  const SECRETS = {
    jwt: "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1MSIsInRpZCI6InQxIn0.c2lnbmF0dXJlLXBhbGluZy1wYW5qYW5n",
    apify: "apify_api_AbCdEf1234567890",
    anthropic: "sk-ant-api03-AAAABBBBCCCCDDDD",
    twitterapi: "tapi_live_9f2c1e77aa",
  };

  test("key sensitif di objek bersarang, array, dan Headers", () => {
    const out = redact({
      headers: new Headers({ Authorization: `Bearer ${SECRETS.jwt}`, "X-API-Key": SECRETS.twitterapi, accept: "json" }),
      credential: { token: SECRETS.apify },
      nested: [{ refresh_token: "r1" }, { api_key: "k" }, { client_secret: "cs" }, { db_password: "pw" }],
      ok: "biasa",
    }) as Record<string, unknown>;
    const s = JSON.stringify(out);
    for (const v of Object.values(SECRETS)) expect(s).not.toContain(v);
    expect(s).not.toContain("r1");
    expect((out.headers as Record<string, string>)["x-api-key"]).toBe(REDACTED);
    expect((out.headers as Record<string, string>).accept).toBe("json");
    expect(out.ok).toBe("biasa");
  });

  test("pola nilai di teks bebas: bearer, JWT, key vendor, URL kredensial, query param", () => {
    const s = redactString(
      `gagal Bearer ${SECRETS.jwt} ke postgres://app:Rahasia99@db:5432/x dan https://api.x/y?token=abc123&q=demo key=${SECRETS.apify} ${SECRETS.anthropic}`,
    );
    for (const v of [SECRETS.jwt, "Rahasia99", "abc123", SECRETS.apify, SECRETS.anthropic]) expect(s).not.toContain(v);
    expect(s).toContain("q=demo");
    expect(s).toContain("postgres://app:[REDACTED]@db");
  });

  test("key=value sensitif di teks bebas (regresi: ditemukan test F-08)", () => {
    const s = redactString(
      'provider 401 token=Rahasia123 attempt 3; api_key: "k-999" password=pw1, sessionid=abc {"secret":"s3"} tokenizer=ok',
    );
    for (const v of ["Rahasia123", "k-999", "pw1", "sessionid=abc", "s3"]) expect(s).not.toContain(v);
    expect(s).toContain("attempt 3");
    expect(s).toContain("tokenizer=ok");
  });

  test("parameter query ORM di pesan error di-redact (regresi smoke test F-09: email bocor ke log)", () => {
    const e = new Error('Failed query: select "id" from "users" where "users"."email" = $1 limit $2\nparams: admin@contoh.local,1');
    const s = JSON.stringify(redact({ error: e }));
    expect(s).not.toContain("admin@contoh.local");
    expect(s).toContain("Failed query");
  });

  test("Error & referensi melingkar aman", () => {
    const o: Record<string, unknown> = { e: new Error(`401 token=${SECRETS.apify}`) };
    o.self = o;
    const s = JSON.stringify(redact(o));
    expect(s).not.toContain(SECRETS.apify);
    expect(s).toContain("[CIRCULAR]");
  });
});

describe("logger", () => {
  test("JSON satu baris, level filter, child fields, field cadangan tidak tertimpa", () => {
    const lines: string[] = [];
    const log = createLogger({
      service: "worker-fetch-bun",
      version: "0.1.0",
      env: "test",
      level: "info",
      sink: (l) => lines.push(l),
      now: () => new Date("2026-09-28T00:00:00Z"),
    });
    const child = log.child({ connector: "fake", crawl_run_id: "0192" });
    child.debug("tidak muncul");
    child.info("fetch completed", { items: 142, msg: "coba timpa", headers: { authorization: "Bearer xxxxxxxxxxxx" } });
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!);
    expect(rec).toMatchObject({
      ts: "2026-09-28T00:00:00.000Z",
      level: "info",
      service: "worker-fetch-bun",
      msg: "fetch completed",
      connector: "fake",
      items: 142,
      field_msg: "coba timpa",
    });
    expect(rec.headers.authorization).toBe(REDACTED);
  });
});

describe("metrics", () => {
  test("format exposition Prometheus: counter, gauge, histogram kumulatif, escaping", () => {
    const r = new Registry();
    r.counter("smip_crawl_runs_total", "Jumlah run", ["platform", "status"]).inc({ platform: "x", status: "succeeded" }, 2);
    r.gauge("smip_queue_waiting", "Job menunggu", ["queue"]).set({ queue: 'fetch."bun"\n' }, 7);
    const h = r.histogram("smip_job_duration_seconds", "Durasi job", ["queue"], [0.1, 1]);
    h.observe({ queue: "sink" }, 0.05);
    h.observe({ queue: "sink" }, 0.5);
    h.observe({ queue: "sink" }, 3);
    expect(r.render()).toBe(
      [
        "# HELP smip_crawl_runs_total Jumlah run",
        "# TYPE smip_crawl_runs_total counter",
        'smip_crawl_runs_total{platform="x",status="succeeded"} 2',
        "# HELP smip_queue_waiting Job menunggu",
        "# TYPE smip_queue_waiting gauge",
        'smip_queue_waiting{queue="fetch.\\"bun\\"\\n"} 7',
        "# HELP smip_job_duration_seconds Durasi job",
        "# TYPE smip_job_duration_seconds histogram",
        'smip_job_duration_seconds_bucket{queue="sink",le="0.1"} 1',
        'smip_job_duration_seconds_bucket{queue="sink",le="1"} 2',
        'smip_job_duration_seconds_bucket{queue="sink",le="+Inf"} 3',
        'smip_job_duration_seconds_sum{queue="sink"} 3.55',
        'smip_job_duration_seconds_count{queue="sink"} 3',
        "",
      ].join("\n"),
    );
  });

  test("label kardinalitas tinggi ditolak saat definisi; label tak dideklarasikan ditolak saat pakai", () => {
    const r = new Registry();
    expect(() => r.counter("smip_x_total", "x", ["topic_id"])).toThrow(/dilarang/);
    const c = r.counter("smip_y_total", "y", ["platform"]);
    expect(() => c.inc({ platform: "x", post_id: "1" })).toThrow(/tak dideklarasikan/);
    expect(() => c.inc({}, -1)).toThrow();
  });

  test("handler /metrics content-type", async () => {
    const res = new Registry().handler();
    expect(res.headers.get("content-type")).toContain("version=0.0.4");
  });
});

describe("tracing", () => {
  const exporter = new InMemorySpanExporter();
  let t: { shutdown: () => Promise<void> };
  beforeAll(() => {
    t = initTracing({ serviceName: "test", exporter });
  });
  afterAll(async () => t.shutdown());

  test("trace_id muncul di log saat span aktif & propagasi envelope inject/extract", async () => {
    const lines: string[] = [];
    const log = createLogger({ service: "t", sink: (l) => lines.push(l) });
    let carrier: Record<string, string> = {};
    await tracer().startActiveSpan("dispatch.route", async (span) => {
      await Bun.sleep(5);
      log.info("dalam span");
      carrier = injectTrace({});
      span.end();
    });
    const rec = JSON.parse(lines[0]!);
    expect(rec.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(carrier.traceparent).toContain(rec.trace_id);
    // consumer: span anak di konteks hasil extract berbagi trace_id
    const childTrace = context.with(extractTrace(carrier), () => {
      const s = tracer().startSpan("connector.fetch");
      const id = s.spanContext().traceId;
      s.end();
      return id;
    });
    expect(childTrace).toBe(rec.trace_id);
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(["dispatch.route", "connector.fetch"]);
    expect(trace.getActiveSpan()).toBeUndefined();
  });
});
