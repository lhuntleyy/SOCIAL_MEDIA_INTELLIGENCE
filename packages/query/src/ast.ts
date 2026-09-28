// AST query topik (DATA_MODEL §3.8). Disimpan di topic_queries.query_ast; `version` hanya di root.
export type Node =
  | { type: "term"; value: string }
  | { type: "phrase"; value: string }
  | { type: "not"; child: Node }
  | { type: "and"; children: Node[] }
  | { type: "or"; children: Node[] };

export type QueryAst = Node & { version: 1 };

export const AST_VERSION = 1 as const;

export const LIMITS = {
  /** = CHECK topic_queries.query_text ≤ 2000 */
  maxLength: 2000,
  maxDepth: 10,
  maxNodes: 200,
  maxKeywords: 50,
  maxKeywordLength: 100,
} as const;

export class QueryError extends Error {
  constructor(
    message: string,
    /** Posisi karakter 1-based pada query asli (null bila bukan kesalahan posisi). */
    public readonly position: number | null = null,
  ) {
    super(message);
    this.name = "QueryError";
  }
}
