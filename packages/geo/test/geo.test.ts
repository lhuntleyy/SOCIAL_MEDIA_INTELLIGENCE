import { describe, expect, test } from "bun:test";
import { Gazetteer, normalizePlace } from "../src";

const g = new Gazetteer([
  { code: "31", name: "DKI Jakarta", aliases: ["jakarta", "jaksel"] },
  { code: "32", name: "Jawa Barat", aliases: ["jabar", "bandung"] },
  { code: "91", name: "Papua", aliases: ["jayapura"] },
  { code: "92", name: "Papua Barat", aliases: ["manokwari"] },
  { code: "71", name: "Sulawesi Utara", aliases: ["manado", "kota x"] },
  { code: "72", name: "Sulawesi Tengah", aliases: ["kota x"] },
]);

describe("gazetteer (AI_SPEC §10, ADR-010)", () => {
  test("normalisasi: huruf kecil, diakritik & tanda baca dibuang", () => {
    expect(normalizePlace("  Bandung, JAWA-Barát!! ")).toBe("bandung jawa barat");
  });
  test("place_name 0,8 > profil persis 0,5 > profil terkandung 0,3; tanpa data → null", () => {
    expect(g.infer({ placeName: "Jakarta", locationRaw: "Bandung" })).toEqual({ code: "31", confidence: 0.8, source: "place" });
    expect(g.infer({ locationRaw: "JABAR" })).toEqual({ code: "32", confidence: 0.5, source: "profile" });
    expect(g.infer({ locationRaw: "Tinggal di Bandung sejak 2010 🇮🇩" })).toEqual({ code: "32", confidence: 0.3, source: "profile_fuzzy" });
    expect(g.infer({ locationRaw: "planet bumi" })).toBeNull();
    expect(g.infer({})).toBeNull();
  });
  test("alias terpanjang menang (Papua Barat bukan Papua); kata utuh saja; ambigu → null", () => {
    expect(g.infer({ locationRaw: "Kab. Papua Barat" })?.code).toBe("92");
    expect(g.infer({ locationRaw: "bandungan" })).toBeNull(); // bukan kata utuh "bandung"
    expect(g.infer({ locationRaw: "kota x" })).toBeNull(); // alias milik dua provinsi
  });
});
