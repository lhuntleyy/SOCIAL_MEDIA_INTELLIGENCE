# PRD — Social Media Intelligence Platform (SMIP)

| Field | Value |
|---|---|
| Status | Draft v0.4 |
| Tanggal | 2026-09-28 (v0.1: 2026-09-27) |
| Runtime utama | Bun (TypeScript) + Python worker terisolasi untuk library non-JS |
| Dokumen turunan | ARCHITECTURE.md → … → CHANGELOG.md |

---

## 1. Latar Belakang

Tim analis perlu memantau percakapan publik di media sosial per **topik** (contoh: "DEMO 27", "MUKTAMAR NU", "PERMASALAHAN KDMP") secara mendekati real-time, lalu melihat:

- volume/exposure per platform per waktu,
- proporsi & timeline sentiment (positive / neutral / negative),
- isu dominan (word cloud / keyphrase),
- engagement,
- akun paling aktif (post, reply, retweet/repost),
- lokasi (provinsi),
- umur akun (tahun pembuatan akun),
- feed post per sentiment.

Masalah dengan pendekatan "satu API per platform":

1. Official API tiap platform punya **batasan akses berbeda** (sebagian tidak menyediakan pencarian keyword publik sama sekali).
2. Third-party (Apify actor, dsb.) dan unofficial library (instagrapi, dsb.) **bisa berubah/rusak kapan saja**.
3. Biaya & kuota berbeda per provider, sehingga butuh kontrol biaya.

Maka platform harus **provider-agnostic**: banyak provider per platform, dipilih otomatis, dengan failover.

## 2. Tujuan

| ID | Tujuan | Ukuran keberhasilan |
|---|---|---|
| G1 | Ingest multi-platform, multi-provider dengan failover otomatis | Saat provider primer down, data tetap masuk via provider cadangan tanpa deploy ulang |
| G2 | Refresh multi-timeframe (5m, 15m, 30m, 45m, 1h) per topik per platform | Data freshness p95 ≤ interval + batas toleransi (lihat NFR-02) |
| G3 | Sentiment analysis Bahasa Indonesia (termasuk slang/campur Inggris) | Macro-F1 pada gold set internal ≥ target yang ditetapkan setelah baseline (lihat AI_SPEC §6) |
| G4 | Dashboard analytics cepat | p95 query dashboard ≤ 1.5s untuk range 7 hari |
| G5 | Multi-tenant aman | Tidak ada kebocoran data antar tenant (diuji otomatis) |
| G6 | Penambahan platform/provider baru tanpa ubah core | Platform baru = tambah connector + row config, 0 perubahan di `packages/core` |

## 3. Non-Goals (v1)

- Posting/publishing ke media sosial.
- Membaca konten privat (DM, akun privat, grup tertutup).
- **Menampilkan** label gender/umur/psikografi **per individu** di feed. Psychography (gender & age range) **diimplementasikan** tetapi **hanya sebagai agregat** dengan coverage + confidence (FR-A07/A08, AI_SPEC §12, SECURITY §9, ADR-007).
- Inferensi atribut sensitif individu (agama, etnis, orientasi politik/seksual, kesehatan) — **batas keras, tidak dilakukan**.

**Anti-goals (terlihat masuk akal, tapi sengaja ditolak):**
- **Klasifikasi realtime < 1 menit.** Provider polling tidak lebih cepat; optimasi NLP tak menolong kalau datanya belum ada.
- **Prediksi viral.** Ekspektasi akurasi yang tak bisa dipenuhi → jalan pintas ke kepercayaan yang salah tempat.
- **Skor sentimen otomatis per individu.** Melewati batas dari *analisis isu* menjadi *pemantauan orang* — pergeseran tujuan produk, bukan sekadar risiko hukum. (Berbeda dari agregat gender/age yang aggregate-only.)
- **Dukung setiap platform yang ada.** Tiap platform = adapter yang harus dipelihara. Enam yang dipakai orang (MVP: X, Instagram, Facebook, Threads, TikTok, YouTube) > dua belas yang setengah jalan. Bluesky & Reddit ada di registry tapi baru diaktifkan bila ada kebutuhan nyata (Fase 6).
- **Teknik menghindari deteksi anti-bot (bypass captcha, fingerprint spoofing).** Kalau provider di-block → **failover**, bukan melawan blokir (juga SECURITY §9, AGENTS.md).

## 4. Persona

