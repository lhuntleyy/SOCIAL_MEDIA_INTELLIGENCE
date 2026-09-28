# PRD — Social Media Analytics & Sentiment Platform

| | |
|---|---|
| **Versi** | 1.0 |
| **Tanggal** | 2026-09-01 |
| **Status** | Draft — menunggu approval sebelum implementasi |
| **Codename** | SMA (Social Media Analytics) |
| **Dokumen terkait** | [TASK.md](TASK.md) · [PROGRESS.md](PROGRESS.md) · [Architecture](docs/ARCHITECTURE.md) · [Data Sources](docs/DATA-SOURCES.md) · [Cost Model](docs/COST-MODEL.md) · [Roadmap](docs/ROADMAP.md) |

---

## 1. Ringkasan Eksekutif

SMA adalah platform monitoring dan analisis percakapan media sosial untuk konten berbahasa Indonesia. Pengguna mendefinisikan **topic** lewat boolean query, sistem mengumpulkan post yang relevan dari 6+ platform secara berkelanjutan, mengklasifikasi sentimen dan isu secara otomatis, lalu menyajikannya sebagai dashboard analitik yang bisa di-refresh tiap 5 menit sampai 1 jam.

Referensi produk: dashboard "ISA" (13 screenshot di [`docs/screenshots/`](docs/screenshots/)). Fase 1 menargetkan paritas pada modul Dashboard dan Conversation > Sentiment. Modul lain dipetakan di [ROADMAP.md](docs/ROADMAP.md).

### Insight yang membentuk produk ini

Biaya operasional platform ini **didominasi oleh akuisisi data, bukan oleh komputasi atau NLP**. Konsekuensinya, dua keputusan arsitektur berikut bukan optimasi opsional — keduanya adalah syarat kelayakan ekonomi produk, dan diangkat menjadi requirement kelas satu (FR-202, FR-203, FR-204):

1. **Fetch harus inkremental.** Provider menagih per hasil yang dikembalikan, bukan per hasil unik. Polling tanpa pelacakan posisi membuat biaya membengkak **12,7x** ($4.385/bln vs $345/bln pada 30 topic). Ini pengaman terpenting, dan berlaku sejak topic pertama.
2. **Collection stream dipisahkan dari topic.** Data ditarik sekali ke korpus bersama, lalu di-*route* ke topic secara lokal. Penghematannya tumbuh seiring jumlah topic: **1,35x** pada 30 topic, **2,45x** pada 108 topic (skala produk referensi).

Urutan pengerjaan mengikuti urutan itu — fetch inkremental (T-012, T-022) sebelum dedup planner (T-019). Rincian angka: [COST-MODEL.md](docs/COST-MODEL.md).

---

## 2. Problem Statement

Lembaga pemerintah, humas korporat, dan tim komunikasi politik di Indonesia perlu tahu **apa yang sedang dibicarakan publik tentang isu tertentu, seberapa besar eksposurnya, dan apakah nadanya positif atau negatif** — dalam hitungan menit, bukan hari.

Kondisi saat ini:

- **Tool global (Brandwatch, Meltwater, Talkwalker)** harganya $1.000–5.000/bulan, dan akurasi sentimennya buruk untuk bahasa Indonesia informal — apalagi bahasa gaul, singkatan, dan campur kode Jawa/Sunda yang lazim di X dan TikTok.
- **Riset manual** tidak bisa mengikuti volume. Satu isu viral bisa menghasilkan 12.000+ post dalam sehari (lihat baseline di bagian 9).
- **API resmi platform tidak memadai.** Meta Graph API dan TikTok API tidak menyediakan pencarian keyword publik sama sekali; X API resmi berbiaya ~$5 per 1.000 post yang dibaca.

### Yang membuat produk ini berbeda

| Aspek | Tool global | SMA |
|---|---|---|
| Akurasi Bahasa Indonesia | Model multibahasa generik | Model khusus + normalisasi bahasa gaul |
| Biaya | $1.000–5.000/bln | ~$345/bln untuk 30 topic |
| Granularitas refresh | 15 menit–24 jam | 5 menit–1 jam, bisa dipilih |
| Kedaulatan data | Cloud vendor asing | Bisa on-premise (Fase 4) |
| Cakupan lokal | TikTok/Threads Indonesia lemah | Prioritas platform pasar Indonesia |

---

