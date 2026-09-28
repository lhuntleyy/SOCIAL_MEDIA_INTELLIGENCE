// Query efektif topic_query (ADR-008): ekspresi boolean + keywords + languages + media_tags/not_media_tags.
import { AST_VERSION, LIMITS, type Node, QueryError, type QueryAst } from "./ast";
import { parse, validateAst } from "./parser";
import { tokenize } from "./normalize";

export interface QueryInput {
  query_text?: string | null;
  keywords?: string[] | null;
  languages?: string[] | null;
  media_tags?: string[] | null;
  not_media_tags?: string[] | null;
}

export interface CompiledQuery {
  ast: QueryAst;
  languages: string[] | null;
  mediaTags: string[];
  notMediaTags: string[];
}

function keywordNode(k: string): Node {
  const toks = tokenize(k);
  if (!toks.length) throw new QueryError(`Keyword "${k}" tidak mengandung huruf/angka`);
  return toks.length === 1 ? { type: "term", value: toks[0]! } : { type: "phrase", value: toks.join(" ") };
}

/**
 * Keywords di-OR-kan ke INTI POSITIF, bukan ke root: NOT tetap berlaku untuk keyword.
 *   ("demo" OR "unras") AND NOT "2025" + ["unjuk rasa"] → ("demo" OR "unras" OR "unjuk rasa") AND NOT "2025"
 * (sesuai contoh API_SPEC §4 validate-query).
 */
export function mergeKeywords(ast: Node | null, keywords: string[]): Node {
  const kw = keywords.map(keywordNode);
  if (!ast) {
    if (!kw.length) throw new QueryError("Query kosong: isi ekspresi query atau minimal satu keyword");
    return kw.length === 1 ? kw[0]! : { type: "or", children: kw };
  }
  if (!kw.length) return ast;
  const orWith = (n: Node): Node => ({ type: "or", children: [...(n.type === "or" ? n.children : [n]), ...kw] });
  if (ast.type !== "and") return orWith(ast);
  const pos = ast.children.filter((c) => c.type !== "not");
  const neg = ast.children.filter((c) => c.type === "not");
  const core: Node = pos.length === 1 ? pos[0]! : { type: "and", children: pos };
  return { type: "and", children: [orWith(core), ...neg] };
}

const LANGS = new Set(["id", "en", "ms"]);

export function compileQuery(q: QueryInput): CompiledQuery {
  const keywords = (q.keywords ?? []).map((k) => k.trim()).filter(Boolean);
  if (keywords.length > LIMITS.maxKeywords) throw new QueryError(`Maksimal ${LIMITS.maxKeywords} keyword`);
  for (const k of keywords)
    if (k.length > LIMITS.maxKeywordLength) throw new QueryError(`Keyword terlalu panjang (maks ${LIMITS.maxKeywordLength})`);
  const text = q.query_text?.trim();
  const base = text ? (({ version: _v, ...n }) => n as Node)(parse(text)) : null;
  const merged = mergeKeywords(base, keywords);
  validateAst(merged);
  const languages = q.languages?.length ? [...new Set(q.languages)] : null;
  for (const l of languages ?? []) if (!LANGS.has(l)) throw new QueryError(`Bahasa "${l}" tidak didukung (id, en, ms)`);
  return {
    ast: { ...merged, version: AST_VERSION },
    languages,
    mediaTags: (q.media_tags ?? []).map((t) => t.trim()).filter(Boolean),
    notMediaTags: (q.not_media_tags ?? []).map((t) => t.trim()).filter(Boolean),
  };
}

/** Representasi teks kanonis (API validate-query `normalized`). */
export function stringify(n: Node): string {
  switch (n.type) {
    case "term":
      return n.value.startsWith("#") ? n.value : `"${n.value}"`;
    case "phrase":
      return `"${n.value}"`;
    case "not":
      return `NOT ${n.child.type === "and" || n.child.type === "or" ? `(${stringify(n.child)})` : stringify(n.child)}`;
    case "and":
      return n.children.map((c) => (c.type === "or" ? `(${stringify(c)})` : stringify(c))).join(" AND ");
    case "or":
      return n.children.map((c) => (c.type === "and" ? `(${stringify(c)})` : stringify(c))).join(" OR ");
  }
}

/** Bentuk kanonis (anak AND/OR diurutkan & dideduplikasi) → dasar ast_hash (dedup planner, ADR-009). */
export function canonical(n: Node): Node {
  switch (n.type) {
    case "term":
    case "phrase":
      return n;
    case "not":
      return { type: "not", child: canonical(n.child) };
    default: {
      const kids = n.children.map(canonical);
      const uniq = [...new Map(kids.map((k) => [JSON.stringify(k), k])).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, k]) => k);
      return uniq.length === 1 ? uniq[0]! : { type: n.type, children: uniq };
    }
  }
}

/** SHA-256 AST kanonis + filter (topic_queries.ast_hash). Dua query setara makna → hash sama. */
export async function astHash(c: CompiledQuery): Promise<Uint8Array<ArrayBuffer>> {
  const { version: _v, ...node } = c.ast;
  const payload = JSON.stringify({
    ast: canonical(node as Node),
    languages: c.languages ? [...c.languages].sort() : null,
    media: [...c.mediaTags].sort(),
    notMedia: [...c.notMediaTags].sort(),
  });
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload)));
}