| Persona | Kebutuhan |
|---|---|
| **Analyst** | Buat topik, lihat dashboard, koreksi sentiment, export |
| **Tenant Admin** | Kelola user tenant, kuota, topik, credential milik tenant (BYO key) |
| **Platform Operator (superadmin)** | Kelola provider, connector, routing policy, health, biaya global |
| **Viewer** | Hanya melihat dashboard |

## 5. Glossary

| Istilah | Arti |
|---|---|
| **Platform** | Sumber media sosial: `x`, `instagram`, `facebook`, `threads`, `tiktok`, `youtube`, `bluesky`, `reddit`, … |
| **Provider** | Penyedia akses data: official API (mis. Meta Graph), third-party (mis. Apify), unofficial (mis. instagrapi) |
| **Connector** | Implementasi kode untuk satu provider × satu platform (mis. `apify.instagram`), punya manifest capability |
| **Operation** | Jenis pengambilan data: `search_keyword`, `search_hashtag`, `user_timeline`, `post_comments`, `post_detail`, `profile` |
| **Provider Account** | Satu set credential untuk provider (API key, token, session) + rate limit + quota-nya |
| **Routing Policy** | Aturan memilih connector untuk (tenant, platform, operation): priority, weight, failover |
| **Topic** | Unit monitoring milik tenant, berisi query boolean |
| **Crawl Plan** | Jadwal: topic_query × platform × operation × interval |
| **Crawl Run** | Satu eksekusi crawl plan |
| **Canonical Item** | Post/comment yang sudah dinormalisasi ke schema tunggal |
| **Topic Match** | Relasi post ↔ topic milik tenant (post disimpan global, match per tenant) |

## 6. Functional Requirements

### 6.1 Topic Management
- **FR-T01** CRUD topik: name, description, author, platforms, taxonomy type (Interest/Industry), taxonomy tags, filter ads (Y/N).
- **FR-T02** Query list: satu **main query** + nol atau lebih **sub query**. Tiap query berisi: (a) ekspresi **boolean** `"frasa"`, `OR`, `AND`, `NOT`/`-`, kurung; (b) **keyword** sederhana (di-OR-kan); (c) **media_tags / not_media_tags**; (d) **languages** yang diterima (`id`/`en`/`ms`) dan platform opsional. (Sesuai tab "Query Lists" produk.)
- **FR-T03** Query di-parse menjadi AST, divalidasi, dan bisa di-**preview** (contoh match dari data yang sudah ada + estimasi volume).
- **FR-T04** Refresh interval per topik per platform: `5m | 15m | 30m | 45m | 1h` (dibatasi plan tenant dan capability connector) — samakan dengan produk (screenshot 13).
- **FR-T05** **Cost estimate** sebelum simpan: estimasi **hasil/hari × tarif + request/hari × tarif minimum per request** per platform & dampak kuota (rumus CONNECTOR_SPEC §5); ditolak jika melebihi hard quota tenant.
- **FR-T06** Pause/resume/archive topik. Backfill manual untuk rentang waktu tertentu (queue prioritas rendah).
- **FR-T07** List topik dengan search, sort asc/desc, filter by type, paginasi (lihat screenshot "ALL TOPIC").

### 6.2 Ingestion
- **FR-I01** Scheduler membuat crawl run saat `next_run_at` tercapai; tidak boleh ada 2 run aktif untuk plan yang sama (coalescing).
- **FR-I02** Incremental crawl berbasis high-watermark (`since`) dengan overlap window yang dapat dikonfigurasi; dedupe menjamin tidak ada duplikasi.
- **FR-I03** Raw payload diarsipkan (S3-compatible) dengan retensi terkonfigurasi.
- **FR-I04** Normalisasi ke Canonical Item; field yang tidak disediakan provider = `null` (**bukan 0**).
- **FR-I05** Local matcher: setiap item dicek ulang terhadap AST topik agar semantik query konsisten antar provider.
- **FR-I06** Engagement refresh: post dalam N jam terakhir di-refresh metrik engagement-nya (jika capability tersedia).
- **FR-I07** Filter ads bila provider memberi sinyal iklan; jika tidak ada sinyal, `is_ad = null`.

### 6.3 Provider Management (inti)
Setiap provider/connector/account **harus bisa**:

