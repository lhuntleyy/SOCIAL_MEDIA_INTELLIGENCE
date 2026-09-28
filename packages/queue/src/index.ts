// F-08: implementasi port JobQueue/QueueConsumer di atas BullMQ (kompat Bun & interop Python: S-03/S-04).
import { type Envelope, Envelope as EnvelopeSchema, IdempotencyKey } from "@smip/contracts";
import {
  type ConsumerOptions,
  type EnqueueOptions,
  type JobHandler,
  type JobQueue,
  PermanentJobError,
  type QueueConsumer,
  type QueueName,
  type Subscription,
} from "@smip/core";
import { context, extractTrace, injectTrace, type Logger, redact, SpanStatusCode, tracer } from "@smip/observability";
import { type ConnectionOptions, DelayedError, type Job, Queue, UnrecoverableError, Worker } from "bullmq";

/** Kebijakan per queue (QUEUE_SPEC §3). Retry provider diputuskan Router, bukan attempts BullMQ. */
export interface QueuePolicy {
  attempts: number;
  backoff?: { type: "exponential" | "fixed"; delay: number };
  timeoutMs?: number;
  concurrency: number;
}

export const QUEUE_POLICIES: Record<QueueName, QueuePolicy> = {
  "crawl.dispatch": { attempts: 3, backoff: { type: "exponential", delay: 2000 }, timeoutMs: 10_000, concurrency: 50 },
  "fetch.bun": { attempts: 1, timeoutMs: 120_000, concurrency: 20 },
  "fetch.py": { attempts: 1, timeoutMs: 120_000, concurrency: 4 },
  "fetch.resume": { attempts: 1, timeoutMs: 60_000, concurrency: 20 },
  "fetch.result": { attempts: 5, backoff: { type: "exponential", delay: 1000 }, timeoutMs: 10_000, concurrency: 50 },
  "pipeline.items": { attempts: 5, backoff: { type: "exponential", delay: 2000 }, timeoutMs: 60_000, concurrency: 20 },
  "ai.enrich": { attempts: 5, backoff: { type: "exponential", delay: 5000 }, timeoutMs: 300_000, concurrency: 2 },
  "ai.llm_fallback": { attempts: 5, backoff: { type: "exponential", delay: 10_000 }, timeoutMs: 120_000, concurrency: 4 },
  "sink.analytics": { attempts: 10, backoff: { type: "exponential", delay: 2000 }, timeoutMs: 60_000, concurrency: 4 },
  "realtime.notify": { attempts: 1, timeoutMs: 5000, concurrency: 10 },
  "engagement.refresh": { attempts: 3, backoff: { type: "exponential", delay: 2000 }, concurrency: 10 },
  "health.probe": { attempts: 1, timeoutMs: 30_000, concurrency: 5 },
  "connector.verify": { attempts: 1, timeoutMs: 600_000, concurrency: 2 },
  "alert.evaluate": { attempts: 3, backoff: { type: "exponential", delay: 2000 }, timeoutMs: 30_000, concurrency: 5 },
  "notify.send": { attempts: 8, backoff: { type: "exponential", delay: 5000 }, timeoutMs: 15_000, concurrency: 5 },
  "export.generate": { attempts: 3, backoff: { type: "exponential", delay: 5000 }, timeoutMs: 900_000, concurrency: 2 },
  "reprocess.ai": { attempts: 3, backoff: { type: "exponential", delay: 5000 }, concurrency: 1 },
  "crawl.reaper": { attempts: 1, timeoutMs: 30_000, concurrency: 1 },
  "retention.run": { attempts: 3, backoff: { type: "exponential", delay: 5000 }, timeoutMs: 3_600_000, concurrency: 1 },
};

export const dlqName = (q: QueueName) => `dlq.${q}`;

export interface DlqEntry {
  queue: QueueName;
  job_id: string;
  envelope: Envelope<unknown>;
  last_error: string;
  attempts: number;
  poison: boolean;
  failed_at: string;
}

export interface CreateEnvelopeInput<T> {
  type: string;
  idempotencyKey: string;
  tenantId: string | null;
  payload: T;
  now?: Date;
}

