// S-02: hono (+SSE), zod, jose di Bun.
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import * as jose from "jose";
import { assert, type Check } from "./types";

async function readSse(res: Response): Promise<{ events: string[]; firstMs: number }> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const t0 = performance.now();
  let buf = "";
  let firstMs = -1;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      if (firstMs < 0 && buf.includes("event:")) firstMs = performance.now() - t0;
    }
  } catch {
    // koneksi diputus server (mis. idleTimeout Bun.serve) — kembalikan event yang sempat diterima
  }
  return { events: buf.split("\n\n").filter((b) => b.includes("event:")), firstMs };
}

export const hono: Check = {
  id: "hono",
  task: "S-02",
  packages: ["hono"],
  async run() {
    const notes: string[] = [];
    const app = new Hono();
    app.use("*", async (c, next) => {
      await next();
      c.header("x-request-id", "req_test");
    });
    app.get("/v1/topics/:id", (c) => c.json({ id: c.req.param("id") }));
    app.get("/v1/stream", (c) =>
      streamSSE(c, async (s) => {
        for (let i = 0; i < 3; i++) {
          await s.writeSSE({ event: "aggregates.updated", id: String(i), data: JSON.stringify({ i }) });
          await s.sleep(50);
        }
      }),
    );
    // SSE idle: satu event, diam 12 s (> default idleTimeout Bun.serve 10 s), lalu event kedua.
    app.get("/v1/stream-idle", (c) =>
      streamSSE(c, async (s) => {
        await s.writeSSE({ event: "a", data: "1" });
        await s.sleep(12_000);
        await s.writeSSE({ event: "b", data: "2" });
      }),
    );

    const server = Bun.serve({ port: 0, fetch: app.fetch });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const r = await fetch(`${base}/v1/topics/abc`);
      assert(r.headers.get("x-request-id") === "req_test", "middleware header");
      assert(((await r.json()) as { id: string }).id === "abc", "route param");
      notes.push("routing + middleware OK");

      const sse = await fetch(`${base}/v1/stream`);
      assert(sse.headers.get("content-type")?.startsWith("text/event-stream"), "SSE content-type");
      const { events, firstMs } = await readSse(sse);
      assert(events.length === 3, `3 SSE events, dapat ${events.length}`);
      assert(firstMs < 100, `event pertama harus tiba sebelum stream selesai (${firstMs} ms)`);
      notes.push(`SSE streaming inkremental OK (event pertama ${firstMs.toFixed(0)} ms, 3 event)`);

      const idle = await fetch(`${base}/v1/stream-idle`);
      const idleRes = await readSse(idle);
      const gotBoth = idleRes.events.length === 2;
      notes.push(
        gotBoth
          ? "SSE diam 12 s tetap hidup dengan idleTimeout default"
          : `GOTCHA: Bun.serve default idleTimeout (10 s) MEMUTUS SSE yang diam 12 s (dapat ${idleRes.events.length}/2 event). API_SPEC heartbeat 25 s → wajib Bun.serve({ idleTimeout: 0 }) untuk route SSE atau heartbeat < 10 s.`,
      );
    } finally {
      server.stop(true);
    }

    // Verifikasi workaround idleTimeout: 0.
    const server2 = Bun.serve({ port: 0, idleTimeout: 0, fetch: app.fetch });
    try {
      const res = await readSse(await fetch(`http://127.0.0.1:${server2.port}/v1/stream-idle`));
      assert(res.events.length === 2, `idleTimeout:0 harus menjaga SSE (dapat ${res.events.length})`);
      notes.push("workaround Bun.serve({ idleTimeout: 0 }) terbukti: 2/2 event");
    } finally {
      server2.stop(true);
    }
    const workaround = notes.some((n) => n.startsWith("GOTCHA"));
    return { status: workaround ? "WORKAROUND" : "COMPATIBLE", notes };
  },
};

