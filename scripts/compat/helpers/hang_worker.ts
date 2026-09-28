// Dipakai s03-queue.ts: worker yang mengambil job lalu menggantung, untuk di-SIGKILL (simulasi crash → stalled).
import { Worker } from "bullmq";

const qname = process.argv[2]!;
new Worker(
  qname,
  async () => {
    console.log("ACTIVE");
    await new Promise(() => {}); // tidak pernah selesai
  },
  { connection: { host: "127.0.0.1", port: 6390 }, lockDuration: 2000, stalledInterval: 1000 },
);
