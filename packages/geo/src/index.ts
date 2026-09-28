// I-14 gazetteer deterministik (AI_SPEC §10, ADR-010). Murni: dibangun dari baris geo_regions (dimuat worker).
export interface GeoRegion {
  code: string;
  name: string;
  aliases: string[];
}
export interface GeoHit {
  code: string;
  confidence: number;
  source: "place" | "profile" | "profile_fuzzy";
}

/** huruf kecil, tanpa diakritik & tanda baca, spasi tunggal. */
export function normalizePlace(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export class Gazetteer {
  private readonly exact = new Map<string, Set<string>>();
  private readonly aliases: { alias: string; code: string }[] = [];

  constructor(regions: GeoRegion[]) {
    for (const r of regions) {
      for (const a of new Set([r.name, ...r.aliases].map(normalizePlace).filter(Boolean))) {
        if (!this.exact.has(a)) this.exact.set(a, new Set());
        this.exact.get(a)!.add(r.code);
        this.aliases.push({ alias: a, code: r.code });
      }
    }
    this.aliases.sort((x, y) => y.alias.length - x.alias.length);
  }

  private exactCode(s: string): string | null {
    const codes = this.exact.get(normalizePlace(s));
    return codes && codes.size === 1 ? [...codes][0]! : null;
  }

  /** Alias terpanjang yang muncul sebagai kata utuh; ambigu (panjang sama, kode beda) → null. */
  private containedCode(s: string): string | null {
    const hay = ` ${normalizePlace(s)} `;
    const hits = this.aliases.filter((a) => hay.includes(` ${a.alias} `));
    if (!hits.length) return null;
    const best = hits[0]!.alias.length;
    const codes = new Set(hits.filter((h) => h.alias.length === best).map((h) => h.code));
    return codes.size === 1 ? [...codes][0]! : null;
  }

  infer(i: { placeName?: string | null; locationRaw?: string | null }): GeoHit | null {
    if (i.placeName) {
      const c = this.exactCode(i.placeName) ?? this.containedCode(i.placeName);
      if (c) return { code: c, confidence: 0.8, source: "place" };
    }
    if (i.locationRaw) {
      const c = this.exactCode(i.locationRaw);
      if (c) return { code: c, confidence: 0.5, source: "profile" };
      const f = this.containedCode(i.locationRaw);
      if (f) return { code: f, confidence: 0.3, source: "profile_fuzzy" };
    }
    return null;
  }
}
