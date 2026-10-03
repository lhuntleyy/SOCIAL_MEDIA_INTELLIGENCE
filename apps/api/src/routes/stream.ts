// API_SPEC §7 — POST /stream/ticket (Bearer) → cookie sse_ticket; GET /stream?topic_id (cookie saja, SEC-10/SEC-11).
import type { TenantId } from "@smip/core";
import { type Db, withTenant } from "@smip/db";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { AppEnv } from "../context";
import { ApiError } from "../errors";
import { type Realtime, TICKET_TTL_SEC } from "../realtime";
import { parseJson } from "../validate";

export const SSE_COOKIE = "sse_ticket";

/** Dipasang di bawah middleware auth (Bearer). */
export function streamTicketRoutes(d: { db: Db; rt: Realtime }) {
  const r = new Hono<AppEnv>();
  r.post("/stream/ticket", async (c) => {
    const b = await parseJson(c, z.strictObject({ topic_id: z.uuid() }));
    const a = c.get("auth") as { sub: string; tid: string };
    const ok = (await withTenant(d.db, a.tid as TenantId, (tx) =>
      tx.execute(sql`select 1 from topics where id = ${b.topic_id} and deleted_at is null`),
    )) as unknown as unknown[];
    if (!ok.length) throw new ApiError("NOT_FOUND", "Topik tidak ditemukan");
    const token = await d.rt.issueTicket({ sub: a.sub, tid: a.tid, topic_id: b.topic_id });
    setCookie(c, SSE_COOKIE, token, { httpOnly: true, secure: true, sameSite: "Strict", path: "/v1/stream", maxAge: TICKET_TTL_SEC });
    return c.body(null, 204);
  });
  return r;
}

/** Dipasang TANPA middleware Bearer: autentikasi hanya lewat cookie tiket (EventSource tidak bisa mengirim header). */
export function streamRoutes(d: { rt: Realtime }) {
  const r = new Hono<AppEnv>();
  r.get("/stream", async (c) => {
    const topic = z.uuid().safeParse(c.req.query("topic_id"));
    const t = await d.rt.readTicket(getCookie(c, SSE_COOKIE));
    if (!t) throw new ApiError("UNAUTHENTICATED", "Tiket stream tidak valid / kedaluwarsa");
    if (!topic.success || topic.data !== t.topic_id) throw new ApiError("FORBIDDEN", "Tiket bukan untuk topik ini");
    return new Response(d.rt.stream(t, c.req.raw.signal), {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
        connection: "keep-alive",
      },
    });
  });
  return r;
}
