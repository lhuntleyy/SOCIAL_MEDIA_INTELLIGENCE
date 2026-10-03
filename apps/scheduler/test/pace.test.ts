import { describe, expect, test } from "bun:test";
import { emptyStreak, inNight, pace } from "../src/pace";

const S = {
  adaptive: true,
  adaptiveMaxSec: 10_800,
  night: true,
  nightStartHour: 0,
  nightEndHour: 6,
  nightSec: 10_800,
  timezone: "Asia/Jakarta",
};
const noon = new Date("2026-10-04T05:00:00Z"); // 12:00 WIB

describe("pace (jadwal adaptif + mode malam)", () => {
  test("streak run kosong dihitung dari yang terbaru", () => {
    expect(emptyStreak([0, 0, 3, 0])).toBe(2);
    expect(emptyStreak([4, 0, 0])).toBe(0);
    expect(emptyStreak([])).toBe(0);
  });
  test("adaptif: k ≥ 2 kosong → ×2^(k−1), maks. batas; jadwal dasar ≥ batas tidak diubah", () => {
    expect(pace(1800, [0], noon, S)).toEqual({ delaySec: 1800, reason: "base" });
    expect(pace(1800, [0, 0], noon, S)).toEqual({ delaySec: 3600, reason: "adaptive" });
    expect(pace(1800, [0, 0, 0, 0, 0, 0], noon, S).delaySec).toBe(10_800);
    expect(pace(21_600, [0, 0, 0], noon, S)).toEqual({ delaySec: 21_600, reason: "base" });
    expect(pace(1800, [0, 0, 0], noon, { ...S, adaptive: false }).reason).toBe("base");
  });
  test("malam WIB: paling cepat nightSec, tapi run berikutnya tidak melewati akhir malam", () => {
    expect(pace(1800, [], new Date("2026-10-03T18:00:00Z"), S)).toEqual({ delaySec: 10_800, reason: "night" }); // 01:00
    expect(pace(1800, [], new Date("2026-10-03T22:00:00Z"), S)).toEqual({ delaySec: 3600, reason: "night" }); // 05:00 → 06:00
    expect(pace(1800, [], new Date("2026-10-03T23:00:00Z"), S).reason).toBe("base"); // 06:00
  });
  test("jendela malam melewati tengah malam", () => {
    expect(inNight(23 * 60, 22, 5)).toBe(true);
    expect(inNight(4 * 60, 22, 5)).toBe(true);
    expect(inNight(12 * 60, 22, 5)).toBe(false);
    expect(inNight(60, 0, 0)).toBe(false);
  });
});