export const zod: Check = {
  id: "zod",
  task: "S-02",
  packages: ["zod"],
  async run() {
    const Topic = z.object({
      name: z.string().min(1),
      platforms: z.array(
        z.object({
          code: z.string(),
          interval_sec: z.union([z.literal(300), z.literal(900), z.literal(1800), z.literal(2700), z.literal(3600)]),
        }),
      ),
      languages: z.array(z.enum(["id", "en", "ms"])).default(["id"]),
    });
    const ok = Topic.safeParse({ name: "KDMP", platforms: [{ code: "x", interval_sec: 900 }] });
    assert(ok.success && ok.data.languages[0] === "id", "parse + default");
    const bad = Topic.safeParse({ name: "", platforms: [{ code: "x", interval_sec: 600 }] });
    assert(!bad.success && bad.error.issues.length === 2, "2 issue (name kosong, interval 600 = 10m tidak valid)");
    const schema = z.toJSONSchema(Topic) as Record<string, unknown>;
    assert(String(schema.$schema).includes("2020-12"), `JSON Schema draft 2020-12 (dapat ${schema.$schema})`);
    return {
      status: "COMPATIBLE",
      notes: [
        "safeParse/default/issue path OK",
        `z.toJSONSchema → ${schema.$schema} (kontrak packages/contracts bisa digenerate tanpa lib tambahan)`,
      ],
    };
  },
};

export const joseCheck: Check = {
  id: "jose",
  task: "S-02",
  packages: ["jose"],
  async run() {
    const notes: string[] = [];
    for (const alg of ["EdDSA", "ES256"] as const) {
      const { publicKey, privateKey } = await jose.generateKeyPair(alg, { crv: alg === "EdDSA" ? "Ed25519" : undefined });
      const jwt = await new jose.SignJWT({ tid: "t1", role: "analyst" })
        .setProtectedHeader({ alg, kid: "k1" })
        .setSubject("u1")
        .setIssuedAt()
        .setExpirationTime("15m")
        .sign(privateKey);
      const { payload, protectedHeader } = await jose.jwtVerify(jwt, publicKey);
      assert(payload.sub === "u1" && protectedHeader.kid === "k1", `${alg} verify`);
      const tampered = jwt.slice(0, -4) + (jwt.endsWith("AAAA") ? "BBBB" : "AAAA");
      const rejected = await jose.jwtVerify(tampered, publicKey).then(
        () => false,
        () => true,
      );
      assert(rejected, `${alg} tamper harus ditolak`);
      notes.push(`${alg}: sign/verify/tamper-reject OK`);
    }
    return { status: "COMPATIBLE", notes };
  },
};

export const bunBuiltins: Check = {
  id: "bun-builtins",
  task: "S-08",
  packages: ["Bun.password", "Bun.randomUUIDv7"],
  async run() {
    const h = await Bun.password.hash("rahasia", { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });
    assert(h.startsWith("$argon2id$"), "argon2id prefix");
    assert(await Bun.password.verify("rahasia", h), "verify benar");
    assert(!(await Bun.password.verify("salah", h)), "verify salah");
    const t0 = performance.now();
    await Bun.password.hash("x", { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });
    const hashMs = performance.now() - t0;

    const ids = Array.from({ length: 20000 }, () => Bun.randomUUIDv7());
    const sorted = [...ids].sort();
    const monotonic = ids.every((v, i) => v === sorted[i]);
    assert(new Set(ids).size === ids.length, "uuid unik");
    assert(ids[0]![14] === "7", "versi 7");
    return {
      status: "COMPATIBLE",
      notes: [
        `Bun.password argon2id OK (m=19456 KiB, t=2: ${hashMs.toFixed(0)} ms/hash di host spike)`,
        `Bun.randomUUIDv7: 20k unik, ${monotonic ? "terurut monoton dalam proses" : "TIDAK monoton dalam ms yang sama — jangan andalkan urutan intra-ms"}`,
      ],
    };
  },
};
