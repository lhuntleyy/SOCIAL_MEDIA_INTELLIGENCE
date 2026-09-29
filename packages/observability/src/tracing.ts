// Tracing OpenTelemetry (OBSERVABILITY §4) — kompat Bun dibuktikan di S-06.
// Propagasi W3C traceparent lewat envelope queue (QUEUE_SPEC §9).
import { type Context, context, propagation, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  ParentBasedSampler,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";

export interface TracingOptions {
  serviceName: string;
  version?: string;
  /** OTLP/HTTP endpoint collector, mis. http://otel:4318/v1/traces. Kosong = tracing no-op (context tetap dipropagasi). */
  endpoint?: string;
  /** Rasio sampling span sukses (OBSERVABILITY §4: 10%). Span root error/failover diputuskan pemanggil. */
  sampleRatio?: number;
  /** Untuk test: exporter kustom + processor sinkron. */
  exporter?: SpanExporter;
}

let active: { provider: BasicTracerProvider; cm: AsyncLocalStorageContextManager } | null = null;

export function initTracing(opts: TracingOptions): { shutdown: () => Promise<void> } {
  if (active) throw new Error("tracing sudah diinisialisasi");
  const cm = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(cm);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  const processors: SpanProcessor[] = [];
  if (opts.exporter) processors.push(new SimpleSpanProcessor(opts.exporter));
  else if (opts.endpoint) processors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url: opts.endpoint })));
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ "service.name": opts.serviceName, "service.version": opts.version ?? "0.0.0" }),
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(opts.sampleRatio ?? 1) }),
    spanProcessors: processors,
  });
  trace.setGlobalTracerProvider(provider);
  active = { provider, cm };
  return {
    shutdown: async () => {
      await provider.shutdown();
      cm.disable();
      trace.disable();
      context.disable();
      propagation.disable();
      active = null;
    },
  };
}

export const tracer = (name = "smip") => trace.getTracer(name);

/** Sisipkan traceparent konteks aktif ke carrier (mis. `envelope.trace`). */
export function injectTrace(carrier: Record<string, string> = {}, ctx: Context = context.active()): Record<string, string> {
  propagation.inject(ctx, carrier);
  return carrier;
}

/** Konteks dari carrier envelope; jalankan consumer di dalam `context.with(extractTrace(env.trace), fn)`. */
export function extractTrace(carrier: Record<string, string> | undefined): Context {
  return propagation.extract(context.active(), carrier ?? {});
}

export { context, SpanStatusCode, trace };
