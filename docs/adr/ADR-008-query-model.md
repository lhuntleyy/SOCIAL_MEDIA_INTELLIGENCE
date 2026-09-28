# ADR-008: Model query — boolean + keyword + media tags + multi-language

- Status: Accepted
- Tanggal: 2026-09-27

## Konteks
Tab **Query Lists** produk referensi (screenshot 12) menunjukkan satu query berisi lebih dari sekadar ekspresi boolean: ada **Language** per query (English/Indonesia/**Malaysia**), **Keyword** terpisah, dan **Media Tags / Not Media Tags**, dengan tombol **Add New Query**. ADR-006 hanya menetapkan AST boolean + local matcher.

## Keputusan
Perluas `topic_queries` (DATA_MODEL §3.5) dengan `keywords text[]`, `media_tags text[]`, `not_media_tags text[]`, `languages text[]` (`id`/`en`/`ms`). Semantik (CONNECTOR_SPEC §5):
- `keywords` → di-OR-kan ke AST sebagai node `term` sebelum kompilasi (recall).
- `languages` → local matcher menolak item yang `lang`-nya di luar daftar (kosong = semua).
- `media_tags`/`not_media_tags` → local matcher: wajib mengandung ≥1 `media_tags` (bila diisi) dan tidak mengandung `not_media_tags`.
- Sumber kebenaran presisi tetap **local matcher** (konsisten ADR-006).

## Catatan verifikasi
Makna persis "Media Tags"/"Not Media Tags" di produk belum 100% pasti (tag/label konten vs tipe media). Interpretasi awal = tag/label konten pada item; **wajib diverifikasi** ke produk saat implementasi dan ADR ini diperbarui bila berbeda.

## Konsekuensi
- Compiler & local matcher menangani keyword + filter media + bahasa.
- `ms` (Malaysia) ditambahkan ke language handling AI (AI_SPEC §3); model `id` sering cukup untuk `ms` tetapi dievaluasi terpisah.
- Cost estimate (FR-T05) memperhitungkan sub-query dari keyword tambahan.

## Semantik final (I-01, 2026-09-28) — `packages/query`
- **Operator hanya HURUF BESAR** (`OR`, `AND`, `NOT`); `and/or/not` huruf kecil = kata biasa. Kata berdampingan = **AND implisit**. `-kata`, `-"frasa"`, `-(grup)` = NOT. Presedensi NOT > AND > OR. `NOT NOT x = x`.
- **Normalisasi** query & item identik: NFKC → hapus zero-width → lowercase → hapus diakritik. Term = token utuh (bukan substring: `demo` tidak cocok `demokrasi`). Kata dengan pemisah (`covid-19`) = frasa `covid 19`. Frasa = token berurutan kontigu.
- **Hashtag**: `kopdes` cocok token teks ATAU hashtag `#kopdes`; `#kopdes` hanya cocok hashtag (dari teks atau metadata provider). Underscore di hashtag diabaikan.
- **Keywords** di-OR-kan ke **inti positif** (bukan root) → `NOT` tetap berlaku untuk keyword.
- **languages**: kode provider dinormalisasi (`in`→`id`, `zsm`/`msa`→`ms`, `und`/`zxx`→ tak diketahui). Item berbahasa **tak diketahui lolos** filter bahasa (tidak dibuang diam-diam; dashboard menampilkan "tidak diketahui").
- **media_tags / not_media_tags**: dicocokkan ke himpunan tag item = hashtag + `tags` dari pipeline (mis. tipe media). Interpretasi ini masih menunggu konfirmasi produk (bagian "Catatan verifikasi" di atas) — mengubahnya cukup di `prepareItem`.
- **Validasi**: panjang ≤ 2000, kedalaman kurung ≤ 10, ≤ 200 elemen, ≤ 50 keyword; wajib ≥ 1 term/frasa positif (query murni NOT ditolak). Error menyertakan posisi karakter.
- `ast_hash` = SHA-256 AST kanonis (anak AND/OR diurutkan & dideduplikasi) + filter → query setara makna berbagi hash (dedup planner ADR-009).
