// Pseudonimisasi AI_SPEC §2 (cermin workers-py/smip_nlp/preprocess.py — test paritas di packages/llm/test).
// Teks yang dikirim ke LLM & disimpan di korpus training: URL → <url>, mention → <user>, angka panjang → <num> (bukan tahun).
// alternasi (bukan character class): ZWJ di dalam [] ditandai lint sebagai penggabung emoji
const ZERO_WIDTH = /\u200b|\u200c|\u200d|\u2060|\ufeff/g;
const URL_RE = /https?:\/\/\S+|www\.\S+/gi;
const MENTION = /(?<![\w@])@[A-Za-z0-9_.]{1,30}/g;
const LONG_NUM = /\b\d{5,}\b|\b(?!(?:19|20)\d{2}\b)\d{4}\b/g;

export function pseudonymize(text: string): string {
  return text
    .normalize("NFKC")
    .replace(ZERO_WIDTH, "")
    .replace(URL_RE, "<url>")
    .replace(MENTION, "<user>")
    .replace(LONG_NUM, "<num>")
    .replace(/\s+/g, " ")
    .trim();
}

/** < 3 token bermakna → tidak dikirim ke LLM (neutral + short_text, AI_SPEC §2.7). */
export function isShort(text: string): boolean {
  return text.split(" ").filter((w) => w && !["<url>", "<user>", "<num>"].includes(w)).length < 3;
}
