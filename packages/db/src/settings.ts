// Pengaturan sistem global (tabel system_settings, migrasi 0025) — diatur owner di Pengaturan → Batas & jadwal.
// Nilai yang tidak diset memakai default di bawah. Validasi tipe/rentang di API (routes/admin-providers.ts).
import { sql } from "drizzle-orm";
import type { Db, Tx } from "./client";
import { withSystem } from "./client";

export const SETTING_DEFAULTS = {
  /** Topik baru / platform baru: ambil data N hari ke belakang saat dibuat (0 = mati). */
  "topics.initial_backfill_days": 7,
  /** Komentar: ambil komentar dari post teratas tiap topik. */
  "comments.enabled": true,
  /** Komentar: jumlah post (engagement tertinggi) per topik per platform per hari yang diambil komentarnya. */
  "comments.top_posts_per_day": 20,
  /** Komentar: halaman komentar per post per pengambilan (±50 komentar/halaman). */
  "comments.max_pages_per_post": 1,
  /** Komentar: ambil ulang komentar post yang sama setelah N jam (komentar baru). */
  "comments.refetch_hours": 24,
  /** Komentar: hanya post yang terbit ≤ N hari terakhir. */
  "comments.max_post_age_days": 3,
} as const;
export type SettingKey = keyof typeof SETTING_DEFAULTS;
export type Settings = { -readonly [K in SettingKey]: (typeof SETTING_DEFAULTS)[K] extends boolean ? boolean : number };

export async function readSettings(tx: Tx): Promise<Settings> {
  const rows = (await tx.execute(sql`select key, value from system_settings`)) as unknown as { key: string; value: unknown }[];
  const out = { ...SETTING_DEFAULTS } as Record<string, unknown>;
  for (const r of rows) if (r.key in SETTING_DEFAULTS) out[r.key] = r.value;
  return out as Settings;
}

export function loadSettings(db: Db): Promise<Settings> {
  return withSystem(db, readSettings);
}
