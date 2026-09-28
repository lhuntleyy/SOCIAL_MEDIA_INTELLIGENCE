# TASK — Fase 1 (Core MVP)

Turunan dari [PRD.md](PRD.md). Log pengerjaan: [PROGRESS.md](PROGRESS.md).

## Cara pakai

- Setiap task punya ID `T-xxx`, kolom **FR** yang menunjuk requirement asalnya, dan **Depends** yang menunjuk task prasyarat.
- Kalau acceptance criteria ternyata salah atau tidak realistis waktu dikerjakan, ubah di sini dan catat alasannya di entri PROGRESS.

### Arti penanda

| Penanda | Arti |
|---|---|
| `[ ]` | Belum dikerjakan |
| `[~]` | Kode selesai, tapi **ada acceptance criteria yang belum bisa diverifikasi** karena kendala lingkungan. Alasannya wajib ditulis di [PROGRESS.md](PROGRESS.md). |
| `[x]` | Semua acceptance criteria terpenuhi **dan terverifikasi** — bukan sekadar "kodenya udah ditulis" |

Setiap task `[x]` atau `[~]` **wajib** punya entri di [PROGRESS.md](PROGRESS.md). Task tanpa entri progress dianggap belum selesai.

`[~]` ada supaya kemajuan nyata tidak hilang dari catatan, tanpa mengklaim sesuatu sudah terbukti padahal belum. **Jangan menaikkan `[~]` jadi `[x]` sampai verifikasi yang kurang benar-benar dijalankan.**

## Status

| Fase | Total | Selesai `[x]` | Menunggu verifikasi `[~]` | Progres |
|---|---:|---:|---:|---|
| Fase 1 | 75 | 43 | 27 | ▓▓▓▓▓▓▓▓▓░ 93% |

**Blocker terbuka.** Ada tiga sebab berbeda kenapa sebuah task berhenti di `[~]`, dan ketiganya lepas dengan cara yang berbeda pula:

| Sebab | Task | Lepas ketika |
|---|---|---|
| Docker belum terpasang di mesin development — kode jadi, tapi belum pernah dijalankan terhadap Postgres dan OpenSearch sungguhan | T-002, T-003, T-004, T-023, T-025, T-026, T-027, T-032 | Job `integration` di CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) pertama hijau |
| Butuh panggilan provider/API berbayar untuk mengukur throughput dan biaya nyata | T-010, T-012 s/d T-018, T-021, T-022, T-031, T-037, T-068 | Kunci API terpasang dan smoke test berbayar dijalankan |
| Butuh klaster berisi data untuk mengukur latensi | T-039, T-047 | OpenSearch jalan dengan korpus uji berukuran nyata |
| Butuh gold set 1.000 post berlabel manusia | T-029, T-033, T-038 | Pelabelan selesai (pekerjaan manusia, bukan kode) |
| Butuh fitur lain yang belum ada | T-049 (auth T-064, daftar topic T-058) | Task prasyaratnya selesai |

**Utang teknis tercatat:** `pyjwt` ada di `pyproject.toml` tapi tidak dipakai — sesi memakai token opaque di Redis (T-064). Dibiarkan karena kemungkinan dibutuhkan untuk token antar-service, tapi dependensi yang tidak dipakai adalah permukaan serangan yang tidak dibayar apa pun; kalau T-074 lewat tanpa pemakainya, buang.

**Utang teknis tercatat:** keluaran panel di sisi Python adalah `dict[str, Any]`, bukan model Pydantic, jadi `make schema` tidak bisa menurunkan tipe TS-nya. Tipe respons panel di `apps/web/lib/api/analytics.ts` ditulis tangan dan bisa melenceng tanpa ada yang menggagalkan build. Menjadikannya model Pydantic akan menutup celah itu untuk ketiga belas panel sekaligus.

**Total effort:** 92,5 hari kerja

**Critical path:** 17,5 hari — T-000 → T-001 → T-005 → T-011 → T-012 → T-021 → T-022 → T-025 → T-039 → T-045 → T-046 → T-056

Selisih antara 92,5 dan 17,5 adalah pekerjaan yang bisa diparalelkan. Perkiraan durasi kalender:

| Ukuran tim | Perkiraan |
|---|---|
| 1 orang | ~92 hari (berurutan) |
| 2 orang | ~50 hari |
| 3 orang | ~35 hari |
| Batas teoretis | 17,5 hari (critical path) |

Menambah orang di atas 3 tidak banyak menolong — critical path melewati satu rantai adapter, normalizer, routing, lalu API sentiment yang sulit dipecah.

**Sekarang di:** E9 berjalan. T-069 selesai — cap per topic dan global, alert di 80%, throttle di 100% yang melambatkan tanpa menghentikan, plus override admin yang tercatat di audit. Berikutnya T-070 (dashboard biaya), yang menampilkan angka sebenarnya berdampingan dengan estimasi COST-MODEL.md supaya selisihnya terlihat sejak dini.

---

## E1 — Fondasi & Infrastruktur

Blok pertama yang harus jadi. Semua epic lain bergantung ke sini.

- [x] **T-000 · Paket dokumentasi (PRD, TASK, PROGRESS, docs)**
  FR: — · Depends: — · Est: 1d
  Acceptance: PRD lengkap dengan FR yang bisa diuji; TASK terpetakan ke FR; PROGRESS punya format yang jelas; arsitektur, data source, cost model, dan roadmap terdokumentasi.

- [x] **T-001 · Inisialisasi monorepo & struktur folder**
  FR: — · Depends: T-000 · Est: 0,5d
  Struktur: `apps/web` (Next.js), `services/api` (FastAPI), `services/worker` (Celery), `packages/schema` (schema bersama), `infra/`.
  Acceptance: `git init` jalan; workspace terpasang; lint dan format tersetup di ketiga bahasa; README menjelaskan tiap folder.

- [~] **T-002 · docker-compose untuk development**
  FR: — · Depends: T-001 · Est: 1d
  Service: PostgreSQL 16, OpenSearch 2.18+, Redis 7, MinIO (S3-compatible).
  Acceptance: `docker compose up` menyalakan semuanya; healthcheck lolos; volume data persist antar restart; port terdokumentasi dan tidak bentrok.
  ⚠ `[~]` Docker belum terpasang di mesin dev — compose file belum pernah dijalankan. Job `integration` di CI yang akan membuktikannya.

- [~] **T-003 · Skema PostgreSQL & migrasi awal**
  FR: — · Depends: T-002 · Est: 1d
  Semua tabel dari PRD bagian 8.2.
  Acceptance: migrasi Alembic jalan maju dan mundur bersih; foreign key dan index terpasang; seed data untuk development tersedia.
  ⚠ `[~]` Model dan migrasi jadi, DDL terkompilasi benar, tapi `alembic upgrade/downgrade` belum pernah dijalankan terhadap Postgres sungguhan.

- [~] **T-004 · OpenSearch index template & analyzer Bahasa Indonesia**
  FR: FR-205, FR-306 · Depends: T-002 · Est: 1,5d
  Custom analyzer: stemmer Indonesia, stopword, normalisasi bahasa gaul, lowercase, penanganan hashtag.
  Acceptance: analyzer men-stem "penanganan" ke "tangan"; "gk"/"ga"/"nggak" ternormalisasi jadi satu token; `_analyze` API mengembalikan hasil yang diharapkan pada 20 kalimat uji.
  ⚠ `[~]` Analyzer dan template jadi serta ter-unit-test, tapi belum pernah dipasang ke OpenSearch hidup — jadi klaim "stem `penanganan` jadi `tangan`" belum terbukti lewat API `_analyze`.

- [x] **T-005 · Unified Post schema (satu sumber kebenaran)**
  FR: FR-205 · Depends: T-001 · Est: 1d
  Model Pydantic di Python, tipe TypeScript hasil generate — bukan definisi kembar yang bisa melenceng.
  Acceptance: model Python jadi sumber; tipe TS ter-generate otomatis; CI gagal kalau tipe generated tidak sinkron dengan model.

