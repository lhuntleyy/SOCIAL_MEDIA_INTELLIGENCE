import { describe, expect, test } from "bun:test";
import {
  astHash,
  compileQuery,
  LIMITS,
  matchQuery,
  type Node,
  normalizeLang,
  normalizeText,
  parse,
  positiveLeaves,
  prepareItem,
  QueryError,
  QueryIndex,
  stringify,
} from "../src";

const strip = ({ version: _v, ...n }: Node & { version?: number }) => n as Node;
const P = (s: string) => strip(parse(s));
const err = (s: string) => {
  try {
    parse(s);
  } catch (e) {
    if (e instanceof QueryError) return e;
  }
  throw new Error(`tidak gagal: ${s}`);
};
const m = (q: Parameters<typeof compileQuery>[0], item: Parameters<typeof matchQuery>[1]) => matchQuery(compileQuery(q), item).match;

describe("parser", () => {
  test("frasa, OR, AND, NOT, kurung → AST DATA_MODEL §3.8", () => {
    expect(P('"demo dpr" OR demo OR ("27 agustus" AND NOT 2025)')).toEqual({
      type: "or",
      children: [
        { type: "phrase", value: "demo dpr" },
        { type: "term", value: "demo" },
        {
          type: "and",
          children: [
            { type: "phrase", value: "27 agustus" },
            { type: "not", child: { type: "term", value: "2025" } },
          ],
        },
      ],
    });
    expect(parse("demo").version).toBe(1);
  });

  test("presedensi NOT > AND > OR; kata berdampingan = AND implisit; '-' = NOT", () => {
    expect(P("a OR b c")).toEqual({
      type: "or",
      children: [
        { type: "term", value: "a" },
        {
          type: "and",
          children: [
            { type: "term", value: "b" },
            { type: "term", value: "c" },
          ],
        },
      ],
    });
    expect(P("demo -2025")).toEqual(P("demo AND NOT 2025"));
    expect(P('kopdes -"berita lama"')).toEqual({
      type: "and",
      children: [
        { type: "term", value: "kopdes" },
        { type: "not", child: { type: "phrase", value: "berita lama" } },
      ],
    });
    expect(P("a NOT NOT b")).toEqual(P("a b"));
    expect(P("covid-19")).toEqual({ type: "phrase", value: "covid 19" }); // '-' di tengah kata bukan NOT
  });

  test("@username (topik akun): term author — cocok bila penulis = username, bukan isi teks", () => {
    expect(P("@Solo.Times")).toEqual({ type: "term", value: "@solo.times" });
    const q = compileQuery({ query_text: "@solo.times OR @kemenkop" });
    expect(matchQuery(q, { text: "apa saja", author: "Solo.Times" }).match).toBe(true);
    expect(matchQuery(q, { text: "menyebut @solo.times di teks", author: "orang_lain" }).match).toBe(false);
    const idx = new QueryIndex([{ id: "a", query: q }]);
    expect(idx.match({ text: "x", author: "kemenkop" }).map((m) => m.id)).toEqual(["a"]);
  });

  test("operator tidak peka huruf; kata operator harfiah lewat kutip", () => {
    expect(P("jokowi or jkw")).toEqual({ type: "or", children: ["jokowi", "jkw"].map((v) => ({ type: "term", value: v })) });
    expect(P("demo and not rusuh")).toEqual(P("demo AND NOT rusuh"));
    expect(P('rock "and" roll')).toEqual({ type: "and", children: ["rock", "and", "roll"].map((v) => ({ type: "term", value: v })) });
  });

  test("normalisasi: huruf besar/kecil, diakritik, kutip miring, hashtag", () => {
    expect(P("“DEMO   DPR”")).toEqual({ type: "phrase", value: "demo dpr" });
    expect(P("Café")).toEqual({ type: "term", value: "cafe" });
    expect(P("#DemoDPR")).toEqual({ type: "term", value: "#demodpr" });
    expect(normalizeText("Ｋｏｐｄｅｓ​")).toBe("kopdes"); // NFKC fullwidth + zero-width
  });

  test("error berposisi (API_SPEC §4 validate-query)", () => {
    expect(err('("demo" OR "unras) AND x')).toMatchObject({ message: "Tanda kutip tidak ditutup pada posisi 12", position: 12 }); // `"` sebelum unras
    expect(err("demo)").position).toBe(5);
    expect(err("(demo").message).toContain("tidak ditutup");
    expect(err("demo OR").message).toContain("OR tanpa operand");
    expect(err("demo AND").message).toContain("AND tanpa operand");
    expect(err("()").message).toContain("Kurung kosong");
    expect(err('""').message).toContain("Frasa kosong");
    expect(err("   ").message).toBe("Query kosong");
    expect(err("OR demo").message).toContain("tidak pada tempatnya");
  });

  test("SEC-08 guard DoS: panjang, kedalaman, jumlah elemen; query murni NOT ditolak", () => {
    expect(err("a".repeat(LIMITS.maxLength + 1)).message).toContain("terlalu panjang");
    expect(err(`${"(".repeat(11)}a${")".repeat(11)}`).message).toContain("terlalu dalam");
    expect(parse(`${"(".repeat(10)}a${")".repeat(10)}`).type).toBe("term");
    expect(err(Array.from({ length: 250 }, (_, i) => `k${i}`).join(" OR ")).message).toContain("terlalu kompleks");
    expect(err("NOT spam").message).toContain("minimal satu kata/frasa positif");
    expect(err("-a -b").message).toContain("positif");
  });

  test("positiveLeaves: hanya term/frasa di luar NOT (dasar recall provider)", () => {
    expect(positiveLeaves(P('("demo" OR unras) AND NOT (2025 OR NOT hoax)')).map((l) => l.value)).toEqual(["demo", "unras", "hoax"]);
  });
});

