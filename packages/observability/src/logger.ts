// Logger JSON terstruktur (OBSERVABILITY §2): satu baris JSON per event ke stdout, secret di-redact,
// trace_id/span_id otomatis dari span OTel yang aktif.
import { trace } from "@opentelemetry/api";
import { redact, redactString } from "./redact";

export type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  service: string;
  version?: string;
  env?: string;
  level?: Level;
  /** Tujuan output; default stdout. Diganti di test. */
  sink?: (line: string) => void;
  now?: () => Date;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

const RESERVED = new Set(["ts", "level", "service", "version", "env", "msg", "trace_id", "span_id"]);

export function createLogger(opts: LoggerOptions, bound: Record<string, unknown> = {}): Logger {
  const min = ORDER[opts.level ?? "info"];
  const sink = opts.sink ?? ((l: string) => process.stdout.write(`${l}\n`));
  const now = opts.now ?? (() => new Date());

  const emit = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < min) return;
    const span = trace.getActiveSpan()?.spanContext();
    const extra = redact({ ...bound, ...fields }) as Record<string, unknown>;
    const rec: Record<string, unknown> = {
      ts: now().toISOString(),
      level,
      service: opts.service,
      version: opts.version,
      env: opts.env,
      msg: redactString(msg),
      trace_id: span?.traceId,
      span_id: span?.spanId,
    };
    for (const [k, v] of Object.entries(extra)) rec[RESERVED.has(k) ? `field_${k}` : k] = v;
    sink(JSON.stringify(rec, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  };

  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (f) => createLogger(opts, { ...bound, ...f }),
  };
}
