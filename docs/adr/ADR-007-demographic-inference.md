# ADR-007: Inferensi demografi (gender & age range) — agregat dengan kontrol

- Status: Accepted
- Tanggal: 2026-09-27

## Konteks
Produk referensi ("ISA") menampilkan section **Psychography**: Sentiment by Gender (Male/Female) dan Sentiment by Age Range (Below 18 … Above 55) — screenshot 9–10. Pengguna platform adalah organisasi analis. Draft PRD awal menaruh ini sebagai Non-Goal karena sensitivitas (UU PDP No. 27/2022). Keputusan produk: fitur **masuk scope inti, aktif default**, tetapi harus diimplementasikan secara defensible — bukan tebakan mentah.

## Keputusan
- Inferensi **gender** (male/female/unknown) dan **age_range** (7 bucket + unknown) **per akun**, di-cache lintas tenant (`author_demographics`), didenormalisasi ke `topic_match_events` untuk agregat (`agg_psycho_gender_1d`, `agg_psycho_age_1d`).
- **Kontrol wajib:**
  1. Hanya ditampilkan **agregat**; tidak pernah sebagai label individu di feed/post.
  2. Prioritas sumber: data self-declared/platform > inferensi; confidence < τ → `unknown` (tidak menebak).
  3. Setiap widget menampilkan `coverage_pct` + bucket `unknown` (tidak disembunyikan).
  4. Metode & model **versioned** (`model_versions.task in (gender, age_range)`), eval mencakup precision + coverage + cek disparitas antar grup (bias).
  5. Diperlakukan sebagai data pribadi (UU PDP): dasar pemrosesan terdokumentasi, retensi mengikuti post global (DATA_MODEL §9), perubahan model masuk audit, review DPO sebelum go-live.
  6. Feature flag per tenant untuk mematikan.
- **Batas keras:** tidak ada inferensi atribut sensitif lain (agama, etnis, orientasi politik/seksual, kesehatan).
- **Data anak (tambahan v0.4, 2026-09-28):** label `below_18` **tidak disimpan per akun** (menandai individu sebagai anak = memproses data anak menurut UU PDP). Default bucket digabung ke `unknown`; bucket agregat `below_18` hanya bila memo DPO (S-23) mengizinkan, dan hanya melalui nilai yang tidak di-cache per akun.
- **Demography filter di UI** hanya memengaruhi widget agregat — tidak pernah feed/daftar akun/export.

## Alternatif ditolak
- **Tidak mengimplementasikan** (Non-Goal awal): tidak parity dengan produk referensi; ditolak oleh keputusan produk.
- **Inferensi tanpa kontrol** (label individu, tanpa coverage): risiko hukum/etika tinggi, kualitas menyesatkan; ditolak.

## Konsekuensi
- Menambah pipeline AI (worker-ai), cache per akun, tabel & agregat baru, halaman UI Psychography.
- Risiko akurasi/bias nyata → mitigasi via eval, coverage transparan, τ, dan review DPO.
- Kewajiban hukum bertambah (UU PDP) — didokumentasikan di SECURITY §9 & AI_SPEC §12.
