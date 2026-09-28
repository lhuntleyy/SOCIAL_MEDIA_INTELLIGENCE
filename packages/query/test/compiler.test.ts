import { describe, expect, test } from "bun:test";
import { type CompilerCaps, compileGeneric, compileQuery, coverHashtags, coverSet, matchQuery, type Node, parse } from "../src";

const ast = (s: string, kw: string[] = []) => {
  const { version: _v, ...n } = compileQuery({ query_text: s, keywords: kw }).ast;
  return n as Node;
};
const FULL: CompilerCaps = { queryFeatures: ["term", "phrase", "or", "and", "not", "group"], maxQueryLength: 512 };
const TERM_ONLY: CompilerCaps = { queryFeatures: ["term"], maxQueryLength: null };
const OR_ONLY: CompilerCaps = { queryFeatures: ["term", "phrase", "or"], maxQueryLength: 40 };

describe("compileGeneric", () => {
  test("provider dukung penuh (mis. X search) → 1 query eksak", () => {
    const q = compileGeneric(ast('("demo" OR "unras") AND NOT "2025"', ["unjuk rasa"]), FULL);
    expect(q).toEqual([{ native: '(demo OR unras OR "unjuk rasa") -2025', leaves: ["demo", "unras", "unjuk rasa", "2025"], exact: true }]);
  });

  test("contoh CONNECTOR_SPEC §5: term-only → 3 sub-query demo, unras, unjuk rasa; NOT dievaluasi lokal", () => {
    const q = compileGeneric(ast('("demo" OR "unras") AND NOT "2025"', ["unjuk rasa"]), TERM_ONLY);
    expect(q.map((x) => x.native)).toEqual(["demo", "unras", "unjuk rasa"]);
    expect(q.every((x) => !x.exact)).toBe(true);
  });

  test("AND: cukup satu sisi (penutup terkecil, frasa lebih spesifik) → lebih sedikit hasil berbayar", () => {
    expect(coverSet(ast('kades AND ("kdmp" OR "koperasi merah putih")'))!.map((l) => l.value)).toEqual(["kades"]);
    expect(coverSet(ast('"kepala desa" AND kdmp'))!.map((l) => l.value)).toEqual(["kepala desa"]);
    expect(compileGeneric(ast("kades kdmp -hoaks"), TERM_ONLY).map((x) => x.native)).toEqual(["kades"]);
  });

  test("OR tanpa AND/NOT → dikemas dalam query OR sampai batas panjang (jumlah request minimal)", () => {
    const q = compileGeneric(ast('kopdes OR kdmp OR "koperasi merah putih" OR kades OR koperasi OR desa'), OR_ONLY);
    for (const s of q) expect(s.native.length).toBeLessThanOrEqual(40);
    expect(q.flatMap((s) => s.leaves)).toEqual(["kopdes", "kdmp", "koperasi merah putih", "kades", "koperasi", "desa"]);
    expect(q.length).toBe(2);
  });

  test("provider tanpa dukungan frasa: frasa dikirim sebagai kata (recall superset), tak eksak", () => {
    const q = compileGeneric(ast('"merah putih" OR kopdes'), { queryFeatures: ["term", "or"], maxQueryLength: null });
    expect(q).toEqual([{ native: "merah putih OR kopdes", leaves: ["merah putih", "kopdes"], exact: false }]);
  });

  test("kurung bersarang tanpa fitur 'group' → dekomposisi", () => {
    const q = compileGeneric(ast("(a OR b) AND c"), { queryFeatures: ["term", "or", "and"], maxQueryLength: null });
    expect(q.map((x) => x.native)).toEqual(["c"]);
  });

  test("properti recall: setiap item yang cocok AST mengandung ≥ 1 leaf sub-query (acak 300 kombinasi)", () => {
    const vocab = ["kopdes", "kdmp", "hoaks", "demo", "desa", "kades"];
    const queries = [
      "kopdes OR kdmp",
      "kades AND (kdmp OR desa)",
      "(demo OR kades) -hoaks",
      "kopdes kdmp desa",
      '"kepala desa" OR (demo AND kopdes)',
    ];
    let rnd = 7;
    const rand = () => {
      rnd = (rnd * 1103515245 + 12345) % 2 ** 31; // LCG deterministik → test reproducible
      return rnd / 2 ** 31;
    };
    for (const qs of queries) {
      const c = compileQuery({ query_text: qs });
      const leaves = compileGeneric(ast(qs), TERM_ONLY).flatMap((s) => s.leaves);
      for (let i = 0; i < 60; i++) {
        const words = vocab.filter(() => rand() < 0.4);
        if (rand() < 0.2) words.push("kepala", "desa");
        const text = words.join(" ");
        if (matchQuery(c, { text }).match) {
          const ok = leaves.some((l) => matchQuery(compileQuery({ query_text: `"${l}"` }), { text }).match);
          expect({ q: qs, text, ok }).toEqual({ q: qs, text, ok: true });
        }
      }
    }
  });

  test("hashtag-only (IG Graph/actor hashtag): penutup → hashtag tanpa spasi", () => {
    expect(coverHashtags(ast('"koperasi merah putih" OR #KDMP OR kopdes -hoaks'))).toEqual(["koperasimerahputih", "kdmp", "kopdes"]);
    expect(coverHashtags({ type: "not", child: { type: "term", value: "x" } })).toEqual([]);
  });

  test("leaf lebih panjang dari maxQueryLength → error jelas", () => {
    expect(() =>
      compileGeneric(parse('"a very long phrase indeed"'), { queryFeatures: ["term", "phrase", "or"], maxQueryLength: 5 }),
    ).toThrow("maxQueryLength");
  });
});
