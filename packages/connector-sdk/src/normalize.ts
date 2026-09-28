// Helper normalisasi yang dipakai semua connector (CONNECTOR_SPEC §4). Aturan: tak tahu = null, JANGAN menebak.
const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

export type TimeFormat = "iso_offset" | "twitter_classic" | "epoch_s" | "epoch_ms" | "auto";

/**
 * Waktu provider → ISO-8601 UTC ("…Z"), atau null bila tidak bisa dipastikan.
 * Ditolak: ISO TANPA offset (zona tak diketahui — kasus crawlerbros IG), waktu relatif ("2 jam lalu").
 * Format terverifikasi uji kontrak 2026-09-28: Twitter klasik (twitterapi.io, xquik), ISO+offset, epoch detik (TikTok, FB scrapeforge), epoch ms (FB scraper_one).
 */
export function toUtcIso(v: unknown, fmt: TimeFormat = "auto"): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" || (typeof v === "string" && /^\d{9,13}$/.test(v))) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    const ms = fmt === "epoch_ms" ? n : fmt === "epoch_s" ? n * 1000 : n >= 1e12 ? n : n * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v !== "string") return null;
  const tw = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) (\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{4}) (\d{4})$/.exec(v);
  if (tw) {
    const [, mon, day, hh, mm, ss, off, year] = tw;
    const month = MONTHS[mon!];
    if (month === undefined) return null;
    const sign = off!.startsWith("-") ? -1 : 1;
    const offMin = sign * (Number(off!.slice(1, 3)) * 60 + Number(off!.slice(3)));
    return new Date(Date.UTC(Number(year), month, Number(day), Number(hh), Number(mm), Number(ss)) - offMin * 60_000).toISOString();
  }
  // ISO: WAJIB ada 'Z' atau offset ±HH:MM / ±HHMM
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(v)) {
    const d = new Date(v.replace(" ", "T").replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/** Metrik: angka non-negatif bulat, selain itu null (bukan 0!). */
export function count(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/** Bandingkan ID snowflake sebagai BigInt ("9" > "10" secara leksikal → cursor mundur → bayar ulang data lama). */
export function compareIds(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

export function maxId(ids: string[]): string | null {
  return ids.reduce<string | null>((m, id) => (m === null || compareIds(id, m) > 0 ? id : m), null);
}

/** Field PII yang TIDAK boleh ikut ke extra/canonical walau provider mengirimnya (SECURITY §9 minimisasi). */
const PII_KEYS = /^(e-?mails?|phones?(_?numbers?)?|phone_numbers|contact_?info|address(es)?|birth_?(day|date)|bio_?links)$/i;
export function stripPii<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([k]) => !PII_KEYS.test(k))) as Partial<T>;
}