## 3. Target Pengguna & Persona

### P1 — Analis (pengguna harian, ~80% waktu pakai)
Memantau beberapa topic aktif, mencari lonjakan anomali, membaca post individual untuk konteks, membuat laporan harian.
**Butuh:** dashboard cepat, filter fleksibel, akses ke post mentah, indikator sentimen yang bisa dipercaya.
**Frustrasi terbesar:** sentimen salah label bikin laporan harus dikoreksi manual.

### P2 — Supervisor (pengguna berkala, ~15%)
Melihat ringkasan lintas topic, membandingkan isu, mengambil keputusan eskalasi.
**Butuh:** tampilan agregat, tren minggu ke minggu, ekspor untuk paparan.

### P3 — Admin (pengguna sesekali, ~5%)
Mengelola topic dan query, mengatur user dan role, memantau biaya operasional.
**Butuh:** query builder yang bisa di-preview sebelum disimpan, kontrol biaya, audit log.

---

## 4. Scope

### 4.1 Termasuk di Fase 1 (Core MVP)

| Modul | Referensi screenshot |
|---|---|
| Topic & Account management | `Screenshot_11.png`, `Screenshot_12.png` |
| Ingestion multi-platform + penjadwalan | — |
| NLP: sentimen, isu, hashtag, entity | — |
| Dashboard | `Screenshot_13.png`, `Screenshot_1.png`, `Screenshot_2.png`, `Screenshot_3.png` |
| Conversation > Sentiment | `Screenshot_8.png`, `Screenshot_10.png` |
| Auth & RBAC | `Screenshot_11.png` (bar Administrator) |
| Cost guard & observability | — |

**Platform Fase 1:** X/Twitter, Instagram, TikTok, Facebook, Threads, YouTube.
**Bahasa Fase 1:** Indonesia (utama), Inggris (didukung), Malaysia (didukung).

### 4.2 Tidak termasuk di Fase 1

Dipetakan ke fase berikutnya di [ROADMAP.md](docs/ROADMAP.md) — dicatat di sini supaya batasannya eksplisit:

| Item | Fase | Alasan ditunda |
|---|---|---|
| Emotion / Perception (8 emosi Plutchik) | 2 | Butuh pipeline NLP kedua; sentimen harus stabil dulu |
| Chronology, Gallery, Issues, Engagement, Contributors | 2 | Turunan dari data yang sama, bukan jalur kritis |
| Issues Comparison | 2 | Perlu minimal 2 topic matang supaya berguna |
| Audience & Psychography (gender/umur/lokasi) | 3 | Butuh model inferensi demografi sendiri |
| Account leaderboard, deteksi buzzer | 3 | Butuh analisis graf |
| Model NLP self-host | 4 | Butuh ~100K labeled example dari operasi Fase 1 |
| Multi-tenant, ekspor PDF/Excel, alerting | 4 | — |
| Bluesky, Reddit | 4 | Volume Indonesia rendah |

### 4.3 Non-goal (tidak akan dibangun)

- **Publishing / scheduling post.** Ini tool analitik, bukan tool manajemen sosmed.
- **Monitoring akun privat atau DM.** Hanya konten publik.
- **Pelacakan individu.** Analisis pada level agregat/isu. Lihat bagian 11 soal kepatuhan UU PDP.

---

## 5. Requirement Fungsional

Notasi: **`FR-xxx`** = requirement. Setiap FR dipetakan ke satu atau lebih task di [TASK.md](TASK.md).

### 5.1 Topic Management (FR-1xx)
> Referensi: `Screenshot_11.png`, `Screenshot_12.png`

#### FR-101 — CRUD Topic
Admin bisa membuat, mengubah, menghapus, dan mencari topic. Daftar topic mendukung sort (Asc/Desc), pencarian teks, dan paginasi.
**Acceptance:** buat topic maka muncul di daftar; ubah nama maka terupdate tanpa kehilangan data historis; hapus adalah soft delete dan data post tetap ada; daftar 100+ topic ter-paginasi dengan benar.

#### FR-102 — Boolean query builder (multi-query)
Satu topic bisa punya beberapa query. Tiap query mendukung operator `AND`, `OR`, `NOT`, tanda kutip untuk frasa, dan tanda kurung untuk pengelompokan.
Contoh dari referensi: `"AMPB" OR "BOTOK" OR "REKENING" AND "MANDIRI"`
**Acceptance:** query valid tersimpan dan cocok dengan post yang tepat; query tidak valid ditolak dengan pesan error yang menunjuk posisi kesalahan; presedensi operator terdokumentasi dan konsisten dengan hasil preview.