- [x] **T-006 · Konfigurasi & manajemen secret**
  FR: — · Depends: T-001 · Est: 0,5d
  Acceptance: semua secret dari environment variable; `.env.example` lengkap; aplikasi gagal saat startup dengan pesan jelas kalau ada config wajib yang hilang; tidak ada secret ter-commit.

- [x] **T-007 · Skeleton FastAPI & healthcheck**
  FR: FR-703 · Depends: T-003, T-006 · Est: 0,5d
  Acceptance: `/health` melaporkan status Postgres, OpenSearch, dan Redis; OpenAPI docs tergenerate; CORS terkonfigurasi.

- [x] **T-008 · Celery, Redis, & Beat scheduler**
  FR: — · Depends: T-002, T-006 · Est: 1d
  Antrean terpisah: `collect`, `enrich`, `aggregate` — supaya backlog NLP tidak memblokir ingestion.
  Acceptance: task terdistribusi ke antrean yang benar; retry dengan exponential backoff; dead letter queue jalan; Beat menjadwalkan task periodik.

- [x] **T-009 · Skeleton Next.js 15 & design system**
  FR: — · Depends: T-001 · Est: 1d
  App Router, TypeScript, Tailwind, komponen dasar.
  Acceptance: build lolos; dark/light mode jalan; token warna terdefinisi; layout responsif.

- [~] **T-010 · CI pipeline**
  FR: — · Depends: T-005, T-009 · Est: 0,5d
  Acceptance: PR menjalankan lint, typecheck, dan test untuk ketiga bahasa; gagal memblokir merge; waktu jalan di bawah 5 menit.
  ⚠ `[~]` Workflow ditulis dan semua perintah di dalamnya lolos secara lokal, tapi belum pernah dieksekusi GitHub Actions (repo belum punya remote).

---

## E2 — Ingestion & Adapter

Di sinilah biaya terjadi. Tiap adapter wajib inkremental (FR-204) — ini bukan optimasi, ini syarat.

- [x] **T-011 · Interface SourceAdapter & registry**
  FR: FR-201 · Depends: T-005 · Est: 1d
  Kontrak ABC: `fetch(stream, cursor) -> (posts, next_cursor, cost)`. Detail: [DATA-SOURCES.md](docs/DATA-SOURCES.md).
  Acceptance: adapter tiruan lolos test kontrak; registry menemukan adapter berdasarkan enum platform; tiap fetch mengembalikan biaya sebagai bagian dari kontrak, bukan tempelan.

- [~] **T-012 · Adapter twitterapi.io (X/Twitter)**
  FR: FR-201, FR-204 · Depends: T-011 · Est: 1,5d
  Acceptance: fetch inkremental pakai `since_id`; rate limit dan backoff ter-handle; paginasi jalan; output lolos validasi unified schema; test pakai fixture terekam; run kedua pada stream tak berubah menghasilkan nol hasil berbayar.
  ⚠ `[~]` Semua acceptance lolos terhadap fixture, TAPI fixture-nya disusun dari dokumentasi provider, bukan direkam dari API sungguhan (butuh API key berbayar). Bentuk endpoint dan nama field belum terbukti. Kalau ternyata berbeda, yang perlu diubah hanya konstanta di kepala modul dan `_parse_response`.

- [~] **T-013 · Klien dasar Apify**
  FR: FR-201, FR-701 · Depends: T-011 · Est: 1,5d
  Start run, poll status, ambil dataset dengan paginasi, hitung biaya, tangani timeout dan run gagal.
  Acceptance: run yang gagal terdeteksi dan di-retry; biaya tercatat per run; `maxItems` diberlakukan supaya tidak ada run yang lepas kendali.
  ⚠ `[~]` Semua acceptance lolos terhadap HTTP tiruan, tapi belum pernah menjalankan actor Apify sungguhan (butuh akun berbayar). Bentuk respons `/v2/acts/.../runs` dan `/v2/datasets/.../items` belum terbukti.

