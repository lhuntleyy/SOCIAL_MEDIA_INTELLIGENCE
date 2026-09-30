// Klasifikasi batch sentimen + emosi dengan SATU panggilan LLM per batch (hemat kuota/RPM tier gratis) — AI_SPEC §4.5/§4A.
// Output JSON terstruktur; item yang hilang/invalid dilaporkan terpisah (pemanggil memberi label aman, tidak menebak).
import type { JsonCall } from "./adapters";

export const SENTIMENTS = ["negative", "neutral", "positive"] as const;
export const EMOTIONS = ["anger", "anticipation", "disgust", "trust", "joy", "sadness", "surprise", "fear", "unknown"] as const;
export type SentimentLabel = (typeof SENTIMENTS)[number];
export type EmotionLabel = (typeof EMOTIONS)[number];

export const PROMPT_VERSION = "sent-emo-iss-v2";

export const BATCH_SYSTEM = `Kamu analis media sosial Indonesia. Untuk SETIAP post bernomor, tentukan terhadap TOPIK yang diberikan:
1. sentiment: negative | neutral | positive — sikap penulis terhadap topik. Sarkasme dinilai dari maksud, bukan kata literal
   ("hebat banget, gaji belum cair 👏" = negative). Berita/pengumuman/pertanyaan tanpa opini = neutral.
2. emotion: emosi dominan penulis — anger, anticipation, disgust, trust, joy, sadness, surprise, fear; bila tidak jelas atau
   hanya informatif = unknown (jangan menebak).
3. confidence 0–1 untuk masing-masing (jujur; rendah bila ragu).
4. issues: 0–3 frasa isu yang dibicarakan post, masing-masing 1–4 kata bahasa aslinya, huruf kecil, tanpa tanda baca/hashtag/
   mention/URL (contoh: "kampus negeri", "pegawai bumn", "utang kopdes"). Isu = hal/peristiwa/kebijakan/tokoh yang dibahas, BUKAN
   nama topik itu sendiri dan bukan kata umum ("berita", "hari ini"). Tidak ada isu jelas → [].
Teks sudah disamarkan (<user>, <url>, <num>). Kembalikan JSON sesuai schema untuk semua nomor post.`;

export const BATCH_SCHEMA = {
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
          sentiment: { type: "string", enum: [...SENTIMENTS] },
          sentiment_confidence: { type: "number" },
          emotion: { type: "string", enum: [...EMOTIONS] },
          emotion_confidence: { type: "number" },
          issues: { type: "array", items: { type: "string" } },
        },
        required: ["i", "sentiment", "sentiment_confidence", "emotion", "emotion_confidence", "issues"],
      },
    },
  },
  required: ["results"],
};

export interface BatchItem {
  text: string;
}
export interface ItemLabel {
  sentiment: SentimentLabel;
  sentiment_confidence: number;
  emotion: EmotionLabel;
  emotion_confidence: number;
  /** Frasa isu (AI_SPEC §5): huruf kecil, 1–4 kata, maks 3. */
  issues: string[];
}

const MAX_CHARS = 1200;

export function buildBatchCall(topic: string, items: BatchItem[], maxOutputTokens = 4096): JsonCall {
  const lines = items.map((it, k) => `[${k + 1}] ${it.text.slice(0, MAX_CHARS)}`);
  return { system: BATCH_SYSTEM, user: `TOPIK: ${topic}\n\n${lines.join("\n\n")}`, schema: BATCH_SCHEMA, maxOutputTokens };
}

/** Frasa isu dari LLM → bersih: huruf kecil, tanpa tanda baca/mention/URL, 1–4 kata, ≤ 60 karakter, unik, maks 3. */
export function cleanIssues(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== "string") continue;
    const s = raw
      .normalize("NFKC")
      .toLowerCase()
      .replace(/<[^>]*>|https?:\/\/\S+|[#@]/g, " ")
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    const words = s.split(" ").filter(Boolean).length;
    if (s.length < 3 || s.length > 60 || words > 4 || out.includes(s)) continue;
    out.push(s);
    if (out.length === 3) break;
  }
  return out;
}

const clamp01 = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** Jawaban LLM → label per indeks (0-based). Indeks di luar rentang / label tak dikenal diabaikan. */
export function parseBatch(json: unknown, n: number): (ItemLabel | null)[] {
  const out: (ItemLabel | null)[] = Array.from({ length: n }, () => null);
  const results = (json as { results?: unknown[] })?.results;
  if (!Array.isArray(results)) return out;
  for (const r of results as Record<string, unknown>[]) {
    const i = Number(r.i) - 1;
    if (!Number.isInteger(i) || i < 0 || i >= n || out[i]) continue;
    if (!SENTIMENTS.includes(r.sentiment as SentimentLabel) || !EMOTIONS.includes(r.emotion as EmotionLabel)) continue;
    out[i] = {
      sentiment: r.sentiment as SentimentLabel,
      sentiment_confidence: clamp01(r.sentiment_confidence),
      emotion: r.emotion as EmotionLabel,
      emotion_confidence: clamp01(r.emotion_confidence),
      issues: cleanIssues(r.issues),
    };
  }
  return out;
}