#### FR-103 — Pemilihan platform per topic
Pilih All Platform atau kombinasi spesifik: Twitter, Instagram, Facebook, YouTube, TikTok, Bluesky, Threads, Reddit.
**Acceptance:** topic dengan hanya Twitter terpilih tidak menarik data platform lain; biaya ikut turun sesuai, terverifikasi lewat FR-701.

#### FR-104 — Filter bahasa
Checkbox per query: English, Indonesia, Malaysia. Default Indonesia.
**Acceptance:** post yang terdeteksi di luar bahasa terpilih tidak masuk ke topic; confidence deteksi bahasa tersimpan.

#### FR-105 — Keyword, Media Tags, Not Media Tags
Field tambahan per query untuk mempersempit atau mengecualikan hasil.
**Acceptance:** post yang cocok dengan Not Media Tags dikecualikan meskipun cocok dengan query utama.

#### FR-106 — Demography filter
Tab terpisah untuk membatasi topic berdasarkan atribut demografis penulis.
**Fase 1:** UI dan penyimpanan saja; penerapan filter menunggu model inferensi di Fase 3. Field yang belum aktif diberi label jelas di UI.
**Acceptance:** konfigurasi tersimpan dan ter-restore; UI menyatakan bahwa filter belum aktif.

#### FR-107 — Preview sebelum simpan
Tombol **Preview** menjalankan query terhadap data yang sudah ada dan menampilkan sampel hasil plus perkiraan volume, sebelum topic disimpan.
**Acceptance:** preview kembali dalam <5 detik untuk korpus 1 juta post; menampilkan minimal 20 sampel post dan estimasi jumlah per hari.
**Kenapa penting:** ini pengaman biaya utama. Query yang terlalu luas ketahuan sebelum jadi tagihan.

#### FR-108 — Taxonomy, deskripsi, filter ads
Metadata topic: nama, deskripsi, taxonomy type (Interest/Industry), tag taxonomy, toggle Filter Ads.
**Acceptance:** dengan Filter Ads aktif, post yang teridentifikasi sponsored atau promoted dikecualikan.

#### FR-109 — Aktivasi topic & backfill
Menyimpan topic akan mendaftarkan query-nya ke percolator index dan memicu backfill terhadap data historis yang sudah terkumpul.
**Acceptance:** topic baru langsung menunjukkan data historis yang cocok dalam maksimal 10 menit, tanpa menarik ulang dari provider — biaya backfill nol.

---

### 5.2 Ingestion (FR-2xx)

#### FR-201 — Adapter multi-platform
Satu interface `SourceAdapter` dengan implementasi per platform. Kontrak lengkap: [DATA-SOURCES.md](docs/DATA-SOURCES.md).
**Acceptance:** menambah platform baru hanya butuh implementasi adapter baru; tidak ada perubahan di kode pipeline, storage, atau UI.

#### FR-202 — Shared collection stream
Collector beroperasi pada **collection stream** (kumpulan keyword yang sudah di-dedup), bukan per topic. Beberapa topic yang berbagi keyword hanya memicu satu kali fetch.
**Acceptance:** dua topic dengan keyword identik menghasilkan tepat satu panggilan provider; biaya total tidak naik saat topic kedua ditambahkan.
**Kenapa penting:** ini satu-satunya requirement yang membuat produk ekonomis di atas ~10 topic.

#### FR-203 — Adaptive polling
Tiap stream punya interval dasar (5m/15m/30m/45m/1h) yang dipilih user. Scheduler menyesuaikan dalam batas tersebut berdasarkan kecepatan aktual: stream sepi melambat, stream yang sedang ramai mempercepat sampai batas minimum.
**Acceptance:** stream dengan nol hasil selama 6 siklus berturut-turut melambat ke interval berikutnya; stream yang hasilnya menyentuh limit halaman mempercepat; user tidak pernah melihat data lebih basi dari interval maksimum yang dipilih.

