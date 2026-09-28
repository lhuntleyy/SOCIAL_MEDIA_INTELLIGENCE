// Helper normalisasi bersama connector Apify. Aturan: tak tahu = null, JANGAN menebak (CONNECTOR_SPEC §4).
import type { CanonicalItem } from "@smip/contracts";
import type { FetchRequest } from "@smip/connector-sdk";

export type Obj = Record<string, unknown>;
export type NormMeta = { key: string; version: string; fetchedAt: string; rawRef: string | null };

export const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length ? v : typeof v === "number" ? String(v) : null);
export const url = (v: unknown): string | null => {
  const s = str(v);
  return s && /^https?:\/\/\S+$/.test(s) ? s : null;
};
/** Tanggal UTC `YYYY-MM-DD` dari ISO (untuk actor yang hanya menerima tanggal — window dipersempit lagi secara lokal). */
export const ymd = (iso: string | undefined) => (iso ? iso.slice(0, 10) : undefined);

export const provenance = (m: NormMeta): CanonicalItem["provenance"] => ({
  connector_key: m.key,
  connector_version: m.version,
  fetched_at: m.fetchedAt,
  raw_ref: m.rawRef,
});

export const noGeo = { lat: null, lng: null, place_name: null };

/** Umur window (hari) — memilih filter kasar actor yang pasti mencakup `since`. */
export function windowAgeDays(w: FetchRequest["window"], now = Date.now()): number | null {
  if (!w?.since) return null;
  return (now - Date.parse(w.since)) / 86_400_000;
}

/** Kata kunci pencarian dari query native (dipakai actor yang hanya menerima teks biasa). */
export const plainQuery = (req: FetchRequest) => (req.query?.native ?? "").trim();
