// Port antrian (QUEUE_SPEC §1). Core hanya mengenal interface ini — implementasi (BullMQ/Streams) di packages/queue.
import type { Envelope } from "@smip/contracts";

/** Daftar queue tetap (QUEUE_SPEC §3). Menambah queue = perubahan core yang disengaja. */
export const QUEUE_NAMES = [
  "crawl.dispatch",
  "fetch.bun",
  "fetch.py",
  "fetch.resume",
  "fetch.result",
  "pipeline.items",
  "ai.enrich",
  "ai.llm_fallback",
  "sink.analytics",
  "realtime.notify",
  "engagement.refresh",
  "health.probe",
  "connector.verify",
  "alert.evaluate",
  "notify.send",
  "export.generate",
  "reprocess.ai",
  "crawl.reaper",
  "retention.run",
] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export interface EnqueueOptions {
  delayMs?: number;
  /** 1 = tertinggi. */
  priority?: number;
}

export interface JobQueue {
  /** jobId = `msg.idempotency_key` → enqueue ganda diabaikan. */
  enqueue<T>(queue: QueueName, msg: Envelope<T>, opts?: EnqueueOptions): Promise<void>;
  enqueueBulk<T>(queue: QueueName, msgs: Envelope<T>[], opts?: EnqueueOptions): Promise<void>;
}

export interface JobCtx {
  queue: QueueName;
  /** 1 = percobaan pertama. */
  attempt: number;
  /** Aborted saat timeout job atau shutdown — handler wajib menghormatinya. */
  signal: AbortSignal;
}

export type JobHandler<T> = (msg: Envelope<T>, ctx: JobCtx) => Promise<void>;

/** Validator payload (mis. `schema.parse` Zod). Gagal = poison message → langsung DLQ, tidak di-retry. */
export type PayloadParser<T> = (payload: unknown) => T;

export interface ConsumerOptions<T> {
  parse: PayloadParser<T>;
  concurrency?: number;
}

export interface Subscription {
  /** Berhenti ambil job baru, tunggu job aktif s/d `graceMs`, sisanya dikembalikan ke queue (QUEUE_SPEC §10). */
  close(graceMs?: number): Promise<void>;
}

export interface QueueConsumer {
  consume<T>(queue: QueueName, handler: JobHandler<T>, opts: ConsumerOptions<T>): Promise<Subscription>;
}

/** Error yang tidak boleh di-retry (poison / kesalahan permanen). */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}
