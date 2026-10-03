// Pengaturan sistem global (tabel system_settings, migrasi 0025) — diatur owner di Pengaturan → Batas & jadwal.
// Nilai yang tidak diset memakai default di bawah. Validasi tipe/rentang di API (routes/admin-providers.ts).
import { sql } from "drizzle-orm";
import type { Db, Tx } from "./client";
import { withSystem } from "./client";

export const SETTING_DEFAULTS = {
  /** Lantai post per pengambilan untuk sumber terurut terbaru (maxItems adaptif; COST_MODEL §11.2). Lebih kecil = lebih hemat. */
  "fetch.min_items_per_run": 5,
  /** Psikografi (gender & rentang usia agregat, AI_SPEC §12): perkiraan per akun via LLM. */
  "demographics.enabled": true,
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
  /** Jadwal adaptif: topik/stream yang beberapa kali berturut-turut tanpa post baru otomatis melambat (×2 tiap run kosong). */
  "schedule.adaptive_enabled": true,
  /** Jadwal adaptif: interval paling lambat untuk topik sepi (detik). Topik dengan jadwal lebih lambat dari ini tidak diubah. */
  "schedule.adaptive_max_interval_sec": 10_800,
  /** Mode malam: di jam malam (zona waktu kantor) pengambilan paling cepat tiap `schedule.night_interval_sec`. */
  "schedule.night_enabled": true,
  /** Mode malam: jam mulai & selesai (0–23, WIB bawaan). */
  "schedule.night_start_hour": 0,
  "schedule.night_end_hour": 6,
  "schedule.night_interval_sec": 10_800,
  /** Retensi (H-04, DATA_MODEL §9): post yang tidak cocok topik mana pun dihapus setelah N hari. */
  "retention.unmatched_posts_days": 30,
  /** Retensi: post yang pernah cocok tapi tak lagi dipakai kantor mana pun dihapus setelah N hari. */
  "retention.global_posts_days": 400,
  /** Retensi data kantor bila paket tidak menentukan `retention_days`. */
  "retention.default_tenant_days": 365,
  /** Retensi data operasional (outbox terkirim, ledger dedup) — hari. */
  "retention.ops_days": 30,
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
