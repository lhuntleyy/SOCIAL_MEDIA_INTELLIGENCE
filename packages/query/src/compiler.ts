// I-02: compiler query generik (CONNECTOR_SPEC §5.2). Provider hanya untuk RECALL; presisi = matcher lokal (ADR-006).
//   - AST didukung penuh + muat maxQueryLength → 1 query native eksak.
//   - Selain itu → dekomposisi ke SET PENUTUP MINIMAL: setiap item yang cocok AST pasti mengandung ≥ 1 leaf di set ini.
//       term/frasa → {dirinya}; OR → gabungan semua anak; AND → penutup anak positif TERKECIL (cukup satu sisi);
//       NOT → tidak bisa dipakai untuk recall.
//     Lalu leaf digabung dengan OR (bila didukung) sampai batas panjang → jumlah sub-query (= biaya request) minimal.
import type { Node } from "./ast";

import type { QueryFeature } from "@smip/contracts";

export type { QueryFeature };

export interface CompilerCaps {
  queryFeatures: QueryFeature[];
  /** null = tidak diketahui → konservatif (1 leaf per sub-query bila tak ada OR). */
  maxQueryLength: number | null;
}

export interface CompiledSubQuery {
  /** Query native sintaks umum (gaya X/Twitter): "frasa", OR, spasi = AND, -neg, (grup). Connector boleh me-render ulang. */
  native: string;
  /** Leaf yang diwakili sub-query ini (untuk jejak & inverted index). */
  leaves: string[];
  /** true = query native identik makna dengan AST (matcher tetap dijalankan). */
  exact: boolean;
}

type Leaf = Extract<Node, { type: "term" | "phrase" }>;

const quote = (l: Leaf, caps: Set<QueryFeature>) => {
  if (l.type === "term") return l.value; // termasuk "#tag"
  return caps.has("phrase") ? `"${l.value}"` : l.value; // tanpa dukungan frasa: kata-kata (recall superset)
};

function render(n: Node): string {
  switch (n.type) {
    case "term":
      return n.value;
    case "phrase":
      return `"${n.value}"`;
    case "not":
      return `-${n.child.type === "term" || n.child.type === "phrase" ? render(n.child) : `(${render(n.child)})`}`;
    case "and":
      return n.children.map((c) => (c.type === "or" ? `(${render(c)})` : render(c))).join(" ");
    case "or":
      return n.children.map((c) => render(c)).join(" OR ");
  }
}

function supported(n: Node, f: Set<QueryFeature>, depth = 0): boolean {
  switch (n.type) {
    case "term":
      return f.has("term");
    case "phrase":
      return f.has("phrase");
    case "not":
      return f.has("not") && supported(n.child, f, depth + 1);
    case "and":
    case "or":
      return f.has(n.type) && (depth === 0 || f.has("group")) && n.children.every((c) => supported(c, f, depth + 1));
  }
}

/** Set penutup minimal (lihat header). null = tidak bisa ditutup (mis. subtree murni NOT). */
export function coverSet(n: Node): Leaf[] | null {
  switch (n.type) {
    case "term":
    case "phrase":
      return [n];
    case "not":
      return null;
    case "or": {
      const parts = n.children.map(coverSet);
      if (parts.some((p) => p === null)) return null; // cabang OR yang tak bisa ditutup → recall tak terjamin
      return dedupe(parts.flat() as Leaf[]);
    }
    case "and": {
      const options = n.children.map(coverSet).filter((p): p is Leaf[] => p !== null);
      if (!options.length) return null;
      // pilih penutup dengan leaf paling sedikit; seri → paling spesifik (frasa/kata lebih panjang ≈ lebih sedikit hasil berbayar)
      const score = (ls: Leaf[]) => ls.length * 1000 - ls.reduce((a, l) => a + (l.type === "phrase" ? 100 : 0) + l.value.length, 0);
      return options.reduce((best, o) => (score(o) < score(best) ? o : best));
    }
  }
}

function dedupe(ls: Leaf[]): Leaf[] {
  return [...new Map(ls.map((l) => [`${l.type}:${l.value}`, l])).values()];
}

export function compileGeneric(ast: Node, caps: CompilerCaps): CompiledSubQuery[] {
  const f = new Set(caps.queryFeatures);
  const max = caps.maxQueryLength ?? Number.POSITIVE_INFINITY;
  if (supported(ast, f)) {
    const native = render(ast);
    if (native.length <= max) return [{ native, leaves: dedupe(collectLeaves(ast)).map((l) => l.value), exact: true }];
  }
  const cover = coverSet(ast);
  if (!cover) throw new Error("query tidak punya penutup positif (validasi seharusnya menolak)");
  if (!f.has("or")) return cover.map((l) => ({ native: quote(l, f), leaves: [l.value], exact: false }));
  // kemas leaf ke query OR sepanjang mungkin (bin packing sederhana, urutan stabil)
  const out: CompiledSubQuery[] = [];
  let cur: Leaf[] = [];
  const text = (ls: Leaf[]) => ls.map((l) => quote(l, f)).join(" OR ");
  for (const l of cover) {
    const next = [...cur, l];
    if (cur.length && text(next).length > max) {
      out.push({ native: text(cur), leaves: cur.map((x) => x.value), exact: false });
      cur = [l];
    } else cur = next;
  }
  if (cur.length) out.push({ native: text(cur), leaves: cur.map((x) => x.value), exact: false });
  for (const q of out) if (q.native.length > max) throw new Error(`leaf "${q.native}" melebihi maxQueryLength ${max}`);
  const isPureOr = ast.type === "or" && ast.children.every((c) => c.type === "term" || c.type === "phrase");
  if (out.length === 1 && isPureOr && (f.has("phrase") || !collectLeaves(ast).some((l) => l.type === "phrase"))) out[0]!.exact = true;
  return out;
}

function collectLeaves(n: Node): Leaf[] {
  return n.type === "term" || n.type === "phrase" ? [n] : n.type === "not" ? collectLeaves(n.child) : n.children.flatMap(collectLeaves);
}

/**
 * Untuk connector hashtag-only (operation search_hashtag, mis. IG Graph API / actor hashtag — CONNECTOR_SPEC §5):
 * setiap leaf penutup → hashtag (spasi dihapus): "koperasi merah putih" → koperasimerahputih.
 */
export function coverHashtags(ast: Node): string[] {
  const cover = coverSet(ast);
  if (!cover) return [];
  return [...new Set(cover.map((l) => l.value.replace(/^#/, "").replace(/\s+/g, "")))];
}
