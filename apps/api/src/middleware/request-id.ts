import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../context";

const VALID = /^[A-Za-z0-9._-]{8,64}$/;

/** X-Request-Id dari klien dipakai bila formatnya aman; selain itu dibuat baru (log/trace/envelope error). */
export const requestId = createMiddleware<AppEnv>(async (c, next) => {
  const incoming = c.req.header("x-request-id");
  const id = incoming && VALID.test(incoming) ? incoming : `req_${Bun.randomUUIDv7()}`;
  c.set("requestId", id);
  c.header("X-Request-Id", id);
  await next();
});