- [~] **T-014 · Adapter Instagram (Apify)**
  FR: FR-201, FR-204 · Depends: T-013 · Est: 1d
  Acceptance: post dan komentar ter-fetch; dedup berbasis cursor; output lolos validasi schema; biaya per hasil sesuai perkiraan (±10%).
  ⚠ `[~]` Actor id dan skema input belum diverifikasi terhadap akun Apify sungguhan. **Batasan platform:** Instagram tidak punya pencarian teks bebas — keyword diterjemahkan jadi hashtag, jadi post tanpa hashtag tidak terkumpul. Lihat [DATA-SOURCES.md](docs/DATA-SOURCES.md#kemampuan-pencarian-per-platform).

- [~] **T-015 · Adapter TikTok (Apify)**
  FR: FR-201, FR-204 · Depends: T-013 · Est: 1d
  Acceptance: sama seperti T-014; metrik view terpetakan dengan benar (TikTok satu-satunya sumber view yang signifikan).
  ⚠ `[~]` Actor id dan skema input belum diverifikasi terhadap akun Apify sungguhan. Pemetaan metrik `view` sendiri dikerjakan normalizer (T-021) — adapter hanya menjaga payload mentahnya utuh.

- [~] **T-016 · Adapter Facebook (Apify)**
  FR: FR-201, FR-204 · Depends: T-013 · Est: 1d
  Acceptance: sama seperti T-014; hanya post publik.
  ⚠ `[~]` Actor id dan skema input belum diverifikasi terhadap akun Apify sungguhan. **Batasan platform berat:** Facebook tidak punya pencarian keyword publik. Adapter bekerja per-Page dan melewati stream tanpa Page dengan biaya nol. Perlu perluasan FR-103 (UI pendaftaran Page) kalau Facebook mau jadi sumber serius.

- [~] **T-017 · Adapter Threads (Apify)**
  FR: FR-201, FR-204 · Depends: T-013 · Est: 1d
  Acceptance: sama seperti T-014.
  ⚠ `[~]` Actor id dan skema input belum diverifikasi terhadap akun Apify sungguhan.

- [~] **T-018 · Adapter YouTube Data API v3**
  FR: FR-201, FR-204 · Depends: T-011 · Est: 1d
  Acceptance: pemakaian quota terlacak dan tidak melebihi batas harian; komentar video ter-fetch; kehabisan quota menurunkan interval, bukan bikin crash.
  ⚠ `[~]` Pelacakan quota, pengambilan komentar, dan perilaku saat quota habis semuanya terverifikasi lewat HTTP tiruan. Yang belum: dipanggil ke YouTube Data API sungguhan (butuh API key). **Batas keras yang perlu diingat waktu menyetel interval:** 10.000 unit/hari dibagi 100 unit per pencarian = 100 pencarian/hari untuk SELURUH platform — 1 stream @15 menit sudah menghabiskan 96 di antaranya.

- [x] **T-019 · Model Collection Stream & dedup planner**
  FR: FR-202 · Depends: T-003, T-011 · Est: 2d
  Menerima query semua topic aktif, mengekstrak keyword, menggabungkan yang tumpang tindih jadi stream minimal, memetakan stream ke topic.
  Acceptance: dua topic dengan keyword identik menghasilkan tepat satu stream; menambah topic yang keyword-nya sudah ada tidak membuat stream baru; planner punya unit test dengan kasus tumpang tindih yang rumit.
  **Menghemat 1,35x pada 30 topic, naik jadi 2,45x pada 108 topic.** Penghematannya tumbuh seiring jumlah topic — makanya T-012 dan T-022 (fetch inkremental, 12,7x, berlaku sejak topic pertama) didahulukan. Lihat [COST-MODEL.md bagian 5](docs/COST-MODEL.md).

- [x] **T-020 · Adaptive polling scheduler**
  FR: FR-203, FR-402 · Depends: T-008, T-019 · Est: 1,5d
  Acceptance: stream nol hasil 6 siklus berturut-turut melambat satu tingkat; stream yang menyentuh limit halaman mempercepat; tidak pernah melampaui interval maksimum pilihan user; keputusan penyesuaian tercatat di log.

- [~] **T-021 · Normalizer: payload mentah ke unified Post**
  FR: FR-205 · Depends: T-005, T-012 · Est: 2d
  Acceptance: keenam platform ternormalisasi ke satu schema; field yang tidak tersedia bernilai `null` bukan `0`; payload mentah tersimpan di object storage dengan pointer yang bisa dipakai; test golden file per platform.
  ⚠ `[~]` Keenam platform ternormalisasi dan aturan None-bukan-nol teruji. Penyimpanan payload mentah diimplementasi dengan store yang bisa disuntikkan, tapi belum pernah dijalankan terhadap MinIO/S3 sungguhan. Fixture memakai payload yang disusun dari dokumentasi, bukan direkam dari API.

- [~] **T-022 · Dedup & upsert idempoten**
  FR: FR-204 · Depends: T-021, T-004 · Est: 1d
  Acceptance: unique key `(platform, platform_post_id)`; menjalankan ingest yang sama dua kali tidak mengubah jumlah dokumen; metrik yang terupdate (like bertambah) ter-refresh tanpa menggandakan baris.
  ⚠ `[~]` Bentuk aksi bulk, kunci dedup, dan pelestarian hasil NLP teruji lewat klien tiruan. Klaim "jumlah dokumen tidak berubah setelah ingest kedua" butuh OpenSearch hidup — dibuktikan job `integration` di CI.

---

## E3 — Storage & Percolator

- [~] **T-023 · Percolator index & registrasi query**
  FR: FR-206 · Depends: T-004 · Est: 1,5d
  Acceptance: query topic terdaftar sebagai dokumen percolator; menambah dan menghapus topic memperbarui index; 100 query terdaftar tanpa penurunan kinerja.
  ⚠ `[~]` Pendaftaran, pencabutan, dan sinkronisasi query teruji lewat klien tiruan. Klaim "100 query terdaftar tanpa penurunan kinerja" butuh OpenSearch hidup.

- [x] **T-024 · Validator & translator boolean query**
  FR: FR-102 · Depends: T-023 · Est: 2d
  Sintaks UI → AST → `bool` query DSL OpenSearch. Menangani `AND`, `OR`, `NOT`, kutip, kurung.
  *Diubah saat dikerjakan:* rencana awal merangkai `query_string`. Diganti membangun `bool` query dari AST — menghapus permukaan injeksi dan ambiguitas operator implisit sekaligus. Alasan lengkap di [PROGRESS.md](PROGRESS.md).
  Acceptance: query referensi `"AMPB" OR "BOTOK" OR "REKENING" AND "MANDIRI"` ter-parse dan cocok dengan benar; query tidak valid mengembalikan posisi kesalahan; presedensi operator terdokumentasi dan teruji; injeksi lewat query string tidak mungkin.

- [~] **T-025 · Service topic routing (percolate batch)**
  FR: FR-206 · Depends: T-023, T-022 · Est: 1,5d
  Acceptance: post di-percolate secara batch, bukan satu per satu; latensi <50 ms per post pada 100 topic; `matched_topics` terisi benar; post yang tidak cocok topic apa pun tetap disimpan (bisa dipakai backfill nanti).
  ⚠ `[~]` Percolate batch, pemetaan hasil balik ke post, dan penyaringan query aktif teruji. Klaim latensi <50 ms per post pada 100 topic butuh OpenSearch hidup.

- [~] **T-026 · Backfill untuk topic baru**
  FR: FR-109 · Depends: T-025 · Est: 1d
  Acceptance: topic baru cocok dengan data historis dalam 10 menit; nol panggilan provider selama backfill; progres terlihat di UI.
  ⚠ `[~]` Script idempoten, throttle, penanganan bentrok versi, dan pemantauan progres teruji lewat klien tiruan. Klaim "topic baru cocok dengan data historis dalam 10 menit" butuh OpenSearch hidup berisi data.

- [~] **T-027 · Kebijakan retensi & lifecycle**
  FR: FR-208 · Depends: T-004 · Est: 1d
  Acceptance: kebijakan ISM menghapus post mentah setelah 12 bulan; agregat tetap utuh; kebijakan bisa diubah tanpa reindex.
  ⚠ `[~]` Kebijakan ISM dan perencanaan pembersihan teruji sebagai fungsi murni. Klaim "kebijakan berjalan otomatis" butuh OpenSearch hidup — ISM baru mengevaluasi kebijakan pada siklusnya sendiri.

- [x] **T-028 · Geo enrichment (lokasi ke provinsi)**
  FR: FR-207 · Depends: T-021 · Est: 1,5d
  Kamus lokasi Indonesia plus fuzzy matching.
  Acceptance: "Jkt", "Jakarta Selatan", "DKI", "jaksel" semuanya ter-resolve ke DKI Jakarta; tingkat unresolved terukur dan ter-log; 38 provinsi tercakup.
  *Dikoreksi saat dikerjakan:* semula tertulis 34. Indonesia punya **38 provinsi** sejak pemekaran Papua 2022 (Papua Selatan, Papua Tengah, Papua Pegunungan, Papua Barat Daya).

---

## E4 — NLP Pipeline

- [~] **T-029 · Preprocessing Bahasa Indonesia**
  FR: FR-306 · Depends: T-021 · Est: 2d
  Normalisasi bahasa gaul, cleaning, stemming (Sastrawi), deteksi bahasa.
  Acceptance: kamus bahasa gaul mencakup minimal 500 bentuk umum; deteksi bahasa akurat di atas 95% pada sampel berlabel; teks asli tetap disimpan berdampingan dengan versi ternormalisasi.
  *Menunggu verifikasi:* akurasi deteksi bahasa >95% butuh sampel berlabel yang belum ada — datang bersama gold set T-038.

- [x] **T-030 · Interface NLP provider**
  FR: FR-301 · Depends: T-005 · Est: 1d
  Abstraksi supaya LLM dan model lokal bisa ditukar tanpa mengubah pemanggil — inilah yang bikin switchover Fase 4 jadi perubahan konfigurasi, bukan penulisan ulang.
  Acceptance: provider tiruan lolos test kontrak; ganti provider hanya lewat config; versi model tercatat di tiap hasil.

- [~] **T-031 · Klasifier sentimen via Claude**
  FR: FR-301, FR-302 · Depends: T-030, T-029 · Est: 2d
  Batching 25 post per call, prompt caching untuk system prompt, structured output.
  Acceptance: throughput minimal 1.000 post per menit; biaya maksimal $0,25 per 1.000 post terukur; confidence dikembalikan tiap post; kegagalan parsial tidak menggagalkan seluruh batch.
  *Menunggu verifikasi:* throughput dan biaya per 1.000 post hanya terukur dengan memanggil API sungguhan.

- [~] **T-032 · Label store & versioning model**
  FR: FR-303 · Depends: T-031, T-003 · Est: 1d
  Acceptance: tiap inference tertulis ke `nlp_labels`; ekspor menghasilkan dataset training valid; versi model bisa ditelusuri; tabel ter-index untuk ekspor efisien pada jutaan baris.
  *Menunggu verifikasi:* efisiensi index pada jutaan baris butuh Postgres sungguhan (blocker Docker yang sama dengan T-003).

- [~] **T-033 · Confidence scoring & routing low-confidence**
  FR: FR-302 · Depends: T-031 · Est: 1d
  Acceptance: ambang bisa dikonfigurasi; item low-confidence masuk antrean review; kalibrasi confidence terverifikasi pada gold set.
  *Menunggu verifikasi:* kalibrasi confidence butuh gold set T-038.

- [x] **T-034 · Ekstraksi isu (n-gram plus TF-IDF)**
  FR: FR-304 · Depends: T-029 · Est: 2d
  Acceptance: menghasilkan frasa bermakna seperti contoh referensi, bukan token tunggal; stopword tersaring; frasa berbobot TF-IDF terhadap korpus; hasil stabil antar run.

- [x] **T-035 · Ekstraksi hashtag & entity**
  FR: FR-305 · Depends: T-029 · Est: 1,5d
  Acceptance: hashtag ternormalisasi case-insensitive; mention terekstrak; named entity (orang, organisasi, lokasi) teridentifikasi; presisi terukur pada sampel.
  *Terukur:* presisi 1,00 / recall 0,86 pada sampel uji yang tidak dipakai menyetel aturan.

- [x] **T-036 · Bobot engagement**
  FR: FR-405, FR-504 · Depends: T-021 · Est: 0,5d
  Acceptance: formula terdokumentasi dan bisa dikonfigurasi; menangani metrik `null` tanpa bias (post tanpa data view tidak dianggap nol view).

- [~] **T-037 · Jalur Batch API untuk backfill**
  FR: FR-301 · Depends: T-031 · Est: 1d
  Acceptance: pemrosesan historis pakai Batch API dengan diskon 50%; jalur realtime tidak terpengaruh; job batch bisa dilacak sampai selesai.
  *Menunggu verifikasi:* siklus batch sungguhan (kirim, tunggu, ambil) butuh panggilan API berbayar.

- [~] **T-038 · Gold set & harness evaluasi**
  FR: FR-307 · Depends: T-031 · Est: 2d
  Acceptance: 1.000 post berlabel manual, stratified per platform; `make eval` mengeluarkan macro-F1, confusion matrix, dan breakdown per platform; baseline tercatat di PROGRESS.
  *Menunggu verifikasi:* harness, pemuat, dan metriknya selesai. **1.000 contoh berlabelnya pekerjaan manusia, bukan kode** — baseline baru bisa dicatat setelah pelabelan.

---

## E5 — Analytics API

- [~] **T-039 · Query layer & filter global**
  FR: FR-401 · Depends: T-025 · Est: 2d
  Acceptance: satu endpoint melayani semua panel dashboard dalam satu request; filter (topic, rentang, platform) tervalidasi; SQL/DSL injection tidak mungkin; p95 di bawah 2 detik pada 1 juta post.
  *Menunggu verifikasi:* p95 pada 1 juta post butuh OpenSearch sungguhan berisi data. Query melebihi 2 detik sudah dicatat sebagai warning supaya pelanggarannya terlihat, bukan diam.

- [x] **T-040 · Endpoint Exposure timeline**
  FR: FR-403 · Depends: T-039 · Est: 1d
  Acceptance: mengembalikan jumlah per platform per bucket waktu; ukuran bucket menyesuaikan rentang (jam untuk satu hari, hari untuk satu bulan).
  *Dikoreksi saat dikerjakan:* bucket memakai interval **kalender** plus `time_zone` Asia/Jakarta, bukan interval tetap. Interval tetap membagi waktu dari epoch UTC, jadi "hari" berjalan 07:00–07:00 WIB.

- [x] **T-041 · Endpoint Issues & Issue engagement**
  FR: FR-404, FR-406 · Depends: T-039, T-034 · Est: 1,5d
  Acceptance: dua mode berbobot (frekuensi dan engagement) mengembalikan hasil yang jelas berbeda; jumlah item bisa dikonfigurasi.
  *Ditambahkan saat dikerjakan:* `doc_count_error_upper_bound` dan `sum_other_doc_count` ikut dikembalikan kalau bukan nol — terms agg itu perkiraan, dan jumlah yang terlihat pasti padahal perkiraan membuat dashboard berbohong.

- [x] **T-042 · Endpoint Engagements history**
  FR: FR-405 · Depends: T-039, T-036 · Est: 0,5d
  Acceptance: total engagement per bucket waktu; konsisten dengan Exposure pada rentang yang sama.

- [x] **T-043 · Endpoint Total posts & replies**
  FR: FR-407 · Depends: T-039 · Est: 0,5d
  Acceptance: dipisah per platform dan per tipe post; total cocok dengan Exposure.
  *Ditambahkan saat dikerjakan:* `missing: "unknown"` di kedua terms. Tanpa itu, post tanpa `post_type` hilang dari rincian tapi tetap terhitung di total platform — rinciannya tidak menjumlah ke totalnya dan tidak ada error yang memberi tahu.

- [x] **T-044 · Endpoint Topic location**
  FR: FR-408 · Depends: T-039, T-028 · Est: 0,5d
  Acceptance: jumlah per provinsi terurut menurun; `unknown` dilaporkan terpisah, tidak disembunyikan.

- [x] **T-045 · Endpoint Sentiment (timeline, proporsi, by engagement)**
  FR: FR-409, FR-501, FR-502, FR-504 · Depends: T-039, T-031 · Est: 1,5d
  Acceptance: ketiga tampilan konsisten satu sama lain; persentase totalnya 100%; varian berbobot engagement memakai bobot dari T-036.
  *Ditambahkan saat dikerjakan:* post yang belum diklasifikasi masuk kategori `unknown` yang terlihat dan ikut di penyebut. Tanpa itu, pie chart berjumlah 100% sambil diam-diam mewakili sebagian post saja.

- [x] **T-046 · Endpoint Sentiment feed, cloud, & akun**
  FR: FR-503, FR-505, FR-506, FR-507 · Depends: T-045, T-034, T-035 · Est: 1,5d
  Acceptance: feed ter-paginasi (cursor, bukan offset); text dan hashtag cloud per polaritas; daftar akun dengan jumlah post dan total engagement.
  *Ditambahkan saat dikerjakan:* jalur eksekusi panel dokumen (`msearch`) yang di T-039 baru disediakan tempatnya. Kursornya per kolom, bukan satu untuk seluruh feed — kolom negatif habis jauh lebih lambat daripada kolom positif.

- [~] **T-047 · Caching & pre-computed rollup**
  FR: NFR-01 · Depends: T-040 s/d T-046 · Est: 2d
  Acceptance: p95 di bawah 2 detik terpenuhi pada 1 juta post; cache ter-invalidasi saat data baru masuk; rollup terhitung inkremental, bukan dihitung ulang penuh.
  *Menunggu verifikasi:* p95 pada 1 juta post butuh klaster berisi data. Cache dan rollup inkremental sendiri sudah terverifikasi.
  *Sengaja ditunda:* panel belum MEMBACA rollup — keputusan kapan panel memakai rollup dan kapan memakai post mentah butuh pengukuran yang sedang terblokir itu. Menebaknya sekarang berarti menambah jalur kode yang mungkin tidak perlu.

---

## E6 — Dashboard UI

- [x] **T-048 · Shell layout & navigasi**
  FR: — · Depends: T-009 · Est: 1d
  Acceptance: header dengan nav modul cocok dengan `Screenshot_1.png` (header) dan `Screenshot_7.png` (dropdown Conversation); dropdown Conversation memuat item Fase 2 dalam keadaan disabled dengan label "segera hadir" — bukan disembunyikan, supaya roadmap terlihat.
  *Ditambahkan saat dikerjakan:* Vitest plus Testing Library, dipasang di CI. E6 punya sepuluh task UI, dan memasang test runner belakangan berarti menulis test untuk sepuluh panel setelah semuanya jadi.

- [~] **T-049 · Filter bar global & refresh interval**
  FR: FR-401, FR-402 · Depends: T-048, T-039 · Est: 1,5d
  Acceptance: cocok dengan `Screenshot_7.png` dan `Screenshot_13.png` (dropdown interval); state tersinkron ke URL; pilihan interval tersimpan per user; indikator update terakhir terlihat.
  *Menunggu verifikasi:* "tersimpan per user" baru bisa berarti per akun setelah T-064. Sekarang tersimpan per browser lewat localStorage — pendekatan terdekat yang jujur selama belum ada konsep user.
  *Sengaja ditunda:* pemilih topic masih menampilkan nilai dari URL apa adanya. Daftar topic yang bisa dipilih datang dari API admin di T-058, dan mengarangnya sekarang berarti membuat dropdown berisi topic yang tidak ada.

- [x] **T-050 · Chart primitives**
  FR: — · Depends: T-009 · Est: 2d
  Area, line, pie, treemap, word cloud, choropleth. Palet warna konsisten, aksesibel di mode terang dan gelap.
  Acceptance: semua chart responsif; kondisi kosong dan loading tertangani; warna lolos kontras WCAG AA.
  *Dikoreksi saat dikerjakan:* palet T-009 gagal WCAG 1.4.11 di mode gelap pada **enam dari sepuluh** warna (threads 1,06:1). Diganti palet per-tema yang kontrasnya dihitung, dengan test yang menghitung ulang tiap kali.
  *Ditambahkan:* keadaan **gagal** dipisah dari **kosong**. Acceptance cuma menyebut kosong dan loading, tapi panel yang gagal lalu ditampilkan sebagai "tidak ada data" memberi kesimpulan yang berlawanan dengan kenyataan.

- [x] **T-051 · Panel Exposure**
  FR: FR-403 · Depends: T-050, T-040 · Est: 1d
  Acceptance: cocok dengan `Screenshot_1.png`; toggle legend; tooltip.
  *Ditambahkan saat dikerjakan:* lapisan pemuatan data (`lib/api/`) yang dipakai bersama T-052 s/d T-056. Yang memanggil API adalah HALAMAN, sekali, bukan tiap panel — kalau tidak, rancangan satu-request T-039 batal dan tujuh panel jadi tujuh kali mengeksekusi filter yang sama.

- [x] **T-052 · Panel Issues word cloud**
  FR: FR-404 · Depends: T-050, T-041 · Est: 1d
  Acceptance: cocok dengan `Screenshot_1.png`; klik frasa memfilter tampilan.
  *Ditambahkan saat dikerjakan:* dimensi filter `isu` di API (`FilterDashboard`, router, dan **kunci cache T-047**). Acceptance-nya menuntut klik frasa menyaring tampilan, dan tidak ada dimensi filter yang bisa melakukan itu sebelumnya.

- [x] **T-053 · Panel Engagements history & Issue engagement**
  FR: FR-405, FR-406 · Depends: T-050, T-041, T-042 · Est: 1d
  Acceptance: cocok dengan `Screenshot_1.png` (bagian bawah) dan `Screenshot_2.png` (bagian atas).
  *Dikoreksi:* semula menunjuk `Screenshot_9.png` — nomor di dokumen bergeser +6 dari nama berkas — lihat entri PROGRESS "Koreksi rujukan screenshot".

- [x] **T-054 · Panel Total posts & replies**
  FR: FR-407 · Depends: T-050, T-043 · Est: 0,5d
  Acceptance: cocok dengan `Screenshot_2.png` (panel TOTAL POSTS dan TOTAL REPLIES).
  *Dikoreksi:* semula menunjuk `Screenshot_9.png` — nomor di dokumen bergeser +6 dari nama berkas — lihat entri PROGRESS "Koreksi rujukan screenshot".

- [x] **T-055 · Panel Topic location (peta Indonesia)**
  FR: FR-408 · Depends: T-050, T-044 · Est: 1,5d
  Acceptance: cocok dengan `Screenshot_2.png` (peta plus daftar provinsi); **38 provinsi**; provinsi tanpa data tetap terlihat abu-abu; daftar tersinkron dengan peta saat hover.
  *Dikoreksi:* semula tertulis 34, mengikuti kekeliruan yang sama yang sudah diperbaiki di T-028 — Indonesia punya 38 provinsi sejak pemekaran Papua 2022.
  *Diputuskan user (2026-09-10):* peta **skematik** — satu ubin berukuran sama per provinsi di posisi relatifnya — alih-alih peta geografis. Batas provinsi adalah data yang tidak boleh dikarang, dan di peta geografis DKI Jakarta cuma sebutir titik yang hampir mustahil di-hover. `Choropleth` menerima path apa pun, jadi geometri geografis bisa menggantikannya nanti tanpa mengubah komponen.

- [x] **T-056 · Halaman Sentiment (lengkap)**
  FR: FR-501 s/d FR-507 · Depends: T-050, T-045, T-046 · Est: 3d
  Acceptance: ketujuh panel cocok dengan `Screenshot_8.png` (timeline, proporsi, feed), `Screenshot_3.png` (versi berbobot engagement), dan `Screenshot_10.png` (panel per polaritas); feed tiga kolom dengan infinite scroll; klik post membuka aslinya.
  *Ditambahkan saat dikerjakan:* panel API `sentiment_engagement_timeline`. FR-504 meminta timeline DAN pie berbobot engagement; T-045 hanya membuat pie-nya.
  *Diperbaiki:* kursor feed T-046 — kolom yang sudah habis dicari ulang dari halaman pertama setiap kali "muat lebih banyak", menggandakan post di kolom itu. Sekarang dicatat `HABIS` di kursor gabungan.
  *Ditunda ke T-057:* menjaga posisi gulir dan halaman feed tambahan saat auto-refresh. Sekarang halaman tambahan dibuang setiap kali data dasar berganti.

- [x] **T-057 · Auto-refresh & sinkronisasi state URL**
  FR: FR-402, FR-401 · Depends: T-049 · Est: 1d
  Acceptance: auto-refresh sesuai interval; posisi scroll terjaga saat refresh; URL bisa dibagikan dan mereproduksi tampilan yang sama.
  *Ditambahkan saat dikerjakan:* rentang tetap `mulai`/`selesai` di URL plus tombol salin tautan. Preset ("hari") dihitung ulang saat tautan dibuka, jadi tautan berpreset tidak mereproduksi tampilan yang sama — jendelanya bergeser mengikuti jam penerima.
  *Diperbaiki:* halaman lanjutan feed memakai filter yang sedang dipilih, bukan filter milik feed yang tampil. Sesudah ganti filter, kursor feed lama terkirim bersama filter baru.
  *Diperbaiki:* refresh yang gagal mengganti seluruh panel dengan pesan error — membuang data lama yang masih sah dan meruntuhkan tinggi panel.
  *Catatan verifikasi:* "posisi scroll terjaga" diuji secara struktural (tidak ada panel atau post yang dilepas atau diganti saat refresh), bukan dengan mengukur posisi gulir di browser sungguhan. Pengukuran itu masuk daftar verifikasi manual saat stack jalan di Docker/VPS.

---

## E7 — Topic Admin UI

- [x] **T-058 · Halaman Topic & Account (daftar)**
  FR: FR-101 · Depends: T-048 · Est: 1,5d
  Acceptance: cocok dengan `Screenshot_11.png`; pencarian, sort, paginasi; 108+ topic ter-handle tanpa masalah kinerja.
  *Ditambahkan saat dikerjakan:* endpoint `GET /api/v1/topics`. FR-101 cuma dipetakan ke task UI ini dan tidak ada task lain yang membuat API admin topic — daftarnya harus datang dari suatu tempat.
  *Ditambahkan:* dependency session database di API (`get_sesi`). Sebelum ini API hanya menyentuh OpenSearch dan Redis.
  *Deviasi:* 10 kartu per halaman, bukan 5 seperti referensi — dengan 5, 108 topic jadi 22 halaman klik. Kontrolnya sama.
  *Catatan verifikasi:* "108+ topic tanpa masalah kinerja" dipenuhi dengan paginasi di sisi Postgres (LIMIT/OFFSET plus urutan yang stabil), bukan diukur terhadap 108 topic sungguhan — pengukurannya butuh Postgres jalan dan masuk verifikasi manual Docker/VPS.
  *Belum:* pemilih topic di filter bar (utang T-049). Endpoint-nya sudah ada jadi tidak terhalang lagi; sementara ini topic dipilih dari kartu yang tertaut ke dashboard.

- [x] **T-059 · Tab General**
  FR: FR-103, FR-108 · Depends: T-058 · Est: 1,5d
  Acceptance: cocok dengan `Screenshot_11.png`; nama, deskripsi, checkbox platform, taxonomy, toggle filter ads; validasi form.
  *Ditambahkan saat dikerjakan:* endpoint `GET /api/v1/topics/{id}`, `POST /api/v1/topics`, dan `PATCH /api/v1/topics/{id}` — jalur tulis pertama ke Postgres di repo ini.
  *Deviasi:* Taxonomy Type dipakai radio, bukan checkbox seperti referensi. `taxonomy_type` menyimpan SATU nilai, jadi dua checkbox tercentang tidak punya representasi; radio sekalian memberi cara membatalkan pilihan.
  *Keputusan:* platform tanpa adapter (Bluesky, Reddit) ditampilkan nonaktif dan ditolak server. Menerimanya berarti topic yang tidak mengumpulkan apa pun tanpa satu pun tanda.
  *Belum:* perubahan yang belum disimpan hilang tanpa konfirmasi kalau topic lain dipilih. Ditandai lencana "belum disimpan"; dialog konfirmasi ditahan sampai ada bukti orang benar-benar kehilangan isian.
  *Catatan:* `is_active` tidak bisa diubah dari tab ini — referensi juga tidak punya kontrolnya. Topic baru tersimpan aktif, tapi pengumpulan data baru jalan setelah T-063.

- [x] **T-060 · Tab Query Lists**
  FR: FR-102, FR-104, FR-105 · Depends: T-058, T-024 · Est: 2d
  Acceptance: cocok dengan `Screenshot_12.png`; beberapa query per topic; textarea query dengan validasi sintaks realtime; checkbox bahasa; keyword, media tags, not media tags.
  *Ditambahkan saat dikerjakan:* endpoint `POST /api/v1/topics/validate-query` (bebas database) dan `PUT /api/v1/topics/{id}/queries`.
  *Keputusan:* validasi sintaks dikirim ke server, bukan ditulis ulang sebagai parser kedua di TypeScript. Dua parser untuk satu sintaks akan berbeda perlahan, dan bedanya muncul sebagai UI yang mengatakan "valid" untuk query yang ditolak collector.
  *Keputusan:* daftar query dikirim utuh lalu di-diff per id, bukan endpoint per query. Query yang tidak berubah mempertahankan id-nya (percolator mendaftarkan per id, FR-109), dan penghapusan ikut terwakili dalam satu permintaan.
  *Keputusan:* query tidak valid DITOLAK, bukan disimpan dengan `is_valid: false`. Kolom itu untuk query yang dulu sah lalu jadi tidak sah karena parsernya berubah — ditemukan audit, bukan diketik orang.
  *Diperbaiki:* pesan "tersimpan" hilang seketika di tab General, karena penyimpanan memicu efek yang menghapusnya sendiri. Ketemu waktu test T-059 gagal setelah formulir dipecah per tab.
  *Catatan verifikasi:* acceptance FR-102 "query valid cocok dengan post yang tepat" belum bisa dibuktikan di sini — itu butuh percolator (T-063) dan OpenSearch jalan. Yang dibuktikan T-060: sintaksnya diperiksa parser yang sama dengan yang dipakai collector, dan keyword pengumpulannya terlihat sebelum disimpan.

- [x] **T-061 · Tab Demography Filter**
  FR: FR-106 · Depends: T-058 · Est: 1d
  Acceptance: konfigurasi tersimpan dan ter-restore; UI menyatakan dengan jelas bahwa filter belum aktif sampai Fase 3.
  *Ditambahkan saat dikerjakan:* endpoint `GET` dan `PUT /api/v1/topics/{id}/demography`, plus bentuk konfigurasinya dinyatakan di `packages/schema` (`DemographyConfig`, enum `Gender` dan `AgeGroup`) dan tipe TS-nya di-generate ulang.
  *Keputusan:* `is_enforced` tidak bisa dikirim klien dan selalu ditulis False. Satu-satunya yang boleh menyalakannya adalah Fase 3; UI yang bisa menyalakannya sendiri akan menjanjikan penyaringan yang tidak terjadi.
  *Keputusan:* nama provinsi divalidasi terhadap gazetteer 38 provinsi. Nama yang salah ketik tidak akan pernah cocok begitu Fase 3 menerapkannya, dan tidak ada apa pun yang akan mengatakannya.
  *Catatan:* tidak ada screenshot referensi untuk tab ini — bentuknya diturunkan dari FR-106 dan dimensi yang dijanjikan ROADMAP 3.1.
  *Perlu dikonfirmasi:* dua kelompok umur teratas (`41_55`, `above_55`) adalah dugaan. Judul panelnya terpotong di tepi atas `Screenshot_10.png` dan tidak terbaca; harus dipastikan sebelum panel umur Fase 3 dibuat.

- [x] **T-062 · Preview query**
  FR: FR-107 · Depends: T-060, T-039 · Est: 1,5d
  Acceptance: preview kembali di bawah 5 detik; menampilkan minimal 20 sampel post plus estimasi volume harian; **memperingatkan kalau estimasi melebihi ambang biaya**.
  *Ditambahkan saat dikerjakan:* endpoint `POST /api/v1/topics/preview`, modul `sma_core/cost.py` (tarif dari COST-MODEL.md, dipakai lagi cost guard E9), dan `sma_core/query/topik.py` — pembangun query topic yang T-063 harus pakai juga supaya preview dan percolator tidak pernah berbeda.
  *Ditambahkan:* field `window_days` dan `per_platform_daily` di `TopicPreview`. Jumlah tanpa jendela tidak bisa dibaca, dan biaya tanpa sebaran platform tidak bisa ditelusuri.
  *Keputusan:* biaya dihitung per platform dari sebaran nyata hasil pencarian, bukan dari total dikali satu tarif rata-rata — selisih tarif antar platform lebih dari 13x.
  *Tafsiran FR-105:* `keywords` berarti minimal satu harus cocok, `media_tags` dicocokkan sebagai hashtag, `not_media_tags` membuang post meski query utama cocok (yang terakhir satu-satunya yang dinyatakan eksplisit di PRD).
  *Catatan verifikasi:* acceptance "di bawah 5 detik untuk korpus 1 juta post" BELUM diukur — butuh OpenSearch berisi data. Ambangnya ada di kode (`LAMBAT_MS`) dan preview yang melewatinya dicatat sebagai peringatan di log.
  *Catatan:* angkanya batas bawah. Preview mencari di korpus yang sudah terkumpul, dan pengumpulan digerakkan keyword — topic baru bisa menarik lebih banyak.

- [x] **T-063 · Aktivasi topic & pemicu backfill**
  FR: FR-109 · Depends: T-062, T-026, T-019 · Est: 1d
  Acceptance: menyimpan topic akan mendaftarkan percolator, memperbarui rencana stream, dan memicu backfill; progres terlihat; kegagalan bisa di-rollback.
  *Ditambahkan saat dikerjakan:* `sma_core/streams/store.py` (penyimpan rencana stream — planner sudah ada sejak T-021 tapi hasilnya belum pernah ditulis ke database), `percolator.id_query_terdaftar`, `planner.kunci_stream`, plus endpoint `POST /{id}/activate` dan `GET /{id}/activation`.
  *Keputusan:* urutan langkahnya Postgres dulu (rencana stream), OpenSearch belakangan (percolator, backfill). Postgres bisa di-rollback, OpenSearch tidak — jadi yang tidak bisa dibatalkan dikerjakan paling akhir.
  *Keputusan:* aktivasi dipisah dari penyimpanan query. Menyimpan cuma menyentuh Postgres dan hampir tidak pernah gagal; kalau keduanya satu operasi, indeks yang sedang bermasalah membuat query yang sudah diketik ikut gagal disimpan. UI memanggil aktivasi tepat setelah Save, dan kegagalannya punya tombol "coba aktifkan lagi".
  *Keputusan:* backfill yang gagal TIDAK membatalkan pendaftaran percolator. Membatalkannya akan membuat topic berhenti mengumpulkan post baru juga, padahal yang rusak cuma data historisnya.
  *Catatan verifikasi:* seluruh alurnya diuji dengan klien palsu — belum pernah dijalankan terhadap OpenSearch dan Postgres sungguhan. Itu bagian terbesar dari verifikasi manual Docker/VPS untuk E7.

---

## E8 — Auth & RBAC

- [x] **T-064 · Autentikasi**
  FR: FR-601 · Depends: T-003, T-009 · Est: 1,5d
  Acceptance: login dan logout jalan; sesi expire setelah 8 jam idle; password di-hash Argon2id; rate limit pada percobaan login.
  *Ditambahkan saat dikerjakan:* `sma_core/auth/password.py`, `sma_api/auth/` (sesi, rate limit, repo, dependency, router), model Pydantic `User`, halaman `/login`, dan perintah `python -m sma_api.auth.buat_user` — tanpa yang terakhir tabel user kosong dan FR-601 tidak bisa dibuktikan sama sekali.
  *Keputusan:* sesi memakai token opaque di Redis, BUKAN JWT. "8 jam tidak aktif" dan "logout benar-benar mematikan sesi" keduanya hal yang tidak diberikan JWT. `pyjwt` jadi dependensi yang belum terpakai — dibiarkan, dicatat di utang teknis.
  *Keputusan:* parameter Argon2id diambil dari pengukuran, bukan dari angka yang paling sering dikutip. RFC 9106 opsi kedua (m=64 MiB, t=3, p=4) terukur 740 ms per verifikasi di mesin ini — cukup untuk membuat lima penebak paralel menyumbat API. Dipakai anjuran OWASP (m=19 MiB, t=2, p=1), ~75 ms.
  *Keputusan:* yang disimpan di sesi cuma id user. Role dan status dibaca ulang tiap request, jadi penurunan role dan penonaktifan akun berlaku di request berikutnya, bukan delapan jam kemudian.
  *Sengaja ditunda:* belum ada penjaga route — halaman masih bisa dibuka tanpa sesi, dan endpoint analytics serta topic belum memeriksa siapa pemanggilnya. Itu T-066. Yang sudah dipasang sekarang: `credentials: "include"` di semua klien, supaya yang berubah nanti cuma sisi server.
  *Sengaja ditunda:* `X-Forwarded-For` tidak dibaca. Tanpa daftar proxy tepercaya, mempercayainya membuat rate limit per IP bisa dilewati hanya dengan mengarang nilai baru tiap percobaan. Masuk penyetelan produksi.
  *Catatan verifikasi:* Postgres dan Redis diganti palsu di seluruh test. Belum pernah ada login sungguhan terhadap kedua service itu — bagian dari verifikasi manual Docker/VPS.

- [x] **T-065 · Model role & permission**
  FR: FR-602 · Depends: T-064 · Est: 1d
  Acceptance: tiga role terdefinisi; penugasan topic untuk viewer; permission dicek di server, bukan cuma disembunyikan di UI.
  *Ditambahkan saat dikerjakan:* `sma_core/auth/rbac.py` (tabel kewenangan), enum `Permission` di schema, `sma_api/auth/izin.py` (dependency penjaga), `sma_api/users/` (daftar user dan penugasan topic), plus `permissions` dan `assigned_topics` di `/auth/me`.
  *Keputusan:* endpoint menyebut PERMISSION, bukan role. `Depends(butuh_izin(Permission.TOPIC_WRITE))`, bukan `if role == "admin"`. Role keempat nanti cuma mengubah satu tabel pemetaan.
  *Keputusan:* permission dan lingkup topic dipisah jadi dua lapis. Permission menjawab "boleh membaca topic?", lingkup menjawab "topic yang MANA?". Mode kegagalannya berbeda: permission yang salah menolak orang yang seharusnya boleh dan langsung dikeluhkan; lingkup yang salah MEMBERI data yang bukan haknya dan tidak ada yang mengeluh.
  *Keputusan:* daftar penugasan KOSONG berarti tidak ada topic yang terjangkau, bukan "tanpa batasan". Dijaga di tiga tempat (core, API, klien web) karena kebalikannya adalah bug RBAC yang paling sering terjadi.
  *Keputusan:* role dengan nilai tak dikenal jatuh ke viewer, bukan melempar. Baris user yang datanya kacau harus mendapat kewenangan paling sempit; melempar akan membuat setiap request-nya jadi 500.
  *Sengaja ditunda:* endpoint analytics dan topic yang sudah ada BELUM memakai penjaga ini — itu T-066, beserta penjaga route di sisi web dan matriks test role × resource.
  *Sengaja ditunda:* role belum bisa diubah lewat API. FR-603 meminta perubahan user tercatat dengan nilai sebelum dan sesudah, dan itu T-067; menambah jalur ubah role sekarang berarti membuat jalur yang paling perlu diaudit sebelum auditnya ada.

- [x] **T-066 · Proteksi route & API**
  FR: FR-602 · Depends: T-065 · Est: 1d
  Acceptance: viewer yang mengakses topic tak berizin lewat URL langsung dapat 403; endpoint API menerapkan aturan yang sama dengan UI; test mencakup setiap kombinasi role dan resource.
  *Ditambahkan saat dikerjakan:* penjaga di 13 endpoint topic dan analytics, parameter `lingkup` di `repo.daftar_topic`, `<SesiProvider>` plus `<PenjagaRoute>` di sisi web, tabel `IZIN_ROUTE` di `lib/nav.ts`, dan `tests/api/conftest.py` yang memasang sesi admin bawaan.
  *Keputusan:* daftar topic DISARING, satu topic DITOLAK. 403 di daftar cuma menghasilkan halaman kosong tanpa alasan; 403 saat seseorang menyebut satu topic lewat URL adalah jawaban yang bermakna, dan itu yang diminta acceptance.
  *Keputusan:* izin topic diperiksa SEBELUM cache dashboard. Cache dikunci per filter, bukan per user — memeriksa sesudahnya berarti viewer yang tidak berhak dilayani dari entri yang dihangatkan orang lain, tanpa satu pun query berjalan atas namanya.
  *Keputusan:* `preview` dan `validate-query` butuh `TOPIC_WRITE`, bukan `TOPIC_READ`. Keduanya menjalankan pencarian sembarang terhadap SELURUH korpus tanpa menyebut topic, jadi lingkup topic tidak membatasi apa pun di sana.
  *Keputusan:* daftar halaman terbuka adalah daftar PUTIH. Halaman baru yang lupa didaftarkan jadi tertutup — arah gagal yang aman.
  *Ditemukan saat dikerjakan:* test yang memakai `user.type` per karakter jadi sumber kegagalan berpindah-pindah begitu suite-nya tumbuh. Diganti `paste` lewat `lib/uji/ketik.ts`.
  *Catatan verifikasi:* penegakan di server diuji dengan session dan OpenSearch palsu. Yang belum: satu pun penolakan sungguhan terhadap Postgres berisi baris `user_topic`.

- [x] **T-067 · Audit log**
  FR: FR-603 · Depends: T-065 · Est: 1d
  Acceptance: perubahan topic, perubahan user, dan login tercatat dengan nilai sebelum dan sesudah; log tidak bisa diubah dari aplikasi; bisa dicari berdasarkan aktor dan rentang tanggal.
  *Ditambahkan saat dikerjakan:* `sma_api/audit/` (pencatat, repo, endpoint pencarian), migrasi `0002` berisi trigger append-only, dan pemasangan pencatatan di tujuh operasi.
  *Keputusan:* baris audit ditulis dalam TRANSAKSI yang sama dengan perubahannya. Perubahan yang di-rollback membatalkan catatannya, dan sebaliknya — "tersimpan tapi auditnya hilang" jadi mustahil. Konsekuensinya kegagalan menulis audit menggagalkan operasinya juga; audit yang boleh gagal diam-diam bukan audit.
  *Keputusan:* yang disimpan cuma field yang BERUBAH, dengan kunci sama di kedua sisi. Perubahan yang tidak mengubah apa pun tidak menghasilkan baris sama sekali.
  *Keputusan:* email pelaku login gagal disimpan HANYA kalau cocok akun yang ada. Alamat tak dikenal diganti penanda — kolom email yang tidak cocok akun mana pun paling sering berisi password yang salah ketik ke kolom sebelahnya.
  *Ditambahkan di luar acceptance:* trigger Postgres yang menolak UPDATE dan DELETE pada `audit_log`. Acceptance cuma meminta "tidak bisa diubah dari aplikasi", dan itu sudah dijamin tidak adanya fungsinya — tapi jaminan itu berumur sampai orang berikutnya menambahkan satu.
  *Sengaja ditunda:* tidak ada halaman audit di dashboard. Pencariannya lewat API, dan tidak ada task Fase 1 yang meminta UI-nya.
  *Sengaja ditunda:* retensi. Tabel ini tumbuh selamanya; pemangkasannya harus lewat prosedur tersendiri yang mematikan trigger dengan sengaja, justru supaya penghapusan audit tidak pernah jadi operasi biasa.
  *Catatan verifikasi:* trigger-nya BELUM pernah dijalankan — migrasi `0002` butuh Postgres. Itu bagian pertama verifikasi Docker/VPS untuk E8.

---

## E9 — Cost Guard & Observability

Epic ini gampang ditunda-tunda. Jangan — biaya sudah mulai berjalan sejak T-012 selesai.

- [~] **T-068 · Cost accounting**
  FR: FR-701 · Depends: T-013, T-003 · Est: 1d
  Acceptance: tiap panggilan provider mencatat provider, jumlah unit, biaya unit, dan total; biaya teratribusi ke stream lalu dialokasikan ke topic secara proporsional; total cocok dengan tagihan provider dalam selisih 5%.
  ⚠ `[~]` Pencatatan, pengelompokan, dan alokasinya jadi dan teruji, TAPI dua acceptance terakhir belum terbukti: belum ada tagihan provider untuk dibandingkan, dan loop collector yang memanggil `fetch_tercatat` belum ditulis (menunggu T-012 s/d T-018 lepas dari `[~]`). Yang sudah bisa dipastikan sekarang: alokasinya tidak pernah membuang biaya — ada test yang memeriksa jumlahnya utuh.
  *Ditambahkan saat dikerjakan:* `sma_core/cost/` jadi paket (tarif, store, alokasi), plus `sma_worker/tasks/fetch.py` — pembungkus yang menjadikan "memanggil provider tanpa mencatat biaya" sulit dilakukan tanpa sengaja.
  *Keputusan:* alokasi proporsional terhadap jumlah post dari stream itu yang benar-benar COCOK tiap topic, bukan dibagi rata. Pembagian rata membuat topic yang menyerap sepersepuluh keluaran stream terlihat sama mahalnya dengan yang menyerap sisanya.
  *Keputusan:* biaya yang tidak bisa diatribusikan masuk `tak_teralokasi`, bukan dibuang. Itu yang membuat rekonsiliasi 5% terhadap tagihan bisa dilakukan sama sekali.
  *Keputusan:* biaya dicatat juga saat fetch gagal SETELAH provider mengirim sebagian hasil. Kalau tidak, kegagalan berulang jadi jalur yang menghabiskan uang tanpa terlihat.

- [x] **T-069 · Budget cap, alert, & throttle**
  FR: FR-702 · Depends: T-068, T-020 · Est: 1,5d
  Acceptance: cap per topic dan global; alert di 80%; di 100% interval polling turun ke maksimum, ingestion **tidak** berhenti; override manual tersedia untuk admin.
  *Ditambahkan saat dikerjakan:* `sma_core/cost/{guard,cap}.py`, tabel `cost_cap` (migrasi `0003`), parameter `ditahan_biaya` di scheduler, dan endpoint `/api/v1/cost/{status,caps}`.
  *Keputusan:* enum `Tingkat` sengaja TIDAK punya nilai yang berarti berhenti. Nilai yang tidak ada tidak bisa dipilih orang berikutnya yang merasa berhenti lebih aman — dan FR-702 menyebut sebaliknya.
  *Keputusan:* stream ditahan hanya kalau SELURUH topic-nya lewat cap, bukan salah satu. Melambatkan stream bersama tidak menghemat apa pun yang tidak sudah jadi hak topic lain yang masih sehat, sambil merugikan topic itu. Konsekuensinya jujur: cap topic yang stream-nya dipakai bersama memicu alert, bukan throttle.
  *Keputusan:* cap biaya diperiksa PALING AWAL di scheduler, di atas "stream ramai". Stream yang ramai justru yang paling cepat menghabiskan anggaran.
  *Keputusan:* alasan wajib diisi saat mengubah cap, dan perubahannya masuk audit log. Cap yang dinaikkan tanpa alasan tercatat adalah cap yang tidak menahan apa pun.
  *Sengaja ditunda:* saluran pengiriman alert (email, Slack) adalah T-073. Sekarang alert-nya berupa log terstruktur dan status di endpoint — terbaca, tapi belum ada yang mendorongnya ke siapa pun.
  *Sengaja ditunda:* UI-nya. Halaman biaya adalah T-070.
  *Catatan verifikasi:* migrasi `0003` belum pernah dijalankan, dan throttle-nya belum pernah benar-benar melambatkan fetch — collector-nya belum ada (T-068).

- [ ] **T-070 · Dashboard biaya internal**
  FR: FR-701 · Depends: T-068 · Est: 1d
  Acceptance: biaya per topic, per platform, per hari; proyeksi bulan berjalan; perbandingan dengan estimasi di [COST-MODEL.md](docs/COST-MODEL.md).

- [ ] **T-071 · Structured logging & correlation ID**
  FR: FR-703 · Depends: T-007, T-008 · Est: 1d
  Acceptance: log berformat JSON; correlation ID mengalir dari request UI sampai panggilan provider; level log bisa dikonfigurasi.

- [ ] **T-072 · Metrik & health**
  FR: FR-703 · Depends: T-071 · Est: 1d
  Acceptance: metrik Prometheus untuk throughput ingestion, lag NLP, panjang antrean, latensi API; endpoint health mencerminkan status dependensi sebenarnya.

- [ ] **T-073 · Alert kegagalan pipeline**
  FR: FR-703 · Depends: T-072 · Est: 1d
  Acceptance: kegagalan adapter memicu alert dalam 5 menit; backlog antrean memicu alert; alert menyertakan konteks yang cukup untuk mulai diagnosis tanpa membuka log.

- [ ] **T-074 · Runbook operasional**
  FR: — · Depends: T-073 · Est: 1d
  Acceptance: mencakup provider mati, backlog antrean, cap biaya tercapai, dan penurunan akurasi NLP; tiap skenario punya langkah diagnosis dan perbaikan.

---

## Matriks Traceability

Tiap FR di [PRD.md](PRD.md) harus muncul minimal sekali.

| FR | Task |
|---|---|
| FR-101 | T-058 |
| FR-102 | T-024, T-060 |
| FR-103 | T-059 |
| FR-104 | T-060 |
| FR-105 | T-060 |
| FR-106 | T-061 |
| FR-107 | T-062 |
| FR-108 | T-059 |
| FR-109 | T-026, T-063 |
| FR-201 | T-011 s/d T-018 |
| FR-202 | T-019 |
| FR-203 | T-020 |
| FR-204 | T-012, T-014 s/d T-018, T-022 |
| FR-205 | T-004, T-005, T-021 |
| FR-206 | T-023, T-025 |
| FR-207 | T-028 |
| FR-208 | T-027 |
| FR-301 | T-030, T-031, T-037 |
| FR-302 | T-031, T-033 |
| FR-303 | T-032 |
| FR-304 | T-034 |
| FR-305 | T-035 |
| FR-306 | T-004, T-029 |
| FR-307 | T-038 |
| FR-401 | T-039, T-049, T-057 |
| FR-402 | T-020, T-049, T-057 |
| FR-403 | T-040, T-051 |
| FR-404 | T-041, T-052 |
| FR-405 | T-036, T-042, T-053 |
| FR-406 | T-041, T-053 |
| FR-407 | T-043, T-054 |
| FR-408 | T-044, T-055 |
| FR-409 | T-045 |
| FR-501 | T-045, T-056 |
| FR-502 | T-045, T-056 |
| FR-503 | T-046, T-056 |
| FR-504 | T-036, T-045, T-056 |
| FR-505 | T-046, T-056 |
| FR-506 | T-046, T-056 |
| FR-507 | T-046, T-056 |
| FR-601 | T-064 |
| FR-602 | T-065, T-066 |
| FR-603 | T-067 |
| FR-701 | T-068, T-070 |
| FR-702 | T-069 |
| FR-703 | T-007, T-071, T-072, T-073 |
| NFR-01 | T-047 |