#### FR-204 — Fetch inkremental & dedup
Adapter melacak posisi (`since_id`, cursor, atau timestamp) dan hanya mengambil yang baru. Duplikat ditolak lewat upsert idempoten berdasarkan `(platform, platform_post_id)`.
**Acceptance:** menjalankan collector dua kali berturut-turut pada stream yang tidak berubah menghasilkan nol hasil berbayar di run kedua; nol duplikat di storage setelah 1.000 siklus.

#### FR-205 — Normalisasi ke unified Post schema
Semua payload provider dinormalisasi ke satu schema (bagian 8.1). Payload asli disimpan di object storage untuk replay.
**Acceptance:** post dari 6 platform lolos validasi schema yang sama; field yang tidak tersedia di suatu platform bernilai `null`, bukan string kosong atau nol.

#### FR-206 — Topic routing lewat percolator
Tiap post yang masuk dicocokkan ke **semua** query topic aktif dalam satu operasi percolate.
**Acceptance:** post yang cocok dengan 5 topic muncul di kelima dashboard; latensi routing <50 ms per post pada 100 topic terdaftar.

#### FR-207 — Geo enrichment
Lokasi dipetakan ke provinsi Indonesia untuk panel Topic Location (`Screenshot_2.png`).
**Acceptance:** lokasi yang ditulis bebas ("Jkt", "Jakarta Selatan", "DKI") ter-resolve ke provinsi kanonik; yang tidak bisa di-resolve dihitung sebagai `unknown`, bukan diam-diam dibuang.

#### FR-208 — Retensi data
Data mentah 12 bulan, agregat selamanya. Post yang lewat masa retensi dihapus otomatis.
**Acceptance:** kebijakan lifecycle berjalan otomatis; agregat historis tetap utuh setelah post mentahnya dihapus.

---

### 5.3 NLP (FR-3xx)

#### FR-301 — Klasifikasi sentimen
Tiga kelas: `positive`, `neutral`, `negative`. Wajib untuk semua post.
**Acceptance:** minimal 85% macro-F1 pada gold set berlabel manual (bagian 10); latensi <5 menit dari ingest sampai terklasifikasi.

#### FR-302 — Confidence score
Tiap klasifikasi menyertakan confidence 0–1. Hasil di bawah ambang masuk antrean review.
**Acceptance:** confidence terkalibrasi — post dengan confidence di atas 0,9 akurasinya harus di atas 95% pada gold set.

#### FR-303 — Label store untuk training
Setiap inference ditulis ke `nlp_labels`: teks, label, confidence, versi model, timestamp.
**Acceptance:** setelah 1 bulan operasi, tabel bisa diekspor jadi dataset training yang valid tanpa transformasi manual.
**Kenapa penting:** ini yang bikin migrasi ke model self-host (Fase 4) jadi mungkin. Tanpa ini, harus melabeli dari nol.

#### FR-304 — Ekstraksi isu (word cloud)
Ekstrak frasa bermakna (bigram/trigram) berbobot TF-IDF untuk panel Issues.
**Acceptance:** frasa yang dihasilkan mirip contoh referensi — "gedung dpr", "penanganan bencana", "elemen mahasiswa" (`Screenshot_1.png`) — bukan token tunggal seperti "dpr" atau "yang".

#### FR-305 — Ekstraksi hashtag & entity
Hashtag, mention, URL, dan named entity (orang, organisasi, lokasi).
**Acceptance:** hashtag ternormalisasi case-insensitive; `#Kopdes` dan `#kopdes` dihitung sebagai satu.

#### FR-306 — Preprocessing Bahasa Indonesia
Normalisasi bahasa gaul/alay, stemming, penghapusan stopword, deteksi bahasa.
**Acceptance:** "gk", "ga", "nggak", "engga" ternormalisasi ke bentuk yang sama; kualitas word cloud terukur membaik dibanding tanpa normalisasi.

#### FR-307 — Evaluasi akurasi
Gold set 1.000 post berlabel manual, plus harness evaluasi yang bisa dijalankan berulang.
**Acceptance:** `make eval` mengeluarkan macro-F1, confusion matrix, dan breakdown per platform.

---

### 5.4 Dashboard (FR-4xx)
> Referensi: `Screenshot_13.png`, `Screenshot_1.png`, `Screenshot_2.png`, `Screenshot_3.png`

