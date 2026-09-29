// S-05 demo KEDA (docs/evidence/S-05/kind-demo.md): exporter smip_queue_depth di jaringan kind — kode sama dgn scheduler main.
import { QUEUE_NAMES } from "@smip/core";
import { Registry } from "@smip/observability";
import { BullMqQueue } from "@smip/queue";

const q = new BullMqQueue({ connection: { url: process.env.REDIS_URL! } });
const reg = new Registry();
const g = reg.gauge("smip_queue_depth", "demo S-05", ["queue", "state"]);
const sample = async () => {
  for (const n of QUEUE_NAMES) for (const [s, v] of Object.entries(await q.depth(n))) g.set({ queue: n, state: s }, v);
};
setInterval(sample, 5000);
await sample();
Bun.serve({ port: 9464, hostname: "0.0.0.0", fetch: () => reg.handler() });
