// Parser query boolean topik (FR-T02, CONNECTOR_SPEC §5). Grammar:
//   query   := or EOF
//   or      := and ("OR" and)*
//   and     := unary (["AND"] unary)*          ← kata berdampingan = AND implisit
//   unary   := ("NOT" | "-") unary | primary
//   primary := PHRASE | WORD | "(" or ")"
// Operator hanya HURUF BESAR; "and"/"or"/"not" huruf kecil = kata biasa (bisa muncul di teks bahasa Inggris).
// Presedensi: NOT > AND > OR.
import { AST_VERSION, LIMITS, type Node, type QueryAst, QueryError } from "./ast";
import { tokenize } from "./normalize";

type Tok =
  | { k: "lp" | "rp" | "or" | "and" | "not"; pos: number }
  | { k: "word"; v: string; pos: number }
  | { k: "phrase"; v: string; pos: number };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    const pos = i + 1;
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === "(") {
      out.push({ k: "lp", pos });
      i++;
    } else if (ch === ")") {
      out.push({ k: "rp", pos });
      i++;
    } else if (ch === '"' || ch === "“" || ch === "”") {
      const close = src.slice(i + 1).search(/["“”]/);
      if (close < 0) throw new QueryError(`Tanda kutip tidak ditutup pada posisi ${pos}`, pos);
      const v = src.slice(i + 1, i + 1 + close);
      if (!tokenize(v).length) throw new QueryError(`Frasa kosong pada posisi ${pos}`, pos);
      out.push({ k: "phrase", v, pos });
      i += close + 2;
    } else if (ch === "-" && i + 1 < src.length && !/\s/.test(src[i + 1]!) && (i === 0 || /[\s(]/.test(src[i - 1]!))) {
      out.push({ k: "not", pos }); // "-kata" / -"frasa" / -(grup)
      i++;
    } else {
      let j = i;
      while (j < src.length && !/[\s()"“”]/.test(src[j]!)) j++;
      const w = src.slice(i, j);
      if (w === "OR") out.push({ k: "or", pos });
      else if (w === "AND") out.push({ k: "and", pos });
      else if (w === "NOT") out.push({ k: "not", pos });
      else out.push({ k: "word", v: w, pos });
      i = j;
    }
  }
  return out;
}

function leaf(kind: "word" | "phrase", raw: string, pos: number): Node {
  const toks = tokenize(raw);
  const isHashtag = kind === "word" && raw.startsWith("#") && toks.length === 1;
  if (!toks.length) throw new QueryError(`Kata "${raw}" tidak mengandung huruf/angka (posisi ${pos})`, pos);
  if (isHashtag) return { type: "term", value: `#${toks[0]}` };
  // "covid-19" / frasa satu kata dinormalisasi: 1 token = term, >1 token = phrase
  return toks.length === 1 ? { type: "term", value: toks[0]! } : { type: "phrase", value: toks.join(" ") };
}

function flatten(type: "and" | "or", parts: Node[]): Node {
  const children = parts.flatMap((p) => (p.type === type ? p.children : [p]));
  return children.length === 1 ? children[0]! : { type, children };
}

export function parse(src: string): QueryAst {
  if (src.length > LIMITS.maxLength) throw new QueryError(`Query terlalu panjang (maks ${LIMITS.maxLength} karakter)`);
  const toks = lex(src);
  if (!toks.length) throw new QueryError("Query kosong");
  let i = 0;
  let depth = 0;
  const peek = () => toks[i];
  const endPos = src.length + 1;

  const parseOr = (): Node => {
    const parts = [parseAnd()];
    while (peek()?.k === "or") {
      const t = toks[i++]!;
      if (!peek() || peek()!.k === "rp" || peek()!.k === "or" || peek()!.k === "and")
        throw new QueryError(`Operator OR tanpa operand kanan pada posisi ${t.pos}`, t.pos);
      parts.push(parseAnd());
    }
    return flatten("or", parts);
  };
  const startsUnary = (t: Tok | undefined) => !!t && (t.k === "word" || t.k === "phrase" || t.k === "lp" || t.k === "not");
  const parseAnd = (): Node => {
    const parts = [parseUnary()];
    for (;;) {
      const t = peek();
      if (t?.k === "and") {
        i++;
        if (!startsUnary(peek())) throw new QueryError(`Operator AND tanpa operand kanan pada posisi ${t.pos}`, t.pos);
        parts.push(parseUnary());
      } else if (startsUnary(t)) {
        parts.push(parseUnary()); // AND implisit
      } else break;
    }
    return flatten("and", parts);
  };
  const parseUnary = (): Node => {
    const t = peek();
    if (t?.k === "not") {
      i++;
      if (!startsUnary(peek())) throw new QueryError(`NOT tanpa operand pada posisi ${t.pos}`, t.pos);
      const child = parseUnary();
      return child.type === "not" ? child.child : { type: "not", child }; // NOT NOT x = x
    }
    return parsePrimary();
  };
  const parsePrimary = (): Node => {
    const t = toks[i++];
    if (!t) throw new QueryError(`Query berakhir tiba-tiba pada posisi ${endPos}`, endPos);
    if (t.k === "word" || t.k === "phrase") return leaf(t.k, t.v, t.pos);
    if (t.k === "lp") {
      if (++depth > LIMITS.maxDepth) throw new QueryError(`Kurung terlalu dalam (maks ${LIMITS.maxDepth} tingkat)`, t.pos);
      if (peek()?.k === "rp") throw new QueryError(`Kurung kosong pada posisi ${t.pos}`, t.pos);
      const inner = parseOr();
      const close = toks[i++];
      if (close?.k !== "rp") throw new QueryError(`Kurung buka pada posisi ${t.pos} tidak ditutup`, t.pos);
      depth--;
      return inner;
    }
    if (t.k === "rp") throw new QueryError(`Kurung tutup tanpa pasangan pada posisi ${t.pos}`, t.pos);
    throw new QueryError(`Operator ${t.k.toUpperCase()} tidak pada tempatnya (posisi ${t.pos})`, t.pos);
  };

  const ast = parseOr();
  if (i < toks.length) {
    const t = toks[i]!;
    throw new QueryError(
      t.k === "rp" ? `Kurung tutup tanpa pasangan pada posisi ${t.pos}` : `Token tak terduga pada posisi ${t.pos}`,
      t.pos,
    );
  }
  validateAst(ast);
  return { ...ast, version: AST_VERSION };
}

function count(n: Node): number {
  return n.type === "not" ? 1 + count(n.child) : n.type === "and" || n.type === "or" ? 1 + n.children.reduce((a, c) => a + count(c), 0) : 1;
}

/** Guard DoS (SEC-08) + harus punya minimal satu term/frasa POSITIF (query murni NOT = recall tak terbatas). */
export function validateAst(n: Node): void {
  if (count(n) > LIMITS.maxNodes) throw new QueryError(`Query terlalu kompleks (maks ${LIMITS.maxNodes} elemen)`);
  if (!positiveLeaves(n).length) throw new QueryError("Query harus punya minimal satu kata/frasa positif (bukan hanya NOT)");
}

/** Term/frasa yang tidak berada di bawah NOT — dasar recall ke provider & kandidat inverted index. */
export function positiveLeaves(n: Node, negated = false): Extract<Node, { type: "term" | "phrase" }>[] {
  switch (n.type) {
    case "term":
    case "phrase":
      return negated ? [] : [n];
    case "not":
      return positiveLeaves(n.child, !negated);
    default:
      return n.children.flatMap((c) => positiveLeaves(c, negated));
  }
}