#### FR-401 — Filter global
Topic selector, rentang waktu (Hari/Minggu/Bulan/kustom), platform selector. Filter berlaku ke semua panel di halaman.
**Acceptance:** ganti filter maka semua panel update dari satu kali fetch, bukan satu request per panel; state filter tersimpan di URL supaya bisa di-bookmark dan dibagikan.

#### FR-402 — Refresh interval 5m–1h
Dropdown: 5m, 15m, 30m, 45m, 1h (`Screenshot_13.png`). Mengontrol auto-refresh UI dan prioritas penjadwalan collector.
**Acceptance:** memilih 5m memicu refresh UI tiap 5 menit; indikator menunjukkan waktu update terakhir; pilihan tersimpan per user.

#### FR-403 — Panel Exposure
Area chart bertumpuk, volume post per platform sepanjang waktu, dengan legend berkode warna.
**Acceptance:** cocok dengan `Screenshot_1.png`; klik legend menyembunyikan atau menampilkan platform; hover memunculkan tooltip nilai per hari.

#### FR-404 — Panel Issues (word cloud)
Word cloud frasa dari FR-304, ukuran mengikuti frekuensi.
**Acceptance:** cocok dengan `Screenshot_1.png`; klik frasa memfilter tampilan post.

#### FR-405 — Engagements History
Line chart total engagement sepanjang waktu.
**Acceptance:** cocok dengan `Screenshot_2.png`; engagement = like + share + comment + view, dengan bobot terdokumentasi.

#### FR-406 — Issue Engagement
Word cloud frasa berbobot engagement, bukan berbobot frekuensi.
**Acceptance:** cocok dengan `Screenshot_2.png`; hasilnya jelas berbeda dari FR-404 — isu jarang tapi viral harus tampil besar di sini.

#### FR-407 — Total Posts & Replies
Jumlah per platform, dipisah antara post dan reply.
**Acceptance:** cocok dengan `Screenshot_2.png`; angka konsisten dengan total Exposure pada rentang yang sama.

#### FR-408 — Topic Location
Peta choropleth Indonesia plus daftar provinsi terurut menurun.
**Acceptance:** cocok dengan `Screenshot_2.png`; provinsi tanpa data tetap terlihat (abu-abu), tidak hilang dari peta.

#### FR-409 — Sentiment Proportion di dashboard
Ringkasan pie plus timeline, versi ringkas dari modul Sentiment.
**Acceptance:** cocok dengan `Screenshot_3.png`; angka identik dengan halaman Sentiment pada filter yang sama.

---

### 5.5 Modul Sentiment (FR-5xx)
> Referensi: `Screenshot_8.png`, `Screenshot_10.png`

#### FR-501 — Sentiment Timeline
Line chart tiga seri (positive/neutral/negative) sepanjang waktu.
**Acceptance:** cocok dengan `Screenshot_8.png`.

#### FR-502 — Sentiment Proportion
Pie chart dengan persentase.
**Acceptance:** cocok dengan `Screenshot_8.png`; persentase dibulatkan 2 desimal dan totalnya 100%.

#### FR-503 — Sentiment Timeline Feed
Tiga kolom (Neutral / Negative / Positive), tiap kolom berisi post: avatar, nama penulis, timestamp, teks, thumbnail media.
**Acceptance:** cocok dengan `Screenshot_8.png`; infinite scroll; klik post membuka aslinya di platform.

#### FR-504 — Sentiment by Engagement
Timeline dan pie tapi berbobot engagement, bukan jumlah post.
**Acceptance:** cocok dengan `Screenshot_3.png`.
**Catatan:** di data referensi, negatif adalah 82% dari post tapi hanya 11% dari engagement. Selisih ini justru insight penting — pastikan panel ini tidak diperlakukan sebagai duplikat FR-502.

#### FR-505 — Positive/Negative Text Cloud
Word cloud terpisah untuk post positif dan negatif.
**Acceptance:** cocok dengan `Screenshot_10.png`.

#### FR-506 — Positive/Negative Hashtag Cloud
Sama seperti di atas, untuk hashtag.
**Acceptance:** cocok dengan `Screenshot_10.png`.

#### FR-507 — Positive/Negative Account List
Akun yang paling banyak berkontribusi ke tiap sentimen.
**Acceptance:** cocok dengan `Screenshot_10.png`; menampilkan handle, jumlah post, dan total engagement.

---

### 5.6 Auth & RBAC (FR-6xx)