| Kemampuan | Implementasi |
|---|---|
| Diaktifkan / dinonaktifkan | `enabled` di `providers`, `connectors`, `provider_accounts`, `routing_rules` (hierarki: semua harus true) |
| Diberi priority | `routing_rules.priority` (angka kecil = dicoba dulu) |
| Diberi weight | `routing_rules.weight` — distribusi traffic dalam satu priority group |
| Di-health-check | Active probe terjadwal + passive (dari hasil call nyata) + circuit breaker |
| Diberi rate limit | `rate_limit_policies` (token bucket di Redis), level provider/connector/account |
| Diberi quota | `quota_policies` per hari/bulan, unit requests/results/cost_units, hard/soft |
| Diganti tanpa ubah business logic | Business layer hanya memanggil port `ProviderRouter.plan(platform, operation, …)` / `reportOutcome()` (CONNECTOR_SPEC §6.1) |

- **FR-P01** Admin UI untuk semua di atas + audit log setiap perubahan.
- **FR-P02** Perubahan config berlaku ≤ 30 detik tanpa restart (via outbox event → invalidate cache).
- **FR-P03** Failover otomatis berdasarkan klasifikasi error (lihat CONNECTOR_SPEC §7).
- **FR-P04** Capability connector punya status `declared | verified | failed`; hanya `verified` yang dipakai di produksi (override eksplisit per policy dengan flag `allow_unverified`, tercatat di audit).
- **FR-P05** Usage ledger per call: connector, account, durasi, outcome, item count, cost units.
- **FR-P06** Tenant dapat memakai **shared pool** milik operator atau **BYO credential** sendiri.

### 6.4 Enrichment / AI
- **FR-A01** Deteksi bahasa.
- **FR-A02** Sentiment 3 kelas + skor confidence + versi model.
- **FR-A03** Issue/keyphrase extraction (untuk word cloud "ISSUES" dan "ISSUE ENGAGEMENT").
- **FR-A04** Geo inference ke provinsi Indonesia (dari geotag/lokasi profil), dengan confidence.
- **FR-A05** Koreksi sentiment manual oleh analyst → mengubah agregat + masuk dataset training.
- **FR-A06** Reprocessing historis saat model baru diaktifkan (batch, prioritas rendah).
- **FR-A07** Emotion/Perception: 8 emosi Plutchik + score + versi model (widget Perception Stream/Radar/by-Engagement).
- **FR-A08** Gender inference per akun (male/female/unknown + confidence) — **agregat saja**, coverage ditampilkan (AI_SPEC §12, SECURITY §9).
- **FR-A09** Age range inference per akun (below_18…above_55/unknown + confidence) — **agregat saja**, coverage ditampilkan.

### 6.5 Analytics & Dashboard
Semua widget di screenshot (detail di UI_SPEC):
- **Dashboard (ISA)**: Exposure, Issues (word cloud), Engagements History, Issue Engagement, Total Posts, Total Replies, Topic Location (peta provinsi + daftar), Hashtags (treemap).
- **Conversation**: Chronology, Gallery, Issues, Engagement, **Emotion** (Perception Stream/Radar/by-Engagement), **Sentiment** (Timeline, Proportion, by-Engagement, feed 3 kolom), Contributors, Issues Comparison.
- **Audience**: Account creation year, Posts per hari, Total Posts Comparison, Most Reposted Accounts, Top accounts (posts, comment/reply, retweet/repost), Active accounts.
- **Psychography**: Sentiment by Gender, Sentiment by Age Range, breakdown per-sentiment (Timeline/Text Cloud/Account/Hashtag Cloud) — agregat + coverage.
- **Resume**: overview/ringkasan KPI (konfirmasi isi persis dengan pemilik produk).
- Filter global: topic, periode (Day/Week/Month/Custom), platform, auto-refresh (5m/15m/30m/45m/1h), search.
- **FR-D01** Granularity otomatis: ≤ 2 hari → 5m/1h, ≤ 90 hari → 1h/1d, > 90 hari → 1d.
- **FR-D04** Semua widget gender/age/emotion menampilkan `coverage_pct`; bucket `unknown` tidak disembunyikan.
- **FR-D02** Realtime update via SSE saat agregat topik berubah.
- **FR-D03** Export CSV/XLSX (async job).

### 6.6 Alerting
- **FR-AL01** Rule: volume spike (z-score vs baseline), negative ratio > X%, keyword baru muncul, provider unhealthy, quota ≥ threshold.
- **FR-AL02** Channel: email, webhook, Telegram (via connector notifikasi—abstraksi sama).

