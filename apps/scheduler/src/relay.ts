// Relay outbox → queue: baris `job` di-outbox menjadi job BullMQ (envelope v1 + traceparent). jobId = idempotency key.
import type { JobQueue, QueueName } from "@smip/core";
import type { OutboxJob } from "@smip/db";
import { createEnvelope } from "@smip/queue";

export function jobRelay(queue: JobQueue) {
  return async (jobs: OutboxJob[]): Promise<void> => {
    for (const j of jobs) {
      await queue.enqueue(
        j.queue as QueueName,
        createEnvelope({ type: j.type, idempotencyKey: j.idempotencyKey, tenantId: j.tenantId, payload: j.payload }),
        { priority: j.priority, delayMs: j.delayMs },
      );
    }
  };
}
