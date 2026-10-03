// Jadwal adaptif + mode malam (keputusan pemilik 2026-10-04, COST_MODEL §12.6 butir 3–4). Biaya pengambilan didominasi JUMLAH RUN
// (biaya start Threads, lantai post FB), bukan jumlah post — maka run yang tidak membawa post baru adalah pemborosan murni:
//   - adaptif: k run terakhir berturut-turut tanpa post baru (k ≥ 2) → interval × 2^(k−1), paling lambat `adaptiveMaxSec`
//     (tidak pernah lebih cepat dari jadwal dasar). Satu run membawa post baru → kembali ke jadwal dasar di run berikutnya.
//   - mode malam: pada jam malam (zona waktu kantor) interval paling cepat `nightSec`, tapi run berikutnya tidak melewati akhir
//     malam (pagi langsung kembali normal).
// Pure → diuji unit; tick memanggilnya untuk plan & collection stream.

export interface PaceSettings {
  adaptive: boolean;
  adaptiveMaxSec: number;
  night: boolean;
  nightStartHour: number;
  nightEndHour: number;
  nightSec: number;
  timezone: string;
}

export const DEFAULT_PACE: PaceSettings = {
  adaptive: false,
  adaptiveMaxSec: 10_800,
  night: false,
  nightStartHour: 0,
  nightEndHour: 6,
  nightSec: 10_800,
  timezone: "Asia/Jakarta",
};

/** Jumlah run kosong berturut-turut dari yang terbaru (`recentNew` terbaru dulu). */
export const emptyStreak = (recentNew: number[]) => {
  let k = 0;
  for (const n of recentNew) {
    if (n > 0) break;
    k++;
  }
  return k;
};

const localHourMin = (d: Date, tz: string) => {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === "hour")!.value);
  const m = Number(parts.find((p) => p.type === "minute")!.value);
  return h * 60 + m;
};

/** Menit lokal ada di jendela malam [start, end) — mendukung jendela melewati tengah malam (mis. 22 → 5). */
export const inNight = (minuteOfDay: number, start: number, end: number) => {
  const s = start * 60;
  const e = end * 60;
  if (s === e) return false;
  return s < e ? minuteOfDay >= s && minuteOfDay < e : minuteOfDay >= s || minuteOfDay < e;
};

export interface Pace {
  /** detik sampai run berikutnya (sebelum jitter) */
  delaySec: number;
  reason: "base" | "adaptive" | "night";
}

export function pace(baseSec: number, recentNew: number[], now: Date, s: PaceSettings): Pace {
  let delay = baseSec;
  let reason: Pace["reason"] = "base";
  if (s.adaptive && baseSec < s.adaptiveMaxSec) {
    const k = emptyStreak(recentNew);
    if (k >= 2) {
      const slowed = Math.min(s.adaptiveMaxSec, baseSec * 2 ** (k - 1));
      if (slowed > delay) {
        delay = slowed;
        reason = "adaptive";
      }
    }
  }
  if (s.night && delay < s.nightSec) {
    const mod = localHourMin(now, s.timezone);
    if (inNight(mod, s.nightStartHour, s.nightEndHour)) {
      // menit tersisa sampai akhir malam → run berikutnya tidak lewat dari pagi
      const toEnd = ((s.nightEndHour * 60 - mod + 1440) % 1440) * 60;
      const nightDelay = Math.max(delay, Math.min(s.nightSec, toEnd));
      if (nightDelay > delay) {
        delay = nightDelay;
        reason = "night";
      }
    }
  }
  return { delaySec: delay, reason };
}