/** Envelope v1 (QUEUE_SPEC §2) + traceparent konteks aktif. */
export function createEnvelope<T>(i: CreateEnvelopeInput<T>): Envelope<T> {
  const env = {
    v: 1 as const,
    type: i.type,
    id: Bun.randomUUIDv7(),
    idempotency_key: IdempotencyKey.parse(i.idempotencyKey),
    tenant_id: i.tenantId,
    created_at: (i.now ?? new Date()).toISOString(),
    trace: injectTrace({}) as { traceparent?: string },
    payload: i.payload,
  };
  return env;
}

function assertEnvelope(msg: Envelope<unknown>): void {
  const r = EnvelopeSchema.safeParse(msg);
  if (!r.success) throw new Error(`envelope tidak valid: ${r.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
  const size = Buffer.byteLength(JSON.stringify(msg));
  if (size > 256 * 1024) throw new Error(`payload ${size} byte > 256 KB — pakai items_ref/batch_ref (QUEUE_SPEC §2)`);
}

export interface BullMqOptions {
  connection: ConnectionOptions;
  /** Prefix key Redis (default "bull"). Test memakai prefix unik. */
  prefix?: string;
  logger?: Logger;
  /** Override kebijakan (test). */
  policies?: Partial<Record<QueueName, Partial<QueuePolicy>>>;
  /** Override lock/stalled BullMQ (test graceful shutdown). */
  worker?: { lockDuration?: number; stalledInterval?: number };
}

export class BullMqQueue implements JobQueue, QueueConsumer {
  private queues = new Map<string, Queue>();
  constructor(private readonly o: BullMqOptions) {}

  private policy(q: QueueName): QueuePolicy {
    return { ...QUEUE_POLICIES[q], ...this.o.policies?.[q] };
  }
  private queue(name: string): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.o.connection, prefix: this.o.prefix });
      this.queues.set(name, q);
    }
    return q;
  }

  /** Jumlah job menunggu (waiting + prioritized) — sinyal backpressure scheduler (QUEUE_SPEC §6). */
  async waitingCount(queue: QueueName): Promise<number> {
    return this.queue(queue).getJobCountByTypes("waiting", "prioritized");
  }

  async enqueue<T>(queue: QueueName, msg: Envelope<T>, opts: EnqueueOptions = {}): Promise<void> {
    await this.enqueueBulk(queue, [msg], opts);
  }

  async enqueueBulk<T>(queue: QueueName, msgs: Envelope<T>[], opts: EnqueueOptions = {}): Promise<void> {
    for (const m of msgs) assertEnvelope(m as Envelope<unknown>);
    const p = this.policy(queue);
    await this.queue(queue).addBulk(
      msgs.map((m) => ({
        name: m.type,
        data: m,
        opts: {
          jobId: m.idempotency_key,
          attempts: p.attempts,
          backoff: p.backoff,
          delay: opts.delayMs,
          priority: opts.priority,
          removeOnComplete: { age: 24 * 3600, count: 10_000 },
          removeOnFail: { age: 7 * 24 * 3600 },
        },
      })),
    );
  }

  async consume<T>(queue: QueueName, handler: JobHandler<T>, opts: ConsumerOptions<T>): Promise<Subscription> {
    const p = this.policy(queue);
    const log = this.o.logger?.child({ queue });
    const active = new Map<string, AbortController>();
    let shuttingDown = false;
    const SHUTDOWN = "__smip_shutdown__";

    const worker = new Worker(
      queue,
      async (job: Job, token?: string) => {
        const env = job.data as Envelope<unknown>;
        // poison: envelope/payload tidak valid → tidak di-retry (QUEUE_SPEC §7)
        const envOk = EnvelopeSchema.safeParse(env);
        if (!envOk.success) throw new UnrecoverableError(`poison: envelope tidak valid (${envOk.error.issues[0]?.message})`);
        let payload: T;
        try {
          payload = opts.parse(env.payload);
        } catch (e) {
          throw new UnrecoverableError(`poison: payload tidak valid (${(e as Error).message.slice(0, 300)})`);
        }
        const ac = new AbortController();
        active.set(job.id!, ac);
        const timer = p.timeoutMs ? setTimeout(() => ac.abort(new Error(`timeout ${p.timeoutMs} ms`)), p.timeoutMs) : undefined;
        try {
          await context.with(extractTrace(env.trace), () =>
            tracer().startActiveSpan(`queue.${queue}`, async (span) => {
              span.setAttributes({ "messaging.destination": queue, "messaging.message_id": job.id!, attempt: job.attemptsMade + 1 });
              try {
                const run = handler({ ...env, payload }, { queue, attempt: job.attemptsMade + 1, signal: ac.signal });
                await Promise.race([
                  run,
                  new Promise<never>((_, rej) => ac.signal.addEventListener("abort", () => rej(ac.signal.reason), { once: true })),
                ]);
              } catch (e) {
                if (shuttingDown && ac.signal.aborted && (ac.signal.reason as Error)?.message === SHUTDOWN) {
                  // QUEUE_SPEC §10: job belum selesai DIKEMBALIKAN ke queue, tidak dihitung sebagai percobaan gagal
                  await job.moveToDelayed(Date.now(), token);
                  throw new DelayedError();
                }
                span.setStatus({ code: SpanStatusCode.ERROR });
                if (e instanceof PermanentJobError) throw new UnrecoverableError(e.message);
                throw e;
              } finally {
                span.end();
              }
            }),
          );
        } finally {
          clearTimeout(timer);
          active.delete(job.id!);
        }
      },
      {
        connection: this.o.connection,
        prefix: this.o.prefix,
        concurrency: opts.concurrency ?? p.concurrency,
        lockDuration: this.o.worker?.lockDuration,
        stalledInterval: this.o.worker?.stalledInterval,
        autorun: true,
      },
    );

    worker.on("failed", async (job, err) => {
      if (!job) return;
      const poison = err instanceof UnrecoverableError || err.name === "UnrecoverableError";
      const final = poison || job.attemptsMade >= (job.opts.attempts ?? 1);
      if (!final) return;
      const entry: DlqEntry = {
        queue,
        job_id: job.id!,
        envelope: job.data as Envelope<unknown>,
        last_error: String(redact(err.message)),
        attempts: job.attemptsMade,
        poison,
        failed_at: new Date().toISOString(),
      };
      await this.queue(dlqName(queue)).add("dlq", entry, { jobId: `dlq.${job.id}`, removeOnComplete: false });
      log?.warn("job → DLQ", { job_id: job.id, poison, attempts: job.attemptsMade, error: entry.last_error });
    });
    worker.on("error", (e) => log?.error("worker error", { error: e }));
    await worker.waitUntilReady();

    return {
      close: async (graceMs = 60_000) => {
        shuttingDown = true;
        const closing = worker.close(); // berhenti ambil job baru, tunggu job aktif
        const wait = (ms: number) => new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms));
        if ((await Promise.race([closing.then(() => "ok" as const), wait(graceMs)])) === "timeout") {
          // lewat grace: minta handler berhenti → job dikembalikan ke queue (moveToDelayed 0)
          for (const ac of active.values()) ac.abort(new Error(SHUTDOWN));
          if ((await Promise.race([closing.then(() => "ok" as const), wait(5000)])) === "timeout") await worker.close(true);
        }
      },
    };
  }

  /** Isi DLQ (ops UI, API_SPEC §9). */
  async listDlq(queue: QueueName, limit = 50): Promise<DlqEntry[]> {
    const jobs = await this.queue(dlqName(queue)).getJobs(["waiting", "delayed", "prioritized"], 0, limit - 1);
    return jobs.map((j) => j.data as DlqEntry);
  }

  /** Redrive: enqueue ulang envelope asli dengan jobId baru (jobId lama masih tercatat failed), hapus dari DLQ. */
  async redrive(queue: QueueName, jobId: string): Promise<string> {
    const dlq = this.queue(dlqName(queue));
    const dj = await dlq.getJob(`dlq.${jobId}`);
    if (!dj) throw new Error(`DLQ ${queue}/${jobId} tidak ditemukan`);
    const entry = dj.data as DlqEntry;
    const n = (await this.queue(queue).getJob(`${jobId}.redrive.1`)) ? Date.now() : 1;
    const newKey = `${jobId}.redrive.${n}`;
    await this.enqueue(queue, { ...entry.envelope, idempotency_key: newKey });
    await dj.remove();
    return newKey;
  }

  async discard(queue: QueueName, jobId: string): Promise<void> {
    const dj = await this.queue(dlqName(queue)).getJob(`dlq.${jobId}`);
    await dj?.remove();
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.queues.clear();
  }
}