describe("compileQuery + keywords (ADR-008)", () => {
  test("contoh API_SPEC §4: keyword di-OR-kan ke inti positif, NOT tetap berlaku", () => {
    const c = compileQuery({ query_text: '("demo" OR "unras") AND NOT "2025"', keywords: ["unjuk rasa"], languages: ["id"] });
    expect(stringify(c.ast)).toBe('("demo" OR "unras" OR "unjuk rasa") AND NOT "2025"');
    expect(positiveLeaves(c.ast).map((l) => l.value)).toEqual(["demo", "unras", "unjuk rasa"]);
  });

  test("keyword saja (tanpa ekspresi) & root non-AND", () => {
    expect(stringify(compileQuery({ keywords: ["kopdes", "koperasi merah putih"] }).ast)).toBe('"kopdes" OR "koperasi merah putih"');
    expect(stringify(compileQuery({ query_text: "kdmp", keywords: ["kopdes"] }).ast)).toBe('"kdmp" OR "kopdes"');
    expect(() => compileQuery({ query_text: "", keywords: [] })).toThrow("Query kosong");
    expect(() => compileQuery({ query_text: "x", languages: ["fr"] })).toThrow("tidak didukung");
  });

  test("astHash: setara makna → sama; beda filter → beda", async () => {
    const h = async (q: Parameters<typeof compileQuery>[0]) => Buffer.from(await astHash(compileQuery(q))).toString("hex");
    expect(await h({ query_text: "a OR b OR a" })).toBe(await h({ query_text: "(b OR a)" }));
    expect(await h({ query_text: "a b", languages: ["id", "en"] })).toBe(await h({ query_text: "b AND a", languages: ["en", "id"] }));
    expect(await h({ query_text: "a b" })).not.toBe(await h({ query_text: "a b", languages: ["id"] }));
  });
});

