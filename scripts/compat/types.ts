// Kontrak bersama untuk spike kompatibilitas Fase 0 (TESTING §5, ADR-001).
export type CompatStatus = "COMPATIBLE" | "WORKAROUND" | "INCOMPATIBLE" | "UNTESTED";

export interface CheckResult {
  status: CompatStatus;
  notes: string[];
}

export interface Check {
  id: string;
  task: string; // ID task Fase 0 (TASK.md)
  packages: string[]; // nama paket npm / builtin yang diuji
  run(): Promise<CheckResult>;
}

export class Untested extends Error {}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assert: ${msg}`);
}

export const INFRA = {
  redisQueue: process.env.SPIKE_REDIS_QUEUE ?? "redis://127.0.0.1:6390",
  redisCache: process.env.SPIKE_REDIS_CACHE ?? "redis://127.0.0.1:6391",
  clickhouse: process.env.SPIKE_CLICKHOUSE ?? "http://127.0.0.1:8123",
  postgresHost: "127.0.0.1",
  postgresPort: Number(process.env.SPIKE_PG_PORT ?? 5433),
  s3: {
    endpoint: process.env.SPIKE_S3 ?? "http://127.0.0.1:9100",
    accessKeyId: "smipspike",
    secretAccessKey: "smipspike-secret-123",
  },
  python: process.env.SPIKE_PYTHON ?? `${import.meta.dir}/../../.venv/bin/python`,
};

export async function reachable(url: string): Promise<boolean> {
  try {
    const u = new URL(url);
    const port = Number(u.port);
    const sock = await Bun.connect({ hostname: u.hostname, port, socket: { data() {} } });
    sock.end();
    return true;
  } catch {
    return false;
  }
}

export async function runPython(script: string, args: string[], stdin?: string): Promise<string> {
  const proc = Bun.spawn([INFRA.python, script, ...args], {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`python ${script} exit ${code}: ${err.trim().slice(-400)}`);
  return out.trim();
}