### 6.7 Multi-tenancy & Akses
- **FR-M01** Semua data OLTP ber-`tenant_id` dengan Row Level Security.
- **FR-M02** RBAC: `owner`, `admin`, `analyst`, `viewer`; global role `platform_operator`.
- **FR-M03** Plan tenant: max topics, min interval, monthly fetch budget, retensi data.

## 7. Non-Functional Requirements

| ID | Kategori | Requirement |
|---|---|---|
| NFR-01 | Skalabilitas | Worker scale horizontal berbasis queue depth; target awal 500 topik aktif × 4 platform @15m (angka dikalibrasi ulang setelah load test) |
| NFR-02 | Freshness | p95 (waktu tersedia di dashboard − waktu jadwal run) ≤ interval × 1 + waktu eksekusi provider terukur; dipantau per connector |
| NFR-03 | Availability | API 99.5% (v1); ingest degrade gracefully (tidak ada data loss saat provider down, hanya delay) |
| NFR-04 | Latensi dashboard | p95 ≤ 1.5s range 7 hari, ≤ 3s range 90 hari |
| NFR-05 | Keamanan | Credential terenkripsi (envelope), audit log append-only, RLS |
| NFR-06 | Observability | Trace end-to-end dari scheduler → fetch → AI → sink |
| NFR-07 | Portabilitas | Semua service jalan di Docker; tidak bergantung vendor cloud tertentu |
| NFR-08 | Extensibility | Platform/provider baru tanpa ubah `packages/core` |
| NFR-09 | Cost control | Hard quota mencegah overspend; estimasi biaya sebelum aktivasi topik |
| NFR-10 | Compliance | Retensi & penghapusan data sesuai kebijakan; pencatatan dasar pemrosesan (UU PDP No. 27/2022) |

## 8. Asumsi & Risiko

| Risiko | Dampak | Mitigasi |
|---|---|---|
| Unofficial API melanggar ToS platform / akun di-ban | Data hilang, risiko hukum | Prioritas terendah, akun khusus (bukan akun pribadi), isolasi worker, review legal, bisa dimatikan 1 klik |
| Third-party actor berubah output schema | Parse error | Contract test harian dengan fixture + canary; error `PARSE_ERROR` → failover |
| Biaya provider membengkak pada interval 5m | Overspend (termasuk biaya minimum per request walau hasil kosong) | Cost estimate hasil+request, hard quota, `min_interval_sec` per capability yang **diukur** |
| Provider utama X (twitterapi.io) = pihak ketiga tanpa afiliasi X Corp | Layanan berhenti/berubah mendadak; risiko ToS | Cadangan Apify + X official di routing (PROVIDER_MATRIX §4a), review legal S-15 |
| Latensi provider > interval | Run menumpuk | Coalescing (skip run jika run sebelumnya belum selesai) + metric `crawl_skipped_total` |
| Kompatibilitas npm package dengan Bun | Runtime error | Spike fase 0 + compat matrix di ADR-001 |
| Akurasi sentiment rendah untuk slang/sarkasme | Insight menyesatkan | Gold set domain, LLM fallback low-confidence, koreksi manual |

## 9. Rilis Bertahap

| Fase | Isi |
|---|---|
| **0 – Spike** | Verifikasi kompatibilitas Bun, verifikasi fakta provider (PROVIDER_MATRIX), baseline sentiment |
| **1 – Foundation** | Monorepo, DB, auth, tenant, queue, CI; connector `fake` (connector nyata pertama = twitterapi.io di Fase 2, I-17) |
| **2 – Ingest MVP** | 6 platform: X (twitterapi.io) + Instagram + Facebook + Threads + TikTok + YouTube (via provider terverifikasi), dedupe, sink ClickHouse, cost guard |
| **3 – AI & Dashboard** | Sentiment, **emotion (8 emosi)**, issues, hashtags, geo, **psychography (gender+age, agregat)**, semua section (Dashboard/Conversation/Audience/Psychography/Resume), SSE |
| **4 – Provider Ops** | Admin provider lengkap, health, quota, cost, alert |
| **5 – Hardening** | Load test, security review, DR drill, dokumentasi runbook |
| **6 – Expansion** | Connector Bluesky & Reddit (sudah di registry, `enabled=false`), alerting lanjutan, target-aware sentiment, issue clustering |