describe("matcher lokal", () => {
  test("contoh CONNECTOR_SPEC §5: (demo OR unras) AND NOT 2025 + keyword 'unjuk rasa'", () => {
    const q = { query_text: '("demo" OR "unras") AND NOT "2025"', keywords: ["unjuk rasa"] };
    expect(m(q, { text: "Demo di depan gedung DPR hari ini" })).toBe(true);
    expect(m(q, { text: "Ribuan orang UNJUK RASA di Jakarta" })).toBe(true);
    expect(m(q, { text: "Kilas balik demo 2025" })).toBe(false);
    expect(m(q, { text: "demokrasi kita" })).toBe(false); // term utuh, bukan substring
  });

  test("P-04: 'A AND NOT B' pada connector term-only — item berisi B TIDAK match", () => {
    const q = { query_text: "kopdes AND NOT hoaks" };
    const fromProvider = ["kopdes hoaks lagi", "kopdes resmi diluncurkan", "Kopdes: ini HOAKS!"];
    expect(fromProvider.map((text) => m(q, { text }))).toEqual([false, true, false]);
  });

  test("frasa harus kontigu & berurutan; hashtag cocok lewat term & #term", () => {
    expect(m({ query_text: '"merah putih"' }, { text: "koperasi Merah-Putih desa" })).toBe(true);
    expect(m({ query_text: '"merah putih"' }, { text: "putih merah" })).toBe(false);
    expect(m({ query_text: "demodpr" }, { text: "rame #DemoDPR hari ini" })).toBe(true);
    expect(m({ query_text: "#demodpr" }, { text: "demodpr tanpa pagar" })).toBe(false); // #term = khusus hashtag
    expect(m({ query_text: "#demodpr" }, { text: "cek", hashtags: ["DemoDPR"] })).toBe(true); // hashtag dari provider
    expect(m({ query_text: "#demo_dpr" }, { text: "x #Demo_DPR" })).toBe(true);
  });

  test("P-12: keywords + languages + media_tags/not_media_tags diterapkan bersama", () => {
    const q = compileQuery({
      query_text: "kopdes",
      keywords: ["kdmp"],
      languages: ["id"],
      media_tags: ["video", "#resmi"],
      not_media_tags: ["iklan"],
    });
    const r = (item: Parameters<typeof matchQuery>[1]) => matchQuery(q, item);
    expect(r({ text: "KDMP launching #resmi", lang: "in" })).toEqual({ match: true }); // X: "in" = Indonesia
    expect(r({ text: "kopdes launching today in town", lang: "en", tags: ["video"] })).toEqual({ match: false, reason: "language" });
    expect(r({ text: "kopdes launching", lang: "id" })).toEqual({ match: false, reason: "media_tags" });
    expect(r({ text: "kopdes #iklan", lang: "id", tags: ["video"] })).toEqual({ match: false, reason: "not_media_tags" });
    expect(r({ text: "berita lain", lang: "id", tags: ["video"] })).toEqual({ match: false, reason: "query" });
    expect(r({ text: "kopdes", lang: null, tags: ["video"] })).toEqual({ match: true }); // bahasa tak diketahui tidak dibuang diam-diam
    expect(r({ text: "kopdes", lang: "und", tags: ["VIDEO"] })).toEqual({ match: true });
  });

  test("normalizeLang & prepareItem dapat dipakai ulang lintas query", () => {
    expect([normalizeLang("in"), normalizeLang("id-ID"), normalizeLang("zsm"), normalizeLang("und"), normalizeLang(null)]).toEqual([
      "id",
      "id",
      "ms",
      null,
      null,
    ]);
    const p = prepareItem({ text: "Demo KDMP #Kopdes", lang: "in" });
    expect(["demo", "kdmp OR x", "#kopdes", "kopdes -demo"].map((qt) => matchQuery(compileQuery({ query_text: qt }), p).match)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });
});

describe("pencocokan realistis dari data live (2026-09-30)", () => {
  const kdmp = { query_text: '"koperasi merah putih" OR kopdes', languages: ["id"] as ("id" | "en" | "ms")[] };
  test("frasa cocok dengan hashtag gabungannya (#KoperasiMerahPutih), juga lewat index kandidat", () => {
    const item = {
      text: "Info baru, pembayaran kewajiban KDMP ditanggung APBN #KoperasiMerahPutih",
      hashtags: ["KoperasiMerahPutih"],
      lang: "id",
    };
    expect(m(kdmp, item)).toBe(true);
    expect(m(kdmp, { text: "rapat koperasi desa", hashtags: [], lang: "id" })).toBe(false);
    const idx = new QueryIndex([{ id: "k", query: compileQuery(kdmp) }]);
    expect(idx.match({ text: "mantap #koperasimerahputih", lang: null }).map((q) => q.id)).toEqual(["k"]);
  });
  test("teks sangat pendek: bahasa hasil deteksi tidak dipakai untuk menolak ('Kopdes' → 'da')", () => {
    expect(m(kdmp, { text: "Kopdes", lang: "da" })).toBe(true);
    expect(m(kdmp, { text: "Kopdes #fyp #viral #foryou", lang: "da" })).toBe(true); // hashtag tidak dihitung kata
    expect(m(kdmp, { text: "the kopdes story is about a village cooperative", lang: "en" })).toBe(false); // cukup panjang → filter berlaku
  });
});
