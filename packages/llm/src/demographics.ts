// A-08/A-09 (AI_SPEC §12, ADR-007): perkiraan gender & rentang usia PER AKUN dari sinyal minimal (nama tampilan, username,
// tahun akun dibuat) — hanya untuk agregat Psikografi; tidak pernah ditampilkan per akun. Minimisasi (§12.3): tanpa bio/foto/post.
// Ambang confidence & penekanan below_18 diterapkan pemanggil (demographicsDecision) → yang ragu = unknown, bukan tebakan.
import type { JsonCall } from "./adapters";

export const DEMO_PROMPT_VERSION = "demo-v1";
export const GENDERS = ["male", "female", "unknown"] as const;
export const AGE_RANGES = ["below_18", "18_21", "22_30", "31_45", "46_55", "above_55", "unknown"] as const;
export type GenderLabel = (typeof GENDERS)[number];
export type AgeLabel = (typeof AGE_RANGES)[number];

/** Ambang (AI_SPEC §12.2 τ): di bawahnya → unknown. Disimpan bersama model_version (method) agar dapat ditinjau ulang. */
export const TAU_GENDER = 0.75;
export const TAU_AGE = 0.65;

export const DEMO_SYSTEM = `Kamu membantu statistik AGREGAT audiens media sosial Indonesia. Untuk setiap akun bernomor, perkirakan:
1. gender: male | female | unknown — HANYA dari nama orang yang jelas (mis. "Siti Rahma" → female, "Budi Santoso" → male).
   Akun organisasi/media/instansi/toko/komunitas, nama samaran, nama unisex, atau tidak yakin → unknown.
2. age_range: below_18 | 18_21 | 22_30 | 31_45 | 46_55 | above_55 | unknown — hanya bila ada petunjuk kuat (mis. tahun lahir di
   username, gelar/jabatan senior, tahun akun dibuat sangat lama). Tanpa petunjuk kuat → unknown. Jangan menebak dari stereotip.
3. confidence 0–1 untuk masing-masing (jujur; rendah bila ragu).
Jangan menyimpulkan atribut lain (agama, suku, politik, dll.). Kembalikan JSON sesuai schema untuk semua nomor.`;

export const DEMO_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          i: { type: "integer" },
          gender: { type: "string", enum: [...GENDERS] },
          gender_confidence: { type: "number" },
          age_range: { type: "string", enum: [...AGE_RANGES] },
          age_confidence: { type: "number" },
        },
        required: ["i", "gender", "gender_confidence", "age_range", "age_confidence"],
      },
    },
  },
  required: ["results"],
};

export interface DemoAuthor {
  displayName: string | null;
  handle: string | null;
  createdYear: number | null;
}
export interface DemoLabel {
  gender: GenderLabel;
  gender_confidence: number;
  age_range: AgeLabel;
  age_confidence: number;
}

export function buildDemographicsCall(authors: DemoAuthor[], maxOutputTokens = 4096): JsonCall {
  const lines = authors.map(
    (a, k) =>
      `[${k + 1}] nama: ${(a.displayName ?? "-").slice(0, 80)} | username: ${(a.handle ?? "-").slice(0, 60)}${a.createdYear ? ` | akun sejak ${a.createdYear}` : ""}`,
  );
  return { system: DEMO_SYSTEM, user: lines.join("\n"), schema: DEMO_SCHEMA, maxOutputTokens };
}

const clamp01 = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

export function parseDemographics(json: unknown, n: number): (DemoLabel | null)[] {
  const out: (DemoLabel | null)[] = Array.from({ length: n }, () => null);
  const results = (json as { results?: unknown[] })?.results;
  if (!Array.isArray(results)) return out;
  for (const r of results as Record<string, unknown>[]) {
    const i = Number(r.i) - 1;
    if (!Number.isInteger(i) || i < 0 || i >= n || out[i]) continue;
    if (!GENDERS.includes(r.gender as GenderLabel) || !AGE_RANGES.includes(r.age_range as AgeLabel)) continue;
    out[i] = {
      gender: r.gender as GenderLabel,
      gender_confidence: clamp01(r.gender_confidence),
      age_range: r.age_range as AgeLabel,
      age_confidence: clamp01(r.age_confidence),
    };
  }
  return out;
}

/**
 * Keputusan akhir yang disimpan per akun: di bawah τ → unknown (confidence tetap dicatat); `below_18` TIDAK disimpan per akun
 * (data anak, ADR-007) → unknown + method `minor_suppressed`.
 */
export function demographicsDecision(l: DemoLabel | null): {
  gender: Exclude<GenderLabel, never>;
  gender_conf: number;
  age_range: Exclude<AgeLabel, "below_18">;
  age_conf: number;
  minorSuppressed: boolean;
} {
  if (!l) return { gender: "unknown", gender_conf: 0, age_range: "unknown", age_conf: 0, minorSuppressed: false };
  const gender = l.gender !== "unknown" && l.gender_confidence >= TAU_GENDER ? l.gender : "unknown";
  const minor = l.age_range === "below_18";
  const age = !minor && l.age_range !== "unknown" && l.age_confidence >= TAU_AGE ? (l.age_range as Exclude<AgeLabel, "below_18">) : "unknown";
  return { gender, gender_conf: l.gender_confidence, age_range: age, age_conf: minor ? 0 : l.age_confidence, minorSuppressed: minor };
}
