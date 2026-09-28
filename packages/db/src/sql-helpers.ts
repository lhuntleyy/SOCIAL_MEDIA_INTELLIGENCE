// drizzle + Bun.SQL: array JS di dalam sql`` DIEKSPANSI jadi list `($1, $2)` (cocok untuk `IN`), dan `sql.param(arr)`
// ditolak driver. Untuk kolom `text[]` kirim literal array Postgres sebagai satu parameter string lalu cast.
import { type SQL, sql } from "drizzle-orm";

const quoteEl = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** `text[]` sebagai satu parameter; null → NULL. Aman untuk koma, kutip, backslash, kurung kurawal. */
export function textArray(arr: readonly string[] | null | undefined): SQL {
  if (arr === null || arr === undefined) return sql`null::text[]`;
  return sql`${`{${arr.map(quoteEl).join(",")}}`}::text[]`;
}

/** Daftar untuk `IN (...)` yang tidak pernah kosong (IN () tidak valid). AWAS: `NOT IN (null)` = NULL → jangan dipakai untuk NOT IN kosong. */
export function inList(arr: readonly string[]): SQL {
  return arr.length ? sql`${arr}` : sql`(null)`;
}
