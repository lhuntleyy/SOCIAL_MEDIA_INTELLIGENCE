// Registry metric Prometheus minimal (text exposition 0.0.4) — OBSERVABILITY §3.
// Ditulis sendiri: 3 tipe yang kita pakai, tanpa menambah paket yang harus lolos compat Bun.
// Label kardinalitas tinggi DILARANG (OBSERVABILITY §3): ditolak saat definisi.

const FORBIDDEN_LABELS = new Set(["post_id", "topic_id", "tenant_id", "user_id", "author_id", "crawl_run_id", "request_id", "trace_id"]);
const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

type Labels = Record<string, string | number>;

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}
function fmtNum(n: number): string {
  if (n === Number.POSITIVE_INFINITY) return "+Inf";
  if (n === Number.NEGATIVE_INFINITY) return "-Inf";
  return Number.isNaN(n) ? "NaN" : String(n);
}

abstract class Metric {
  protected series = new Map<string, { labels: Labels }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[],
  ) {
    if (!NAME_RE.test(name)) throw new Error(`nama metric tidak valid: ${name}`);
    for (const l of labelNames) {
      if (!LABEL_RE.test(l) || l.startsWith("__")) throw new Error(`label tidak valid: ${l}`);
      if (FORBIDDEN_LABELS.has(l)) throw new Error(`label "${l}" dilarang (kardinalitas tinggi) pada ${name}`);
    }
  }
  protected key(labels: Labels): string {
    const extra = Object.keys(labels).filter((k) => !this.labelNames.includes(k));
    if (extra.length) throw new Error(`label tak dideklarasikan pada ${this.name}: ${extra.join(",")}`);
    return this.labelNames.map((l) => String(labels[l] ?? "")).join("\u0000");
  }
  protected labelStr(labels: Labels, extra?: [string, string]): string {
    const parts = this.labelNames.filter((l) => labels[l] !== undefined).map((l) => `${l}="${escapeLabel(String(labels[l]))}"`);
    if (extra) parts.push(`${extra[0]}="${escapeLabel(extra[1])}"`);
    return parts.length ? `{${parts.join(",")}}` : "";
  }
  abstract render(): string;
}

export class Counter extends Metric {
  private values = new Map<string, number>();
  inc(labels: Labels = {}, by = 1): void {
    if (by < 0) throw new Error("counter tidak boleh turun");
    const k = this.key(labels);
    this.series.set(k, { labels });
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [k, { labels }] of this.series) lines.push(`${this.name}${this.labelStr(labels)} ${fmtNum(this.values.get(k)!)}`);
    return lines.join("\n");
  }
}

export class Gauge extends Metric {
  private values = new Map<string, number>();
  set(labels: Labels, v: number): void {
    const k = this.key(labels);
    this.series.set(k, { labels });
    this.values.set(k, v);
  }
  inc(labels: Labels = {}, by = 1): void {
    const k = this.key(labels);
    this.series.set(k, { labels });
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const [k, { labels }] of this.series) lines.push(`${this.name}${this.labelStr(labels)} ${fmtNum(this.values.get(k)!)}`);
    return lines.join("\n");
  }
}

export const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];

export class Histogram extends Metric {
  private data = new Map<string, { counts: number[]; sum: number; count: number }>();
  readonly buckets: number[];
  constructor(name: string, help: string, labelNames: readonly string[], buckets: number[] = DEFAULT_BUCKETS) {
    super(name, help, labelNames);
    if (labelNames.includes("le")) throw new Error("label 'le' dicadangkan untuk histogram");
    this.buckets = [...buckets].sort((a, b) => a - b);
  }
  observe(labels: Labels, v: number): void {
    const k = this.key(labels);
    this.series.set(k, { labels });
    const d = this.data.get(k) ?? { counts: this.buckets.map(() => 0), sum: 0, count: 0 };
    this.buckets.forEach((b, i) => {
      if (v <= b) d.counts[i]!++;
    });
    d.sum += v;
    d.count++;
    this.data.set(k, d);
  }
  /** Mulai timer; panggil fungsi kembalian untuk mencatat durasi (detik). */
  startTimer(labels: Labels): (extra?: Labels) => number {
    const t0 = performance.now();
    return (extra) => {
      const s = (performance.now() - t0) / 1000;
      this.observe({ ...labels, ...extra }, s);
      return s;
    };
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, { labels }] of this.series) {
      const d = this.data.get(k)!;
      for (const [i, b] of this.buckets.entries())
        lines.push(`${this.name}_bucket${this.labelStr(labels, ["le", fmtNum(b)])} ${d.counts[i]}`);
      lines.push(`${this.name}_bucket${this.labelStr(labels, ["le", "+Inf"])} ${d.count}`);
      lines.push(`${this.name}_sum${this.labelStr(labels)} ${fmtNum(d.sum)}`);
      lines.push(`${this.name}_count${this.labelStr(labels)} ${d.count}`);
    }
    return lines.join("\n");
  }
}

export class Registry {
  private metrics = new Map<string, Metric>();
  private register<M extends Metric>(m: M): M {
    const existing = this.metrics.get(m.name);
    if (existing) {
      if (existing.constructor !== m.constructor) throw new Error(`metric ${m.name} sudah terdaftar dengan tipe lain`);
      return existing as M;
    }
    this.metrics.set(m.name, m);
    return m;
  }
  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    return this.register(new Counter(name, help, labelNames));
  }
  gauge(name: string, help: string, labelNames: readonly string[] = []): Gauge {
    return this.register(new Gauge(name, help, labelNames));
  }
  histogram(name: string, help: string, labelNames: readonly string[] = [], buckets?: number[]): Histogram {
    return this.register(new Histogram(name, help, labelNames, buckets));
  }
  render(): string {
    return `${[...this.metrics.values()].map((m) => m.render()).join("\n")}\n`;
  }
  /** Handler untuk `GET /metrics` (hanya jaringan internal — API_SPEC §11). */
  handler(): Response {
    return new Response(this.render(), { headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" } });
  }
}
