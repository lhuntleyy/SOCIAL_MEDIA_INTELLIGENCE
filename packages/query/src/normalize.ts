// Normalisasi teks untuk pencocokan (CONNECTOR_SPEC §5.4): NFKC, lowercase, hapus diakritik & zero-width.
// Query dan item WAJIB melewati fungsi yang sama agar semantik identik apa pun provider-nya (ADR-006).
const ZERO_WIDTH = /[​-‍⁠﻿]/g;
const MARKS = /\p{M}+/gu;
const SPLIT = /[^\p{L}\p{N}]+/u;
const HASHTAG = /#([\p{L}\p{N}_]+)/gu;

export function normalizeText(s: string): string {
  return s.normalize("NFKC").replace(ZERO_WIDTH, "").toLowerCase().normalize("NFD").replace(MARKS, "").normalize("NFC");
}

export function tokenize(s: string): string[] {
  return normalizeText(s).split(SPLIT).filter(Boolean);
}

/** Hashtag dari teks (tanpa '#', ternormalisasi). */
export function hashtagsIn(s: string): string[] {
  return [...normalizeText(s).matchAll(HASHTAG)].map((m) => m[1]!.replace(/_/g, ""));
}

export function normalizeTag(tag: string): string {
  return normalizeText(tag.replace(/^#/, "")).replace(/[^\p{L}\p{N}]/gu, "");
}