#### FR-601 — Autentikasi
Login email dan password, sesi ber-expiry, logout.
**Acceptance:** sesi kedaluwarsa setelah 8 jam tidak aktif; password di-hash dengan Argon2id.

#### FR-602 — RBAC
Tiga role: **admin** (semua), **analis** (lihat semua topic, tidak bisa ubah topic atau user), **viewer** (lihat topic yang ditugaskan saja).
**Acceptance:** viewer yang mengakses topic tak berizin lewat URL langsung mendapat 403, bukan halaman kosong.

#### FR-603 — Audit log
Catat perubahan topic, perubahan user, dan login.
**Acceptance:** log tidak bisa diubah dari aplikasi; menyimpan aktor, aksi, timestamp, dan nilai sebelum serta sesudah.

---

### 5.7 Cost Guard & Observability (FR-7xx)

#### FR-701 — Cost accounting
Tiap panggilan provider mencatat biayanya. Biaya diatribusikan ke stream, lalu dialokasikan ke topic secara proporsional.
**Acceptance:** total biaya tercatat cocok dengan tagihan provider dalam selisih maksimal 5%.

#### FR-702 — Budget cap & throttle
Cap bulanan per topic dan global. Alert di 80%, throttle otomatis di 100%.
**Acceptance:** mencapai 100% cap akan menurunkan interval polling ke maksimum dan mengirim alert; **tidak** menghentikan ingestion sepenuhnya — data parsial lebih berguna daripada tidak ada data.

#### FR-703 — Observability
Structured log dengan correlation ID, metrik Prometheus, health endpoint, alert kegagalan pipeline.
**Acceptance:** kegagalan adapter memicu alert dalam 5 menit; correlation ID bisa dilacak dari request UI sampai panggilan provider.

---

## 6. Requirement Non-Fungsional

| ID | Requirement | Target | Cara verifikasi |
|---|---|---|---|
| NFR-01 | Latensi load dashboard | p95 <2 dtk pada korpus 1 juta post | k6 load test |
| NFR-02 | Lag ingestion | p95 <5 mnt dari post terbit ke tampil | Timestamp end-to-end |
| NFR-03 | Akurasi sentimen | minimal 85% macro-F1 | Gold set (FR-307) |
| NFR-04 | Uptime | 99% jam kerja (07:00–22:00 WIB) | Uptime monitor |
| NFR-05 | Skala korpus | 10 juta post tanpa penurunan kinerja | Load test data sintetis |
| NFR-06 | Retensi | Mentah 12 bln, agregat selamanya | Kebijakan ISM |
| NFR-07 | Biaya | maksimal $400/bln untuk 30 topic | Dashboard biaya (FR-701) |
| NFR-08 | Concurrent user | 20 tanpa penurunan | Load test |

---

## 7. Arsitektur Sistem

Detail lengkap: [ARCHITECTURE.md](docs/ARCHITECTURE.md). Ringkasnya:

```
Next.js 15 (dashboard + BFF)
        |
FastAPI (analytics & admin API)
        |
   +----+-----+
PostgreSQL   OpenSearch
(config,     (post, percolator,
 label,       agregasi)
 audit)           ^
                  |
     Celery workers + Redis + Beat
     collect -> normalize -> percolate
             -> enrich -> aggregate
                  |
        SourceAdapter registry
   X · IG · TikTok · FB · Threads · YT
```

### Keputusan arsitektur kunci

| Keputusan | Alasan |
|---|---|
| OpenSearch percolator untuk routing topic | Memisahkan biaya routing dari jumlah topic — satu panggilan percolate per batch, bukan N pencarian per post |
| Provider adapter di balik satu interface | Provider scraping bisa mati sewaktu-waktu; ganti vendor tanpa sentuh business logic |
| Python untuk worker, TypeScript untuk web | Ekosistem NLP Indonesia (IndoBERT, Sastrawi) hanya ada di Python |
| Postgres plus OpenSearch, bukan salah satu saja | Postgres untuk data relasional yang butuh konsistensi; OpenSearch untuk pencarian teks dan agregasi |
| Label store sejak hari pertama | Data training tidak bisa dibuat surut. Kalau tidak dicatat sejak awal, Fase 4 harus melabeli dari nol |

---

## 8. Data Model

### 8.1 Unified Post Schema

Field yang tidak tersedia di suatu platform bernilai `null`, bukan `0` atau `""` — pembedaan "tidak ada data" versus "nilainya nol" ini penting supaya agregasi tidak bias.

