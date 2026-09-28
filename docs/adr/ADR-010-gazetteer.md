# ADR-010 — Gazetteer geo v1 (provinsi)

**Status:** Diterima (2026-09-28) · daftar 38 provinsi **dikonfirmasi pemilik (2026-09-29)** · **Terkait:** AI_SPEC §10, DATA_MODEL §5.9, I-14

## Konteks
Widget sebaran wilayah butuh `geo_region_code` per post. DATA_MODEL §5.9 mensyaratkan sumber & lisensi gazetteer dicatat sebelum dipakai.

## Keputusan
1. **Level v1 = 38 provinsi** (migrasi `0015_geo_provinces`), kode 2 digit mengikuti kode wilayah Kemendagri, termasuk 4 provinsi pemekaran Papua 2022 (91 Papua, 92 Papua Barat, 93 Papua Selatan, 94 Papua Tengah, 95 Papua Pegunungan, 96 Papua Barat Daya).
2. **Sumber:** kode & nama wilayah administrasi adalah data publik pemerintah (fakta, bukan karya berhak cipta). Daftar & jumlah (38 provinsi) dikonfirmasi pemilik 2026-09-29; bila Kemendagri mengubah kode/pemekaran, perbarui lewat migrasi baru.
3. **Alias** (nama, singkatan umum, ibu kota & kota besar) disusun tim — dapat ditambah operator langsung di tabel `geo_regions.aliases` tanpa deploy.
4. **Tanpa poligon** di v1: geotag lat/lng belum dipetakan (butuh GeoJSON batas provinsi berlisensi jelas) → langkah 1 AI_SPEC §10 dilewati, lanjut ke `place_name` / `location_raw`.
5. **Tidak menebak dari isi teks** (AI_SPEC §10 langkah 4) dan alias ambigu (dua provinsi sama-sama cocok dengan panjang sama) → `null`.

## Konsekuensi
- Confidence: `place_name` persis alias 0,8; `location_raw` persis alias 0,5; alias terkandung (kata utuh, alias terpanjang) 0,3.
- Level kabupaten/kota (regency) & poligon = pekerjaan lanjutan (butuh sumber data berlisensi → ADR baru).
