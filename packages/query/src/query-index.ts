// Inverted index term → query kandidat (CONNECTOR_SPEC §5 "skalabilitas local matcher", ADR-009).
// Kunci query = token pertama tiap leaf di SET PENUTUP (coverSet): item yang cocok AST pasti memuat ≥ 1 leaf penutup,
// sehingga kandidat tidak pernah kehilangan match (recall = brute force); presisi tetap dari matchQuery penuh.
import type { Node } from "./ast";
import { coverSet } from "./compiler";
import { type MatchItem, matchQuery, type PreparedItem, prepareItem } from "./matcher";
import type { CompiledQuery } from "./query";

export interface IndexedQuery {
  id: string;
  query: CompiledQuery;
}

const leafKey = (value: string) => value.replace(/^#/, "").split(" ")[0]!;
/** Frasa juga cocok dengan hashtag gabungannya ("koperasi merah putih" ↔ #koperasimerahputih) — lihat evalNode. */
const leafKeys = (value: string) => {
  const v = value.replace(/^#/, "");
  return v.includes(" ") ? [leafKey(v), v.replace(/ /g, "")] : [leafKey(v)];
};

export class QueryIndex<Q extends IndexedQuery> {
  private readonly byKey = new Map<string, Q[]>();
  /** Query tanpa set penutup (mis. murni NOT) → selalu kandidat. */
  private readonly always: Q[] = [];
  readonly size: number;

  constructor(queries: Q[]) {
    this.size = queries.length;
    for (const q of queries) {
      const { version: _v, ...ast } = q.query.ast;
      const cover = coverSet(ast as Node);
      if (!cover?.length) {
        this.always.push(q);
        continue;
      }
      for (const key of new Set(cover.flatMap((l) => leafKeys(l.value)))) {
        const list = this.byKey.get(key);
        if (list) list.push(q);
        else this.byKey.set(key, [q]);
      }
    }
  }

  candidates(p: PreparedItem): Q[] {
    const out = new Set<Q>(this.always);
    const toks = [...p.joined.trim().split(" "), ...p.hashtags, ...(p.author ? [`@${p.author}`] : [])];
    for (const tok of new Set(toks)) for (const q of this.byKey.get(tok) ?? []) out.add(q);
    return [...out];
  }

  /** Semua query yang cocok penuh (filter bahasa/media + AST). */
  match(item: MatchItem | PreparedItem): Q[] {
    const p = "joined" in item ? item : prepareItem(item);
    return this.candidates(p).filter((q) => matchQuery(q.query, p).match);
  }
}