```
Post
  id                  uuid                 PK internal
  platform            enum                 twitter|instagram|tiktok|facebook|threads|youtube
  platform_post_id    string               ID asli dari platform
  post_type           enum                 post|reply|comment|repost|quote
  parent_post_id      string?              untuk reply/comment
  url                 string
  text                text
  text_normalized     text                 hasil FR-306
  lang                string               ISO 639-1
  lang_confidence     float
  created_at          timestamptz          waktu terbit di platform
  collected_at        timestamptz          waktu masuk sistem
  author              Author               nested
  metrics             Metrics              nested
  media               Media[]
  hashtags            string[]
  mentions            string[]
  urls                string[]
  entities            Entity[]
  location_raw        string?
  location_province   string?              hasil FR-207
  nlp                 NlpResult            nested
  matched_topics      uuid[]               hasil percolator
  stream_id           uuid                 asal collection stream
  raw_payload_ref     string               pointer object storage

Author
  platform_user_id, username, display_name, avatar_url,
  followers_count?, following_count?, posts_count?,
  verified?, account_created_at?, bio?

Metrics
  likes?, shares?, comments?, views?, quotes?, saves?,
  engagement_total       int      dihitung, bobot terdokumentasi

NlpResult
  sentiment              enum     positive|neutral|negative
  sentiment_confidence   float
  model_version          string
  issues                 string[] frasa dari FR-304
  processed_at           timestamptz
```

### 8.2 Entitas Konfigurasi (PostgreSQL)

```
Topic         id, name, description, platforms[], taxonomy_type,
              taxonomy_tags[], filter_ads, is_active, created_by, timestamps
Query         id, topic_id, query_string, languages[], keywords[],
              media_tags[], not_media_tags[], is_valid, validation_error
DemographyFilter  id, topic_id, config jsonb            (Fase 1: simpan saja)
CollectionStream  id, keywords[], platforms[], base_interval,
                  current_interval, last_cursor jsonb, is_active
StreamTopicLink   stream_id, topic_id                   (many-to-many)
NlpLabel      id, post_id, text, label, confidence, model_version,
              is_human_verified, created_at             <- korpus training
CostRecord    id, stream_id, provider, unit_count, unit_cost,
              total_cost, occurred_at
User          id, email, password_hash, role, is_active, timestamps
UserTopic     user_id, topic_id                         (scope viewer)
AuditLog      id, actor_id, action, entity_type, entity_id,
              before jsonb, after jsonb, created_at
```

---

## 9. Baseline Volume & Ekonomi

Diturunkan dari topic referensi "PERMASALAHAN KDMP", 1 minggu (`Screenshot_2.png`):

| Platform | Post | Reply |
|---|---:|---:|
| Twitter | 12.763 | 6 |
| Threads | 929 | — |
| TikTok | 266 | 131 |
| Facebook | 34 | — |
| Instagram | 24 | 133 |
| YouTube | 17 | — |
| **Total** | **14.033** | **270** |

Sekitar **14.300 post per minggu, atau 60.000 per bulan** untuk satu topic yang sedang ramai. Ini definisi "topic sedang" yang dipakai di seluruh dokumen.

**Ringkasan biaya** (rincian: [COST-MODEL.md](docs/COST-MODEL.md)):

| Skenario | Total/bln | Per topic/bln |
|---|---:|---:|
| 1 topic (pilot) | $94–149 | Rp 1,55–2,45 jt |
| 30 topic, stream bersama | $345 | **Rp 190 rb** |
| 30 topic, NLP self-host (Fase 4) | $275 | **Rp 151 rb** |
| 108 topic, stream bersama | $699 | **Rp 107 rb** |
| 30 topic, tanpa stream bersama — *pembanding* | $465 | Rp 256 rb |
| 30 topic, tanpa fetch inkremental — *pembanding* | $4.385 | Rp 2,41 jt |

Dua baris terakhir adalah alasan keberadaan FR-202 dan FR-204. Perhatikan juga bahwa biaya per topic **turun** seiring jumlah topic bertambah — konsekuensi langsung dari desain stream bersama.

---

## 10. Strategi Kualitas NLP

