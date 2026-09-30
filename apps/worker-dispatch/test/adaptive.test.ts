// COST_MODEL §11.2: maxItems adaptif untuk actor filter-per-hari yang terurut terbaru dulu.
import { expect, test } from "bun:test";
import { ADAPTIVE_MIN_ITEMS, adaptiveMaxItems } from "../src/adaptive";

const s = (itemsNew: number, windowMin = 60, maxItems: number | null = 300) => ({ itemsNew, windowMin, maxItems });

test("tanpa riwayat cukup (< 2 run) → batas platform penuh", () => {
  expect(adaptiveMaxItems([], 300, 300)).toBe(300);
  expect(adaptiveMaxItems([s(4)], 300, 300)).toBe(300);
});

test("topik sepi → minimum; topik ramai → 3× post baru yang diharapkan per interval", () => {
  // 2 post baru / 60 menit, interval 5 menit → 3 × 0,17 → minimum 5
  expect(adaptiveMaxItems([s(2), s(2)], 300, 300)).toBe(ADAPTIVE_MIN_ITEMS);
  // 120 post baru / 60 menit = 2/menit, interval 30 menit → 3 × 60 = 180
  expect(adaptiveMaxItems([s(120, 60, 300), s(120, 60, 300)], 1800, 300)).toBe(180);
  // tidak pernah melewati batas platform (Pengaturan → Sumber data)
  expect(adaptiveMaxItems([s(120, 60, 300), s(120, 60, 300)], 1800, 50)).toBe(50);
});

test("saturasi (hampir semua hasil baru) → naik 4× dari batas run terakhir", () => {
  // run terakhir minta 5 dan mendapat 5 post baru → mungkin ada yang terpotong → 20
  expect(adaptiveMaxItems([s(5, 5, 5), s(0, 5, 5)], 300, 300)).toBe(20);
  expect(adaptiveMaxItems([s(80, 5, 80), s(10, 5, 20)], 300, 300)).toBe(300); // 4 × 80 dibatasi 300
});

test("window 0 diabaikan (data run rusak) — tidak membagi nol", () => {
  expect(adaptiveMaxItems([s(3, 0), s(3, 60), s(3, 60)], 300, 300)).toBe(ADAPTIVE_MIN_ITEMS);
});
