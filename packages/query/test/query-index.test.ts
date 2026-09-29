// I-22: inverted index harus memberi hasil IDENTIK dengan matcher brute force (properti acak), dan kandidat jauh lebih sedikit.
import { describe, expect, test } from "bun:test";
import { compileQuery, matchQuery, prepareItem, QueryIndex } from "../src";

const VOCAB = ["banjir", "bencana", "gempa", "jakarta", "kopdes", "koperasi", "merah", "putih", "desa", "harga", "sembako", "demo"];
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

describe("QueryIndex", () => {
  const queries = [
    { id: "A", query: compileQuery({ query_text: "banjir OR bencana" }) },
    { id: "B", query: compileQuery({ query_text: "bencana OR gempa" }) },
    { id: "C", query: compileQuery({ query_text: "banjir AND jakarta" }) },
    { id: "D", query: compileQuery({ query_text: '"koperasi merah putih" OR kopdes', languages: ["id"] }) },
    { id: "E", query: compileQuery({ query_text: "#kdmp OR (harga AND -sembako)" }) },
    { id: "F", query: compileQuery({ query_text: "desa", media_tags: ["jakarta"] }) },
  ];
  const idx = new QueryIndex(queries);

  test("contoh ARCHITECTURE §12: satu post → semua topik yang cocok", () => {
    expect(
      idx
        .match({ text: "banjir besar di jakarta" })
        .map((q) => q.id)
        .sort(),
    ).toEqual(["A", "C"]);
    expect(
      idx
        .match({ text: "gempa dan bencana" })
        .map((q) => q.id)
        .sort(),
    ).toEqual(["A", "B"]);
    expect(
      idx
        .match({ text: "Koperasi Merah Putih desa kami #KDMP", lang: "in" })
        .map((q) => q.id)
        .sort(),
    ).toEqual(["D", "E"]);
    expect(idx.match({ text: "tidak relevan" })).toEqual([]);
  });

  test("properti: 3.000 item acak → hasil identik dengan brute force; kandidat rata-rata < total query", () => {
    const r = rng(42);
    let candTotal = 0;
    for (let i = 0; i < 3000; i++) {
      const words = Array.from({ length: 1 + Math.floor(r() * 6) }, () => VOCAB[Math.floor(r() * VOCAB.length)]!);
      if (r() < 0.2) words.push(`#${VOCAB[Math.floor(r() * VOCAB.length)]}`);
      const item = { text: words.join(" "), lang: r() < 0.5 ? "id" : r() < 0.5 ? "en" : null, hashtags: r() < 0.2 ? ["jakarta"] : [] };
      const p = prepareItem(item);
      const brute = queries.filter((q) => matchQuery(q.query, p).match).map((q) => q.id);
      expect(
        idx
          .match(p)
          .map((q) => q.id)
          .sort(),
      ).toEqual(brute.sort());
      candTotal += idx.candidates(p).length;
    }
    expect(candTotal / 3000).toBeLessThan(queries.length);
  });
});
