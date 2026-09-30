// maxItems adaptif (COST_MODEL §11.2): actor dengan filter waktu per hari mengembalikan ulang post 24 jam terakhir di setiap poll
// dan provider menagih per hasil → pada interval rapat biaya berlipat (terbukti ~23× di 1 jam, 288× di 5 menit). Untuk actor yang
// hasilnya TERBARU DULU, cukup minta ± 3× post baru yang diharapkan per interval: yang terpotong hanya post lama (sudah dimiliki).
// Saturasi (hampir semua hasil baru) → batas dinaikkan 4×; karena filternya per hari, post yang sempat terlewat ikut terambil run
// berikutnya. Actor tak terurut TIDAK memakai ini (memotong bisa membuang post baru).

export interface RunSample {
  /** post baru (belum pernah dimiliki) yang dikembalikan run */
  itemsNew: number;
  /** lebar window run (menit) */
  windowMin: number;
  /** maxItems yang diminta run itu (null = tak diketahui) */
  maxItems: number | null;
}

export const ADAPTIVE_MIN_ITEMS = 5;
export const ADAPTIVE_SAFETY = 3;
export const ADAPTIVE_GROWTH = 4;

/**
 * @param history run incremental selesai terbaru dulu (maks. ±6); < 2 sampel → `platformMax` (belum ada dasar perkiraan)
 * @returns maxItems untuk run berikutnya, selalu dalam [ADAPTIVE_MIN_ITEMS, platformMax]
 */
export function adaptiveMaxItems(history: RunSample[], intervalSec: number, platformMax: number): number {
  const h = history.filter((r) => r.windowMin > 0);
  if (h.length < 2) return platformMax;
  const perMin = h.reduce((a, r) => a + r.itemsNew, 0) / h.reduce((a, r) => a + r.windowMin, 0);
  let n = Math.max(ADAPTIVE_MIN_ITEMS, Math.ceil(ADAPTIVE_SAFETY * perMin * (intervalSec / 60)));
  const last = h[0]!;
  if (last.maxItems && last.itemsNew >= 0.8 * last.maxItems) n = Math.max(n, last.maxItems * ADAPTIVE_GROWTH);
  return Math.min(platformMax, n);
}
