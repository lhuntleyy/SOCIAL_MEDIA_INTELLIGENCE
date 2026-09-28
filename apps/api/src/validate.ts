import type { Context } from "hono";
import type { z } from "zod";
import { ApiError } from "./errors";

/** Validasi body JSON dengan Zod → 400 VALIDATION_FAILED berisi path & issue (tanpa menggemakan nilai input). */
export async function parseJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError("VALIDATION_FAILED", "Body harus JSON valid");
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new ApiError(
      "VALIDATION_FAILED",
      "Input tidak valid",
      r.error.issues.map((i) => ({ path: i.path.join("."), issue: i.code === "invalid_type" ? "wajib / tipe salah" : i.message })),
    );
  }
  return r.data;
}
