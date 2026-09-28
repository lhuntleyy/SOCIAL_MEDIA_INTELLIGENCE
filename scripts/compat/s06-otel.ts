// S-06: OpenTelemetry JS di Bun — span sampai ke collector (OTLP/HTTP protobuf) + propagasi konteks async
// (AsyncLocalStorage) + inject/extract W3C traceparent (dipakai envelope queue, QUEUE_SPEC §9).
import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { assert, type Check } from "./types";

export const otel: Check = {
  id: "opentelemetry",
  task: "S-06",
  packages: ["@opentelemetry/sdk-trace-base", "@opentelemetry/exporter-trace-otlp-proto", "@opentelemetry/context-async-hooks"],
  async run() {
    const notes: string[] = [];
    const received: { contentType: string | null; body: Uint8Array }[] = [];
    const collector = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.method === "POST" && new URL(req.url).pathname === "/v1/traces") {
          received.push({ contentType: req.headers.get("content-type"), body: new Uint8Array(await req.arrayBuffer()) });
        }
        return new Response(null, { status: 200 });
      },
    });

    const cm = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(cm);
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    const provider = new BasicTracerProvider({
      resource: resourceFromAttributes({ "service.name": "smip-spike" }),
      spanProcessors: [new SimpleSpanProcessor(new OTLPTraceExporter({ url: `http://127.0.0.1:${collector.port}/v1/traces` }))],
    });
    trace.setGlobalTracerProvider(provider);
    const tracer = trace.getTracer("compat");

    try {
      // Propagasi konteks melewati await (AsyncLocalStorage di Bun)
      let parentId = "",
        childParentId: string | undefined,
        traceparent: Record<string, string> = {};
      await tracer.startActiveSpan("dispatch.route", async (parent) => {
        parentId = parent.spanContext().spanId;
        await new Promise((r) => setTimeout(r, 20));
        await Promise.resolve();
        const child = tracer.startSpan("connector.fetch", { attributes: { connector: "twitterapi_io.x", attempt: 1 } });
        childParentId = (child as unknown as { parentSpanContext?: { spanId: string } }).parentSpanContext?.spanId;
        child.end();
        propagation.inject(context.active(), traceparent);
        parent.end();
      });
      assert(childParentId === parentId, `child span mewarisi parent lewat await (parent ${parentId}, dapat ${childParentId})`);
      notes.push("AsyncLocalStorageContextManager: konteks span bertahan melewati setTimeout/await");

      // Extract di "consumer" (simulasi envelope queue)
      assert(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/.test(traceparent.traceparent ?? ""), `traceparent W3C valid (${traceparent.traceparent})`);
      const extracted = propagation.extract(context.active(), traceparent);
      const remote = trace.getSpanContext(extracted);
      assert(remote?.traceId === traceparent.traceparent!.split("-")[1], "extract traceId sama");
      notes.push(`inject/extract traceparent W3C OK (${traceparent.traceparent})`);

      await provider.forceFlush();
      assert(received.length >= 1, "collector menerima POST /v1/traces");
      assert(received[0]!.contentType === "application/x-protobuf", `content-type protobuf (dapat ${received[0]!.contentType})`);
      const blob = Buffer.concat(received.map((r) => r.body)).toString("latin1");
      assert(blob.includes("connector.fetch") && blob.includes("smip-spike"), "payload memuat nama span & service");
      notes.push(`OTLP/HTTP protobuf exporter → collector lokal: ${received.length} request, span & resource terkirim`);
    } finally {
      await provider.shutdown();
      cm.disable();
      collector.stop(true);
    }
    return { status: "COMPATIBLE", notes };
  },
};