### Fase 1 — LLM sebagai teacher
Klasifikasi lewat Claude Haiku 4.5 dengan batching, prompt caching, dan structured output. Sekitar $0,20 per 1.000 post. Setiap hasil ditulis ke `nlp_labels` (FR-303).

### Gold set
1.000 post dilabeli manual, stratified berdasarkan platform dan sentimen, minimal 2 annotator dengan resolusi ketidaksepakatan. Jadi tolok ukur tetap untuk semua perubahan model.

### Fase 4 — distilasi ke model self-host
Setelah sekitar 100K labeled example (kira-kira 3 bulan operasi normal), fine-tune IndoBERT untuk sentimen. Biaya: sekitar $4 sekali jalan (sewa GPU 2 jam). Inference jalan di CPU pada 20–50 post per detik — 400K post per bulan hanya butuh sekitar 4 jam CPU time, jadi **produksi tidak butuh GPU**.

Switchover pakai A/B: model self-host harus menyamai atau melampaui akurasi LLM pada gold set sebelum jadi jalur utama. LLM tetap dipakai untuk post low-confidence dan audit berkala.

**Manfaat lain:** model self-host memungkinkan deployment on-premise atau air-gapped, yang bisa jadi syarat wajib untuk klien instansi pemerintah.

---

## 11. Risiko & Mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| Provider scraping mati atau diblokir | Tinggi | Interface adapter memungkinkan ganti vendor dalam hitungan hari; minimal 2 provider teridentifikasi per platform ([DATA-SOURCES.md](docs/DATA-SOURCES.md)) |
| Perubahan ToS platform | Sedang | Hanya konten publik; tidak menyimpan data pribadi di luar kebutuhan; retensi 12 bulan |
| **Kepatuhan UU PDP** | **Tinggi** | Analisis level agregat; minimisasi data pribadi; retensi terbatas; audit log; hak penghapusan. Perlu review hukum sebelum produksi |
| Akurasi buruk pada bahasa gaul | Tinggi | Normalisasi (FR-306) plus gold set plus review low-confidence plus flywheel training |
| Biaya membengkak | Tinggi | FR-202 (stream bersama), FR-107 (preview), FR-702 (cap) — tiga lapis pengaman |
| Harga provider naik | Sedang | Adapter memudahkan pindah; model biaya di-review tiap kuartal |
| Volume viral membanjiri sistem | Sedang | Rate limit di sisi kita, antrean dengan backpressure, throttle otomatis |

**Catatan soal UU PDP:** produk ini memproses konten publik dan metadata penulis. Meski data publik umumnya di luar cakupan terketat UU PDP, kombinasi profiling, retensi, dan inferensi demografi (Fase 3) memindahkannya ke wilayah yang perlu kehati-hatian. Rekomendasi: review hukum sebelum go-live, bukan sesudah.

---

## 12. Kriteria Sukses Fase 1

Fase 1 dinyatakan selesai kalau semuanya terpenuhi:

1. Admin bisa membuat topic dengan boolean query, mem-preview, dan menyimpannya
2. Sistem mengumpulkan dari 6 platform secara berkelanjutan pada interval terpilih
3. Semua post terklasifikasi sentimennya dalam 5 menit sejak ingest
4. Dashboard menampilkan 7 panel (FR-403 sampai FR-409) dengan data akurat
5. Halaman Sentiment menampilkan 7 panel (FR-501 sampai FR-507)
6. Macro-F1 minimal 85% pada gold set
7. Biaya maksimal $400 per bulan untuk 30 topic, terverifikasi lewat dashboard biaya
8. Tiga role berfungsi dengan pembatasan akses yang benar
9. `nlp_labels` berisi minimal 30.000 contoh siap training

---

## 13. Pertanyaan Terbuka

Tidak menghalangi Fase 1, tapi perlu jawaban sebelum fase berikutnya:

| # | Pertanyaan | Perlu dijawab sebelum |
|---|---|---|
| Q1 | Deployment: cloud VPS atau on-premise? | T-002 (setup infra) |
| Q2 | Butuh SSO atau LDAP untuk integrasi instansi? | T-064 (auth) |
| Q3 | Perlu simpan salinan media (gambar/video) atau cukup hotlink? | T-021 (normalizer) — berdampak besar ke biaya storage |
| Q4 | Berapa target jumlah topic di 6 bulan pertama? | Sizing kapasitas |
| Q5 | Ada requirement audit atau sertifikasi dari klien? | Fase 4 |
