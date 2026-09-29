// S-05 demo KEDA: 18 job ber-priority ke fetch.bun (tak terlihat oleh LLEN wait). Hapus setelah demo (lihat evidence).
import { BullMqQueue, createEnvelope } from "@smip/queue";

const q = new BullMqQueue({ connection: { url: process.env.REDIS_URL! } });
for (let i = 0; i < 18; i++)
  await q.enqueue(
    "fetch.bun",
    createEnvelope({ type: "fetch.request", idempotencyKey: `keda-demo.${i}`, tenantId: null, payload: { demo: i } as never }),
    { priority: 1 },
  );
console.log(JSON.stringify(await q.depth("fetch.bun")));
await q.close();
