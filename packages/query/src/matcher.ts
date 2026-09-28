// Matcher lokal (CONNECTOR_SPEC §5.3, ADR-006): SUMBER KEBENARAN semantik query — provider hanya untuk recall.
// Item disiapkan sekali (prepareItem) lalu dievaluasi terhadap banyak query (inverted index: I-22).
import type { Node } from "./ast";
import { hashtagsIn, normalizeTag, tokenize } from "./normalize";
import type { CompiledQuery } from "./query";

export interface MatchItem {
  text: string;
  /** Hashtag dari provider (dengan/tanpa '#'); digabung dengan hashtag yang ada di teks. */
  hashtags?: string[] | null;
  /** Kode bahasa hasil deteksi (ISO 639-1; kode provider seperti "in" dinormalisasi). null = tidak diketahui. */
  lang?: string | null;
  /** Tag/label konten tambahan dari pipeline (dipakai media_tags — interpretasi ADR-008). */
  tags?: string[] | null;
}

export interface PreparedItem {
  joined: string; // " tok1 tok2 … " — pencocokan frasa kontigu & term utuh
  hashtags: Set<string>;
  lang: string | null;
  tags: Set<string>;
}

/** Kode bahasa provider → ISO 639-1 yang dipakai query (X memakai "in" untuk Indonesia). */
const LANG_ALIAS: Record<string, string> = { in: "id", ind: "id", msa: "ms", zsm: "ms", zlm: "ms", may: "ms", eng: "en" };
export function normalizeLang(l: string | null | undefined): string | null {
  if (!l) return null;
  const base = l.toLowerCase().split(/[-_]/)[0]!;
  if (base === "und" || base === "zxx" || base === "qme" || base === "qht") return null; // kode X: tak terdefinisi / hanya media / hashtag
  return LANG_ALIAS[base] ?? base;
}

export function prepareItem(i: MatchItem): PreparedItem {
  const hashtags = new Set([...(i.hashtags ?? []).map(normalizeTag), ...hashtagsIn(i.text)].filter(Boolean));
  const tokens = tokenize(i.text);
  return {
    joined: ` ${tokens.join(" ")} `,
    hashtags,
    lang: normalizeLang(i.lang),
    tags: new Set([...(i.tags ?? []).map(normalizeTag), ...hashtags].filter(Boolean)),
  };
}

export function evalNode(n: Node, p: PreparedItem): boolean {
  switch (n.type) {
    case "term":
      return n.value.startsWith("#") ? p.hashtags.has(n.value.slice(1)) : p.joined.includes(` ${n.value} `) || p.hashtags.has(n.value);
    case "phrase":
      return p.joined.includes(` ${n.value} `);
    case "not":
      return !evalNode(n.child, p);
    case "and":
      return n.children.every((c) => evalNode(c, p));
    case "or":
      return n.children.some((c) => evalNode(c, p));
  }
}

export type MatchResult = { match: true } | { match: false; reason: "query" | "language" | "media_tags" | "not_media_tags" };

/**
 * Terapkan query lengkap. Bahasa: item ber-bahasa tak diketahui (null) TETAP lolos filter bahasa —
 * membuangnya diam-diam menyembunyikan kategori unknown (AGENTS §3a); dashboard menampilkan "tidak diketahui".
 */
export function matchQuery(q: CompiledQuery, item: MatchItem | PreparedItem): MatchResult {
  const p = "joined" in item ? item : prepareItem(item);
  if (q.languages && p.lang && !q.languages.includes(p.lang)) return { match: false, reason: "language" };
  if (q.mediaTags.length && !q.mediaTags.some((t) => p.tags.has(normalizeTag(t)))) return { match: false, reason: "media_tags" };
  if (q.notMediaTags.some((t) => p.tags.has(normalizeTag(t)))) return { match: false, reason: "not_media_tags" };
  return evalNode(q.ast, p) ? { match: true } : { match: false, reason: "query" };
}
