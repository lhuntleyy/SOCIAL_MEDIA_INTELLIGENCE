// S-03: bullmq + ioredis di Bun (delay, retry, stalled, priority, jobId idempotency) + Lua EVALSHA + Bun.redis.
// S-04: interop BullMQ TS <-> Python pada queue yang sama.
import { type Job, Queue, QueueEvents, Worker } from "bullmq";
import IORedis from "ioredis";
import { assert, type Check, INFRA, reachable, runPython, Untested } from "./types";

const connection = { host: "127.0.0.1", port: 6390, maxRetriesPerRequest: null };

async function fresh(name: string) {
  const q = new Queue(name, { connection });
  await q.obliterate({ force: true }).catch(() => {});
  return q;
}

function waitFor<T>(fn: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const v = fn();
      if (v !== undefined) return resolve(v);
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`timeout menunggu ${what}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

export const bullmq: Check = {
  id: "bullmq",
  task: "S-03",
  packages: ["bullmq", "ioredis"],
  async run() {
    if (!(await reachable(INFRA.redisQueue))) throw new Untested("redis-queue tidak jalan");
    const notes: string[] = [];

    // 1) basic + jobId idempotency
    {
      const q = await fresh("compat-basic");
      // QUEUE_SPEC v0.3 memakai "run:{id}:attempt:{n}" sebagai jobId — BullMQ menolak ':'.
      const colon = await q.add("a", {}, { jobId: "run:1:attempt:1" }).then(
        () => "diterima",
        (e: Error) => e.message,
      );
      notes.push(
        `jobId dengan ':' → ${colon === "diterima" ? "diterima" : `DITOLAK ("${colon}") → format jobId v0.4: run.{id}.attempt.{n}`}`,
      );
      await q.add("a", { v: 1 }, { jobId: "run.0192f0c4.attempt.1" });
      await q.add("a", { v: 2 }, { jobId: "run.0192f0c4.attempt.1" }); // duplikat → diabaikan
      const counts = await q.getJobCounts("wait", "delayed");
      assert(counts.wait === 1, `jobId dedupe: 1 job di wait, dapat ${counts.wait}`);
      let got: unknown;
      const w = new Worker(
        "compat-basic",
        async (j: Job) => {
          got = j.data;
          return "ok";
        },
        { connection },
      );
      await waitFor(() => got, 5000, "job basic");
      await w.close();
      await q.close();
      assert((got as { v: number }).v === 1, "data job pertama yang menang");
      notes.push("enqueue/consume + jobId idempotency OK (enqueue ganda diabaikan)");
    }

    // 2) delay
    {
      const q = await fresh("compat-delay");
      const t0 = Date.now();
      await q.add("d", {}, { delay: 1500 });
      let at: number | undefined;
      const w = new Worker(
        "compat-delay",
        async () => {
          at = Date.now();
        },
        { connection },
      );
      const doneAt = await waitFor(() => at, 8000, "delayed job");
      await w.close();
      await q.close();
      assert(doneAt - t0 >= 1400, `delay dihormati (${doneAt - t0} ms)`);
      notes.push(`delay 1500 ms → diproses setelah ${doneAt - t0} ms`);
    }

    // 3) retry + backoff
    {
      const q = await fresh("compat-retry");
      await q.add("r", {}, { attempts: 3, backoff: { type: "fixed", delay: 200 } });
      let calls = 0;
      let finalAttempts: number | undefined;
      const w = new Worker(
        "compat-retry",
        async (j: Job) => {
          calls++;
          if (calls < 3) throw new Error("gagal sementara");
          finalAttempts = j.attemptsMade;
        },
        { connection },
      );
      await waitFor(() => finalAttempts, 8000, "retry sukses");
      await w.close();
      await q.close();
      assert(calls === 3, `3 panggilan, dapat ${calls}`);
      notes.push(`retry attempts=3 backoff fixed: sukses di panggilan ke-${calls} (attemptsMade=${finalAttempts})`);
    }

    // 4) priority (1 = tertinggi, QUEUE_SPEC §1)
    {
      const q = await fresh("compat-prio");
      for (const p of [5, 1, 3]) await q.add(`p${p}`, { p }, { priority: p });
      const order: number[] = [];
      const w = new Worker(
        "compat-prio",
        async (j: Job) => {
          order.push(j.data.p);
        },
        { connection, concurrency: 1 },
      );
      await waitFor(() => (order.length === 3 ? order : undefined), 5000, "3 job priority");
      await w.close();
      await q.close();
      assert(order.join() === "1,3,5", `urutan priority 1,3,5 — dapat ${order.join()}`);
      notes.push("priority: urutan 1→3→5 OK");
    }

    // 5) stalled: worker di proses lain di-SIGKILL saat job aktif → job diambil worker lain
    {
      const q = await fresh("compat-stalled");
      await q.add("s", { crash: true });
      const child = Bun.spawn([process.execPath, `${import.meta.dir}/helpers/hang_worker.ts`, "compat-stalled"], {
        stdout: "pipe",
        stderr: "inherit",
      });
      const reader = child.stdout.getReader();
      const { value } = await reader.read();
      assert(new TextDecoder().decode(value).includes("ACTIVE"), "child mengambil job");
      child.kill(9);
      await child.exited;
      const t0 = Date.now();
      let recovered: number | undefined;
      const w = new Worker(
        "compat-stalled",
        async () => {
          recovered = Date.now();
        },
        {
          connection,
          lockDuration: 2000,
          stalledInterval: 1000,
          maxStalledCount: 1,
        },
      );
      await waitFor(() => recovered, 15000, "job stalled diproses ulang");
      await w.close();
      await q.close();
      notes.push(
        `stalled: worker di-SIGKILL saat job aktif → job diproses ulang worker lain setelah ${recovered! - t0} ms (lockDuration 2 s)`,
      );
    }

    // 6) ioredis EVALSHA (token bucket Lua, CONNECTOR_SPEC §10)
    {
      const r = new IORedis(6391, "127.0.0.1");
      const lua = `
        local cap = tonumber(ARGV[1]); local refill = tonumber(ARGV[2]); local now = tonumber(ARGV[3])
        local b = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
        local tokens = tonumber(b[1]) or cap; local ts = tonumber(b[2]) or now
        tokens = math.min(cap, tokens + (now - ts) * refill / 1000)
        local ok = 0
        if tokens >= 1 then tokens = tokens - 1; ok = 1 end
        redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now); redis.call('PEXPIRE', KEYS[1], 3600000)
        return ok`;
      const sha = (await r.script("LOAD", lua)) as string;
      await r.del("rl:compat");
      const now = Date.now();
      const res: number[] = [];
      for (let i = 0; i < 5; i++) res.push((await r.evalsha(sha, 1, "rl:compat", 3, 0, now)) as number);
      await r.quit();
      assert(res.join() === "1,1,1,0,0", `bucket kapasitas 3 → 1,1,1,0,0 dapat ${res.join()}`);
      notes.push("ioredis SCRIPT LOAD + EVALSHA token bucket OK");
    }

    // 7) Bun.redis (klien builtin untuk non-BullMQ, ARCHITECTURE §2)
    {
      const r = new Bun.RedisClient(INFRA.redisCache);
      await r.del("seen:x:1");
      const first = await r.send("SET", ["seen:x:1", "1", "NX", "EX", "60"]);
      const second = await r.send("SET", ["seen:x:1", "1", "NX", "EX", "60"]);
      r.close();
      assert(first === "OK" && second === null, `SET NX dedupe (dapat ${first}/${second})`);
      notes.push("Bun.RedisClient SET NX EX (dedupe seen:*) OK");
    }
    return { status: "COMPATIBLE", notes };
  },
};

export const bullmqInterop: Check = {
  id: "bullmq-interop-py",
  task: "S-04",
  packages: ["bullmq", "bullmq (PyPI)"],
  async run() {
    if (!(await reachable(INFRA.redisQueue))) throw new Untested("redis-queue tidak jalan");
    const notes: string[] = [];
    const py = `${import.meta.dir}/py/bullmq_interop.py`;

    // TS → Python
    const q1 = await fresh("interop-ts2py");
    const events = new QueueEvents("interop-ts2py", { connection });
    await events.waitUntilReady();
    const job = await q1.add("ts2py", { from: "bun", n: 7 }, { jobId: "ts-1" });
    const pyOut = JSON.parse(await runPython(py, ["consume", "interop-ts2py"]));
    assert(pyOut.data.from === "bun" && pyOut.data.n === 7, "Python menerima data dari TS");
    const rv = await job.waitUntilFinished(events, 10000);
    assert(rv.by === "python" && rv.echo.n === 7, "return value Python terbaca di TS");
    await events.close();
    await q1.close();
    notes.push("TS enqueue → Python Worker consume → returnvalue kembali ke TS (waitUntilFinished) OK");

    // Python → TS
    const q2 = await fresh("interop-py2ts");
    await q2.close();
    const prod = JSON.parse(await runPython(py, ["produce", "interop-py2ts"]));
    let got: { data: { from: string; n: number }; opts: { attempts?: number } } | undefined;
    const w = new Worker(
      "interop-py2ts",
      async (j: Job) => {
        got = { data: j.data, opts: j.opts };
      },
      { connection },
    );
    await waitFor(() => got, 8000, "job dari Python");
    await w.close();
    assert(got!.data.from === "python" && got!.data.n === 42, "TS menerima data dari Python");
    notes.push(`Python enqueue (jobId=${prod.id}, attempts=${got!.opts.attempts}) → TS Worker consume OK`);
    return { status: "COMPATIBLE", notes };
  },
};
