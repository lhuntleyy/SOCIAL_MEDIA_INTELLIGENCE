# COST MODEL

Model biaya operasi platform. **Semua angka di dokumen ini adalah estimasi** (per September 2026); hanya yang bertanda **DOCS** sudah dicek ke halaman resmi provider — tiap tarif punya `source_ref` di §10 dan **wajib diverifikasi ulang sebelum committing budget** (tarif scraping berubah sering). Angka final yang dipakai routing produksi tetap tinggal di [PROVIDER_MATRIX.md](PROVIDER_MATRIX.md) dengan status verifikasi.

> **2026-10-01 — lihat §11 lebih dulu.** §11 menghitung ulang dari biaya Apify **terukur** (run final) dan menemukan asumsi overhead
> 1,25× (§3) tidak berlaku untuk actor dengan filter waktu per-hari (Threads/TikTok/FB/IG): tiap poll menagih ulang post 24 jam
> terakhir. Angka §5 di bawah = model v0.4 (belum memperhitungkan itu).

Kurs asumsi: **Rp 16.500 / USD**.

> Dokumen ini adalah sumber kebenaran untuk **angka biaya & asumsi ekonomi**. Kalau dokumen lain berbeda, dokumen ini yang benar (perbaiki yang lain). Untuk *kemampuan/rate limit provider* → PROVIDER_MATRIX. Untuk mekanisme quota/rate → CONNECTOR_SPEC §10–§11.

---

## 1. Baseline Volume

Diturunkan dari topic referensi "PERMASALAHAN KDMP", 1 minggu (`screenshots/Screenshot_2.png`, "Total Posts"/"Total Replies"):

| Platform | Post | Reply | Total | Porsi |
|---|---:|---:|---:|---:|
| X / Twitter | 12.763 | 6 | 12.769 | 89,28% |
| Threads | 929 | 0 | 929 | 6,49% |
| TikTok | 266 | 131 | 397 | 2,78% |
| Instagram | 24 | 133 | 157 | 1,10% |
| Facebook | 34 | 0 | 34 | 0,24% |
| YouTube | 17 | 0 | 17 | 0,12% |
| **Total** | | | **14.303** | 100% |

**≈ 14.303 post/minggu ⇒ ~60.000 post/bulan** untuk satu topic ramai. Porsi platform ini dipakai di semua perhitungan berikut.

Implikasi ekonomi penting: **X mendominasi ~89% volume tetapi tarifnya paling murah** ($0,15/1K vs $1,50–2,00/1K). Kalau sebaran terbalik, ekonomi produk jauh lebih berat.

---

## 2. Tarif Provider (estimasi bersumber — verifikasi!)

| Platform | Provider (estimasi) | Tarif/1K (est.) | Model penagihan | Sumber |
|---|---|---:|---|---|
| X / Twitter | twitterapi.io | $0,15 **(DOCS)** | pay-per-result + **minimum $0,00015/request walau kosong**, tanpa biaya bulanan | [§10](#10-sumber-harga), PROVIDER_MATRIX §6.1 |
| Instagram (keyword) | Apify scraping_solutions (boolean) | **$1,55 + $0,01/halaman (TESTED)** | pay-per-event, tanpa login | PROVIDER_MATRIX §2.0 |
| Instagram (hashtag, cadangan recall) | Apify apidojo | $0,47 (DOCS) | pay-per-result | PROVIDER_MATRIX §6.3 |
| TikTok | Apify apidojo/tiktok-scraper | **$0,30 (TESTED)** | pay-per-result | PROVIDER_MATRIX §2.0 |
| Facebook (keyword) | Apify scraper_one / scrapeforge | **$4,00 / $2,59 (TESTED, tier FREE)** | pay-per-event | PROVIDER_MATRIX §2.0 |
| Threads | Threads API official (bila App Review lolos) / Apify scrapersdelight | **$0 / $1,00 (DOCS)** | official: gratis, 2.200 query/24 jam; Apify: per post | PROVIDER_MATRIX §6.5 |
| YouTube | Data API v3 | gratis **(DOCS)** | **100 `search.list`/hari** (bucket sendiri) + 10.000 unit lain | PROVIDER_MATRIX §6.7 |
| TikTok/YouTube/Bluesky/Reddit lanjutan | lihat PROVIDER_MATRIX | — | Bluesky & Reddit API resmi gratis | [PROVIDER_MATRIX](PROVIDER_MATRIX.md) |

Biaya platform Apify **$29/bln dibayar sekali** untuk semua platform Apify — berat di skenario satu-topic, hampir tak terasa di 30+ topic.

> **`verified_at`:** semua baris di atas **DOCS** per 2026-09-28 (halaman resmi provider/actor; belum TESTED dengan tagihan nyata).
>
> **Dampak tarif terverifikasi ke skenario §5.2 (400K post/bln):** subtotal data $119,93 (v0.3) → **~$102** (Threads via Apify $1,00, IG $0,47) atau **~$76** bila Threads official lolos App Review. Skenario §5 di bawah **belum dihitung ulang** (sengaja: sebanding dengan dokumen pembanding); pakai angka ini untuk budget. Saat fase 0 selesai, angka final + `source_ref` + `verified_at` pindah ke PROVIDER_MATRIX dan `rate_limit_policies`/`quota_policies` (DATA_MODEL §4.8–§4.9). Sampai itu, angka di sini hanya untuk perencanaan, bukan routing.

---

## 3. Jebakan Polling (bagian paling penting)

**Provider menagih per hasil yang mereka kembalikan, bukan per hasil unik yang baru bagi kita.**

Collector naif yang polling tiap 5 menit dan menarik 100 hasil terbaru:

```
288 run/hari × 100 hasil = 28.800 hasil/hari DIBAYAR
Yang benar-benar baru ~2.000/hari
Pemborosan: ~14×
```

Perbaikannya = **fetch inkremental** (di kita: high-watermark `since` + overlap window, FR-I02; coalescing scheduler, QUEUE_SPEC §6). Efektivitas berbeda per platform:

| Platform | Mekanisme inkremental | Overhead |
|---|---|---:|
| X / Twitter | `since_time` (DOCS) / `since_id` (UNVERIFIED, S-14) | ~1,1× (overlap window) |
| YouTube | `publishedAfter` | ~1,1× |
| Threads, TikTok, IG, FB | filter timestamp + saring ID lokal | ~1,4× |
| **Rata-rata terbobot** | | **~1,25×** |

Rendah karena X mendominasi volume & punya cursor terbaik.

**Biaya minimum per request (X/twitterapi.io, DOCS).** Inkremental menurunkan hasil berbayar, tapi **tidak** membuat poll kosong gratis: tiap request minimal $0,00015. Komponen ini tidak bergantung volume, melainkan **jumlah stream × frekuensi × halaman**:

```
biaya_min_X/bln = Σ_stream (86400 / interval_sec) × 30 × halaman_rata2 × $0,00015
contoh: 50 stream @15m, 1 halaman  → 4.800 req/hari → ~$21,6/bln
        50 stream @5m,  1 halaman  → 14.400 req/hari → ~$64,8/bln
```

Karena itu cost estimate (FR-T05) wajib menjumlahkan **hasil × tarif + request × tarif minimum** (CONNECTOR_SPEC §5), dan 5m hanya untuk stream prioritas.

**Biaya tetap per run (actor Apify, diukur 2026-09-28).** Sama sifatnya dengan minimum per request: dibayar walau hasil 0, dikali frekuensi polling.

| Actor | Biaya tetap/run | 1 stream @15m (96 run/hari) | 1 stream @1h (24 run/hari) |
|---|---:|---:|---:|
| futurizerush Threads (paksa 4 GB) | $0,08 | **$7,68/hari (~$230/bln)** | $1,92/hari |
| crawlerbros IG keyword (1 GB) | $0,05 | $4,80/hari | $1,20/hari |
| scraping_solutions IG (≥ 1 halaman $0,01) | $0,01 | $0,96/hari | $0,24/hari |
| xquik / apidojo X, apidojo TikTok, scraper_one FB | ~$0 | ~$0 | ~$0 |

Konsekuensi: actor dengan start fee **hanya** untuk interval ≥ 1 jam atau sebagai cadangan; untuk polling rapat pilih actor tanpa start fee (scrapersdelight Threads, API official). Router memakai `measured.fixed_cost_per_run` di strategi `cost_aware` (CONNECTOR_SPEC §6.3). Klaim dokumen pembanding "run kedua pada stream tak berubah biayanya nol" **tidak berlaku** untuk twitterapi.io.

Untuk provider berbasis *run* (Apify) tanpa cursor sejati, tiga mitigasi digabung: (1) `maxItems` diketatkan (25–50/run), (2) interval lebih longgar (30m–1h, bukan 5m), (3) adaptive polling melambat saat stream sepi.

> **Menyaring duplikat setelah diterima menjaga kebersihan data tetapi TIDAK menghemat uang** — biaya sudah terjadi begitu provider mengembalikan hasil. Karena itu di kita `usage.results` = **hasil dikembalikan provider**, bukan yang tersimpan (CONNECTOR_SPEC §4a, PROVIDER_MATRIX). `min_interval_sec` yang **diukur** (DATA_MODEL §4.3) mencegah interval yang tak layak secara biaya.

---

## 4. Model Token NLP

Dipakai di semua perhitungan NLP di bawah.

**Input ~78 token/post:** teks post ~65 (post Indonesia rata-rata ~180 char) + framing/index ~10 + system prompt teramortisasi ~3 (prompt ~700 token **di-cache**, dibagi ~25 post/batch).

**Output ~25 token/post:** JSON ringkas, mis. `{"i":1,"s":"neg","c":0.92}`. Output berharga **5× input** ($5/M vs $1/M) → keringkasan output bernilai 5× keringkasan input; jangan verbose.

**Harga model (daftar harga Anthropic, cache skill 2026-06; cek ulang saat build — `GET /v1/models` memberi ID/kapabilitas, bukan harga):** Claude Haiku 4.5 (`claude-haiku-4-5`) $1/M input, $5/M output · Claude Sonnet 5 (`claude-sonnet-5`) $2/$10 · Claude Opus 5 (`claude-opus-5`) $5/$25. **Batch API** diskon 50% (turnaround ≤ 24 jam) — cocok untuk backfill/reprocess, **bukan** jalur realtime (freshness ≤ 5m). Emotion ditambahkan dalam **satu panggilan** bersama sentiment → +~15 token output/post (AI_SPEC §4A) → **~40 token output/post**. Skenario §5 di bawah masih memakai 25 token (sentiment saja) — lihat §4a untuk angka dengan emotion.

> **Jebakan thinking:** Claude Opus 5 menjalankan *adaptive thinking* secara default dan token thinking **ditagih sebagai output**. Untuk klasifikasi, set `output_config.effort: "low"` (atau `thinking: {type: "disabled"}`, diizinkan di Opus 5 pada effort ≤ high). Tanpa ini, biaya output bisa berlipat — ukur `usage.output_tokens` nyata di S-20.

## 4a. Dua jalur NLP — keputusan di S-20

COST_MODEL v0.3 diam-diam mengadopsi **jalur A** (dokumen pembanding), sedangkan AI_SPEC mendesain **jalur B**. Keduanya dihitung agar keputusan S-20 berbasis angka. Korpus 400K post/bln (skenario §5.2), sentiment + emotion (78 token input, 40 token output/post):

| Jalur | Deskripsi | LLM volume | Biaya LLM/bln | Biaya lain |
|---|---|---:|---:|---|
| **A. LLM-first** | Semua post → Claude Haiku 4.5, korpus `nlp_labels` untuk fine-tune kelak | 400K | ~$111 (in $31,2 + out $80) | — |
| **B1. Hybrid, fallback Haiku 4.5** | Encoder lokal (CPU) untuk semua; LLM hanya low-confidence (~12%, asumsi) | 48K | ~$13 | encoder CPU (masuk infra), butuh gold set + fine-tune awal |
| **B2. Hybrid, fallback Opus 5** (default AI_SPEC saat ini) | Sama, fallback `claude-opus-5` effort low | 48K | ~$67 | idem |

- Jalur A paling cepat ke produksi (tidak perlu model lokal yang sudah bagus), tapi biaya naik linear saat isu viral.
- Jalur B butuh model encoder yang lolos gold set sejak awal; biaya LLM kecil & terbatas oleh τ.
- Default model fallback adalah **konfigurasi** (AI_SPEC §4.5) — pemilihan Haiku vs Opus diputuskan dari eval (akurasi per $) di S-20, bukan di dokumen ini.

---

## 5. Skenario Biaya

> Asumsi skenario di bawah: **jalur A** (LLM-first Haiku, sentiment saja, 25 token output) — dipertahankan agar sebanding dengan dokumen pembanding. Untuk emotion & jalur B lihat §4a.

Catatan multi-tenant: di kita `posts` **global** + enrichment **di-cache lintas tenant** (ADR-005) → post yang sama tidak disimpan/di-NLP dua kali antar tenant. Yang belum: **dedup fetch** antar topic beririsan → itulah **collection stream** (ADR-009), near-term.

### 5.1 Satu topic (pilot) — 60.000 post/bln
| Komponen | Biaya |
|---|---:|
| Data (subtotal $17,99 × overhead 1,25 + Apify $29) | ~$51 |
| NLP (input $4,68 + output $7,50) | ~$12 |
| Infra (1 VPS, profil MVP DEPLOYMENT §3a) | $30–85 |
| **Total** | **~$94–149** (Rp 1,55–2,45 jt) |

Mahal karena $29 Apify + infra ditanggung sendirian. Ini biaya pilot, bukan operasi normal.

> **Belum termasuk:** biaya minimum per request X (§3, ~$20–65/bln tergantung jumlah stream & interval), token emotion (+$30/bln di §5.2 untuk jalur A), dan infra profil Kubernetes (DEPLOYMENT §4 — ratusan USD/bln ke atas). Angka infra $85 **hanya valid untuk profil MVP single-node**.

### 5.2 Operasi normal — 30 topic, collection stream bersama
Korpus **unik** ~400.000 post/bln (bukan 30×60K: topic publik Indonesia beririsan berat; **asumsi yang harus divalidasi**, §9).

| Komponen | Biaya | Porsi |
|---|---:|---:|
| Data ($119,93 × 1,25 + $29) | ~$179 | 52% |
| NLP (input $31,20 + output $50,00) | ~$81 | 24% |
| Infra (profil MVP single-node) | ~$85 | 25% |
| **Total** | **~$345** | |
| **Per topic** | **~$11,50** (Rp 190 rb) | |

### 5.3 Skala referensi — 108 topic
Korpus unik ~900K, faktor tumpang tindih ~4,0× → total ~$699, **per topic ~$6,47 (Rp 107 rb)**.

---

## 6. Nilai Dua Keputusan Desain

| Desain | Deskripsi | Total/bln | Per topic | vs 5.2 |
|---|---|---:|---:|---:|
| **Rekomendasi** | collection stream + fetch inkremental | **$345** | $11,50 | 1,0× |
| Naif A | collector per topic, tetap inkremental | $465 | $15,50 | **1,35×** |
| Naif B | collector per topic, polling tanpa cursor | $4.385 | $146 | **12,7×** |

- **Fetch inkremental** (high-watermark) melindungi sejak hari-1 dan paling menentukan (12,7×).
- **Collection stream** (dedup fetch antar topic) baru terbayar setelah puluhan topic: 1,35× @30 topic → **2,45× @108 topic** (~$1.000/bln).

Kesimpulan urutan kerja: **fetch inkremental dulu**, collection stream menyusul. Keduanya jauh lebih murah dibangun di awal daripada di-retrofit setelah skema data terlanjur per-topic.

---

## 7. Self-Host NLP (fase lanjut)

> Bagian ini = transisi **jalur A → jalur B** (§4a). Bila S-20 memilih jalur B sejak awal, angka "sesudah" di bawah berlaku sejak go-live (dengan biaya fallback sesuai model yang dipilih).

Setelah IndoBERT di-fine-tune dari korpus `nlp_labels` (AI_SPEC, ROADMAP self-host), LLM hanya untuk post low-confidence + audit (~12% volume):

| Komponen | Sebelum | Sesudah |
|---|---:|---:|
| Data | $179 | $179 |
| NLP | $81 | ~$11 |
| Infra | $85 | $85 |
| **Total** | $345 | **~$275** |
| **Per topic** | $11,50 | **~$9,17** |

Inference IndoBERT-base **di CPU** (~20–50 post/detik; 400K/bln ≈ 4 jam CPU/bln) → tidak butuh GPU produksi. Training: sewa A100 ~2 jam ~$4/run (teramortisasi ~$1,33/bln bila kuartalan). Nilai sesungguhnya bukan cuma hemat $70: **deployment on-premise/air-gapped** jadi mungkin (syarat klien instansi), tak ada dependensi eksternal di jalur panas, biaya jadi tetap (tak naik linear saat isu viral).

---

## 8. Cost Guard (3 lapis)

| Lapis | Mekanisme kita | Menangkap |
|---|---|---|
| 1. Preview sebelum simpan | FR-T05 cost-estimate + `/topics/preview` | Query terlalu luas, sebelum jadi tagihan |
| 2. Cap per-topic | `quota_policies` scope tenant/topic | Topic yang meledak volumenya |
| 3. Cap global | `quota_policies` scope provider/global | Total agregat lintas topic |

**Perilaku saat ambang tercapai:**

| Ambang | Aksi |
|---|---|
| 80% (soft) | Alert admin (`quota.threshold` → alert) |
| 100% (soft/global) | **Throttle**: interval polling turun ke maksimum (1 jam) + alert; **ingestion tidak berhenti** |
| Hard quota per-scope | `QUOTA_EXHAUSTED` → run `skipped` (CONNECTOR_SPEC §11) |
| Override manual | Admin bisa menaikkan cap kapan saja (audit) |

Kenapa throttle bukan stop di cap global: **data parsial lebih berguna daripada tidak ada data**; menghentikan ingestion saat isu viral mematikan sistem tepat saat paling dibutuhkan. (Detail: QUEUE_SPEC §cost guard.)

---

## 9. Yang Perlu Divalidasi (estimasi → nyata)

| Asumsi | Nilai dipakai | Cara validasi | Risiko kalau meleset |
|---|---|---|---|
| Korpus unik @30 topic | 400K/bln | hitung post unik setelah dedup | linear ke biaya data |
| Faktor tumpang tindih | 1,8× (@30), ~4,0× (@108) | rata-rata `len(matched_topics)` | menentukan nilai collection stream |
| Overhead polling | 1,25× | `usage.results` ÷ post baru tersimpan | linear ke biaya data |
| Token input/post | 78 | log `usage` nyata dari API | linear ke biaya NLP |
| Porsi platform | 89% X | hitung per platform | bergeser dari X menaikkan biaya |
| Jumlah & interval stream X | 50 @15m (contoh) | hitung request/hari nyata | biaya minimum per request (§3) |
| Rasio low-confidence (jalur B) | 12% | eval S-20 | linear ke biaya LLM |
| Baseline volume | screenshot produk pembanding | data nyata pilot | porsi FB/IG rendah mungkin cermin keterbatasan provider **mereka**, bukan percakapan sebenarnya |
| Tarif provider | tabel §2 | bandingkan tagihan | langsung |

Dashboard biaya (Admin → Usage) harus menampilkan **nilai nyata berdampingan dengan estimasi ini**, supaya selisih terlihat sejak awal — bukan di akhir bulan.

---

## 10. Sumber Harga

**Primer (halaman resmi provider — sudah dicek):**
- twitterapi.io pricing — https://twitterapi.io/pricing (dicek 2026-09-28; lihat PROVIDER_MATRIX §6.1)
- twitterapi.io docs — https://docs.twitterapi.io/introduction (dicek 2026-09-28)
- YouTube Data API v3 quota — https://developers.google.com/youtube/v3/determine_quota_cost (primer, **belum dicek ulang** — S-17)
- Harga model Claude — halaman pricing Anthropic (ID model via `GET /v1/models`, tanpa suffix tanggal).

**Sekunder (blog/agregator — WAJIB diganti sumber primer di S-11..S-13, S-16 sebelum committing budget):**
- X (Twitter) API pricing 2026 — https://postproxy.dev/blog/x-api-pricing-2026/
- Best social media scrapers on Apify 2026 — https://use-apify.com/docs/best-apify-actors/best-social-media-scrapers
- Apify Instagram Scraper (halaman actor, semi-primer) — https://apify.com/apidojo/instagram-scraper
- Best social media scraping APIs 2026 — https://scrapecreators.com/blog/best-social-media-scraping-apis


---

## 11. Perhitungan dari data terukur (2026-10-01) & harga jual

Sumber: run Apify final siklus 2026-09-14..10-01 (`GET /v2/actor-runs` + `chargedEventCounts` + jumlah item dataset; hanya actor SMIP),
ledger `provider_attempts`, volume post `topic_match_events` (topik BPIP, JOKOWI, Demo KDMP, demo buruh). Skrip model: angka di bawah
dihasilkan dari parameter tabel 11.1–11.3 (reproduksi: rumus §11.3). Kurs Rp 16.500/USD.

### 11.1 Tarif terukur per actor (siklus ini)
| Platform | Actor (connector) | Run | Item | Biaya final | Efektif / 1K item | Biaya tetap / run | Catatan |
|---|---|---:|---:|---:|---:|---:|---|
| X | xquik (`apify.x.xquik`) | 31 | 2.031 | $0,32 | **$0,16** | $0,0002 (run kosong) | `since_time` per detik → benar-benar inkremental |
| Threads | scrapersdelight | 41 | 245 | $0,25 | **$1,00** | $0 | `postedWithinDays` ≥ 1 hari, `searchType: top`, tanpa cursor |
| Facebook | scraper_one | 40 | 636 | $1,91 | **$3,00** | event `init`/run (≈ $0,0025, estimasi) | `startDate/endDate` per hari |
| TikTok | clockworks | 23 | 351 | $1,41 | **$4,01** | ~$0,001 | event result + filter + sorting per item; filter tanggal per hari |
| TikTok | xmolodtsov | 2 | 595 | $0,15 | **$0,25** | $0 | tanpa filter tanggal (saring lokal) |
| Instagram | scraping_solutions boolean (keyword + `#hashtag`) | 41 | 849 | $8,65 | **$10,19** | **$0,02** (run kosong = 2 halaman) | **742 event `search-page` × $0,01** + $1,55/1K item → ±1,3 item/halaman |
| Instagram | apify/instagram-hashtag-scraper | 1 | 8 | $0,02 | $2,30 (DOCS $2,60) | ~0 | hashtag saja (tanpa keyword caption) |
| YouTube | Data API v3 resmi | — | — | $0 | $0 | $0 | **kuota 100 `search.list`/hari/project** (PROVIDER_MATRIX §6.7) |

Total SMIP siklus ini ≈ **$13,05** (IG boolean 66%). Akun Apify yang sama juga menjalankan actor **di luar SMIP** ≈ $10,3 →
disarankan akun/token Apify terpisah untuk SMIP agar anggaran & batas pemakaian jelas.

### 11.2 Temuan penentu biaya: filter waktu per-hari = tagihan berulang
Hanya X (`since_time`, detik) dan YouTube (`publishedAfter`) inkremental sungguhan. Threads/TikTok/FB/IG menerima filter **per hari** →
setiap poll mengembalikan (dan menagih) ulang post 24 jam terakhir. **Terbukti** dari data: Threads Demo KDMP rata-rata 4,5 post/run ×
24 run/hari ≈ 108 post ditagih/hari untuk ~4,6 post baru/hari (**~23×**). Pada interval 5 menit faktornya **288×**.
Mitigasi **terpasang 2026-10-01: maxItems adaptif** (`apps/worker-dispatch/src/adaptive.ts`) — hanya untuk actor filter-per-hari
yang **terurut terbaru dulu** (`sinceGranularity: "day"` + `resultOrder: "desc"`: TikTok clockworks, FB scraper_one, X scraper_one,
YouTube streamers): diminta ± 3× post baru yang diharapkan per interval (min. 5), naik 4× bila hasil hampir semua baru. Actor **tak
terurut** (IG boolean/hashtag, Threads, TikTok xmolodtsov) tidak boleh dipotong (bisa membuang post baru) → penghematannya lewat
**interval lebih longgar**.

### 11.3 Rumus per topik per bulan (30 hari)
- `run/hari = 1440 / interval_menit`
- X/YouTube: `hasil = post_baru × 1,1 (presisi matcher) × 1,2 (overlap window 5m; 1,1 untuk ≥15m)`
- Actor filter-per-hari: `hasil/run = min(300, post_baru_24j × 1,1)`; **adaptif** (hanya TikTok clockworks & FB): `min(itu, max(5, ⌈3 × post_baru × interval/1440⌉))`
- `biaya = 30 × (run/hari × biaya_tetap + hasil/hari × tarif_per_hasil)`; IG boolean: `tarif ≈ $0,00155 + $0,01/1,3` per hasil
- AI (sentimen + emosi + isu, satu panggilan batch): ±100 token input + ±45 token output per post × Claude Haiku 4.5 ($1/$5 per MTok, §4)
  ≈ **$0,33 / 1.000 post** (Gemini berbayar belum diverifikasi harganya; tier gratis **tidak boleh** untuk data klien).
- Infra: profil MVP single-node ~$85/bln untuk ±30 topik (§5, DEPLOYMENT §3a) → ≈ $2,8/topik.

Ukuran topik (post baru/hari): **kecil** 37 (≈ BPIP) · **sedang** 730 (X 450, Threads 120, TikTok 60, IG 50, FB 20, YT 30 ≈ JOKOWI /
KDMP di produk referensi) · **ramai** 2.043 (baseline §1).

### 11.4 Biaya per topik per bulan (USD)
| Skenario | Kecil | Sedang | Ramai |
|---|---:|---:|---:|
| A. Semua 5 menit, kode sebelum perbaikan | 882 | **8.068** | 5.088 |
| B. Semua 5 menit, maxItems adaptif (TikTok/FB) | 869 | 5.514 | 3.076 |
| P. **Plus**: X/TikTok/FB 5m · IG (keyword+hashtag)/Threads 1j · YT 3j | 291 | 776 | 592 |
| S. **Standar**: X 5m · TikTok/FB 15m · IG (keyword+hashtag)/Threads/YT 3j | 98 | 266 | 220 |
| S'. **Standar hemat**: seperti S, IG via hashtag resmi saja ($2,60/1K, tanpa biaya halaman) | 85 | 174 | 176 |
| D. Semua 1 jam, kode sebelum perbaikan (kondisi demo 30-09) | 74 | 681 | 452 |

Penyumbang terbesar: **IG keyword+hashtag** (boolean: $0,01/halaman, tak terurut → tidak bisa adaptif; 5m ≈ $4.565/bln untuk topik
sedang), TikTok clockworks & FB di interval rapat (lantai 5 hasil/run × 288 run). X hampir gratis di interval berapa pun. **YouTube resmi
tidak bisa 5 menit**: 288 search/hari/topik > kuota 100/hari → 3 jam untuk ≤ 12 topik (8 search/topik/hari) atau ajukan perluasan kuota
ke Google; cadangan Apify streamers ±$0,02/run (5m ≈ $170/bln/topik).

### 11.5 Kantor 10 topik (3 kecil + 5 sedang + 2 ramai), termasuk infra ±$28
| Skenario | **Biaya/bln** | Rupiah |
|---|---:|---:|
| A. Semua 5m, kode sebelum perbaikan | $53.194 | Rp 877,7 jt |
| B. Semua 5m, adaptif | $36.360 | Rp 599,9 jt |
| P. Plus | $5.963 | Rp 98,4 jt |
| S. Standar (IG keyword+hashtag) | $2.094 | Rp 34,6 jt |
| **S'. Standar hemat (IG hashtag)** | **$1.504** | **Rp 24,8 jt** |
| D. Semua 1j, kode sebelum perbaikan | $4.560 | Rp 75,2 jt |

### 11.6 Usulan harga jual (cost-plus — validasi dengan harga pesaing sebelum dipakai)
Harga = `biaya × 1,2 (cadangan: failover ke provider lebih mahal, kenaikan tarif) ÷ (1 − 60% margin kotor)`; belum termasuk PPN,
biaya support/sales, dan diskon kontrak tahunan.

| Paket (10 topik/kantor) | Interval | Biaya/bln | **Harga/bln** | Per topik |
|---|---|---:|---:|---:|
| **Standar** (S', IG hashtag) | X 5m · TikTok/FB 15m · IG/Threads/YouTube 3j | Rp 24,8 jt | **Rp 74 jt** | Rp 7,4 jt |
| **Standar+** (S, IG keyword + hashtag) | idem, IG keyword + hashtag | Rp 34,6 jt | **Rp 104 jt** | Rp 10,4 jt |
| **Plus** (P) | X/TikTok/FB 5m · IG/Threads 1j · YouTube 3j | Rp 98,4 jt | **Rp 295 jt** | Rp 29,5 jt |
| Semua 5 menit | — | ≥ Rp 600 jt | tidak disarankan dijual | — |

Syarat sebelum menjual: (1) **maxItems adaptif** aktif (terpasang 2026-10-01; efektif setelah ≥ 2 run per plan); (2) interval per
platform dikunci per paket (`plans.limits` / `topic_platforms.interval_sec`); (3) akun Apify khusus SMIP + plan di atas STARTER
($19 kredit/bln tidak cukup; batas pemakaian diatur di Billing & di Pengaturan → Sumber data); (4) AI berbayar (bukan tier gratis);
(5) ukur ulang biaya 2 minggu pertama tiap klien — "ramai" tidak selalu mahal (X murah; yang mahal IG/TikTok/FB); (6) peluang
turun biaya terbesar: provider IG keyword yang terurut waktu / tanpa biaya halaman, Threads API resmi (gratis, butuh App Review),
kuota YouTube diperluas; (7) kurs & tarif diverifikasi ulang (§10).

## 12. Hitung ulang lengkap 2026-10-03 (provider aktif + komentar + AI)

**Sumber data per platform (yang aktif sekarang)** — §11 masih berisi angka Apify lama untuk IG/TikTok; bagian ini menggantikannya.

| Platform | Provider aktif | Tarif | Cara ditagih | Catatan |
|---|---|---|---|---|
| X | Apify `xquik` | $0,16 / 1K post + $0,0002 / run | per post baru (filter waktu per detik) | hampir gratis di interval berapa pun |
| Instagram | **HikerAPI** | **$0,001 / request** (±30 post) | per request, berhenti di window | 3 hashtag tiap jadwal + keyword (topsearch) tiap 1 jam |
| TikTok | **LamaTok** | **$0,001 / request** (±30 video) | per request | 3 keyword × ≥ 1 halaman tiap jadwal |
| Threads | Apify `scrapersdelight` | $1 / 1K post | **filter per hari → post 24 jam ditagih ulang tiap jadwal** | satu-satunya yang mahal di interval rapat |
| Facebook | Apify `scraper_one` | $3 / 1K post + ±$0,0025 / run | per hari, maxItems adaptif (min 5 / run) | |
| YouTube | Data API v3 resmi | $0 | kuota 10.000 unit/hari/project (search 100 unit, komentar 1 unit) | interval ≥ 1 jam; > 12 topik → ajukan perluasan kuota |
| **Komentar** | LamaTok (TikTok) · YouTube resmi | $0,001 / request · $0 | 20 post teratas/topik/hari × 1 halaman | ± $0,6/topik/bln + AI komentar |
| **AI** (sentimen + emosi + isu) | LLM berbayar | ± $0,33 / 1K teks (Claude Haiku 4.5; Gemini Flash-Lite berbayar setara/lebih murah) | per post **dan** komentar | tier gratis tidak untuk data klien |
| Infra | 1 server 16 GB + backup | $90 / $120 / $150 bln (10 / 20 / 30 topik) | tetap | |

Asumsi: kantor = 10 topik (3 kecil + 5 sedang + 2 ramai; ukuran §11.3), 3 keyword + 3 hashtag per topik, komentar 20 post/topik/platform/hari
(± 10 / 40 / 60 komentar per post untuk kecil/sedang/ramai), kurs Rp 16.500. Harga = biaya × 1,2 (cadangan) ÷ 0,4 (margin 60%), belum PPN.
Semua angka bisa diubah owner di **Pengaturan → Batas & jadwal**; rumus §11.3 + tarif tabel di atas.

### 12.1 Biaya per topik per bulan (USD, termasuk komentar & AI)
| Skenario (jadwal per platform) | Kecil | Sedang | Ramai | Penyumbang terbesar |
|---|---:|---:|---:|---|
| A. Semua 5 menit | 192 | 1.398 | 2.878 | Threads 1.140–2.592; FB 151 |
| A'. Semua 5 menit, Threads 1 jam | 142 | 329 | 478 | FB 5m 151, Threads 95–216 |
| **B. Rekomendasi**: X/TikTok/IG 5m · FB 15m · Threads & YouTube 1j · IG keyword 1j | 89 | 228 | 377 | Threads 95–216, FB 50, AI 24–46 |
| C. Standar: X/TikTok/IG 15m · FB 1j · Threads & YouTube 3j | 31 | 90 | 164 | AI, Threads |

Rincian B (topik sedang): X $5 · TikTok $26 · Instagram $28 · Threads $95 · Facebook $50 · YouTube $0 · komentar $0,6 · AI $24 (± 72 ribu post+komentar/bln).

### 12.2 Total & harga jual
| Skenario | Biaya 1 kantor | 2 kantor | 3 kantor | **Harga jual / kantor / bln** |
|---|---:|---:|---:|---:|
| A. Semua 5 menit | Rp 221 jt | Rp 442 jt | Rp 662 jt | ± Rp 662 jt — tidak layak |
| A'. 5 menit, Threads 1 jam | Rp 51 jt | Rp 102 jt | Rp 152 jt | **± Rp 152 jt** (paket Real-time) |
| **B. Rekomendasi** | **Rp 37 jt** | Rp 73 jt | Rp 110 jt | **± Rp 110 jt** (paket Plus) |
| C. Standar | Rp 16 jt | Rp 31 jt | Rp 46 jt | **± Rp 46 jt** (paket Standar) |

Kesimpulan: IG (HikerAPI) & TikTok (LamaTok) kini murah di jadwal berapa pun (≈ $26–52/topik/bln di 5 menit; dulu IG Apify ≈ $4.500).
X hampir gratis. **Yang menentukan harga: Threads** (actor Apify menagih ulang 24 jam tiap jadwal) dan **Facebook di 5 menit**. Komentar
murah di sisi data; biaya tambahannya di AI (± 30–60% dari biaya AI post).

### 12.3 Penurunan biaya berikutnya (urutan dampak)
1. **Threads**: provider per-request / inkremental atau Threads API resmi (gratis, App Review) → paket B turun ± 30–50%.
2. **Facebook**: 15 menit–1 jam (atau provider per-request).
3. **Berbagi pengambilan antar kantor** (collection stream, ADR-009 — diuji §12.4): keyword sama → dibayar sekali.
4. **AI**: model sendiri dari korpus `nlp_labels` (AI_SPEC §14) → biaya AI per teks mendekati 0 setelah dilatih.

### 12.4 Update 2026-10-03 (sore): Threads pindah ke actor terurut terbaru + paket di Pengaturan
**Threads → Apify `themineworks/threads-search-scraper`** (VERIFIED: $0,005 start/run + $0,001/post, `resultType: recent`). Karena hasil
terurut terbaru, **maxItems adaptif** berlaku → poll rapat hanya membayar ± post baru, bukan 24 jam penuh. Actor lama (scrapersdelight)
jadi cadangan. Lantai post per pengambilan kini diatur di Pengaturan (`fetch.min_items_per_run`, bawaan 5).

Biaya modal per kantor (10 topik campuran, termasuk AI + komentar) — angka ini yang tampil di Pengaturan → Batas & jadwal:

| Paket | Jadwal | Lantai 5 | Lantai 2 | Harga jual / kantor (×1,2 ÷ 0,4) |
|---|---|---:|---:|---:|
| Hemat | semua 3 jam | Rp 8,3 jt | Rp 8,1 jt | ± Rp 25 jt |
| Standar | X/TikTok/IG 15m · Threads/FB 1j · YouTube 3j | Rp 12,8 jt | Rp 11,8 jt | ± Rp 38 jt |
| Plus | X/TikTok/IG 5m · Threads/FB 15m · YouTube 1j | Rp 28,3 jt | Rp 21,9 jt | ± Rp 66–85 jt |
| Real-time | semua 5m · YouTube 1j | **Rp 56,3 jt** (dulu Rp 221 jt) | Rp 35,5 jt | ± Rp 107–169 jt |

Provider per-request yang dievaluasi (belum dipakai — butuh akun berbayar pemilik):
- **Threads — ScrapeCreators** `/v1/threads/search` ($10/5K request ≈ $0,002/request, kredit tidak kedaluwarsa; filter tanggal per hari,
  tanpa cursor): **ditagih per request, bukan per post** → Threads 5m ± $16/topik/bln. Provider `scrapecreators` sudah terdaftar.
- **Threads — CaptAPI** search (2 kredit/request flat, `orderBy=post_dated`, ≤ 200 post; Starter $9/2.000 kredit ≈ $0,009/request).
- **Facebook** keyword: tidak ada API per-request yang murah (AnyAPI search $30/1K request; ScrapeCreators tanpa pencarian keyword).
  Actor Apify termurah dengan mode terbaru: `silentflow/facebook-search-scraper` ($2,3/1K), `scrapeforge/facebook-search-posts`
  ($2,59/1K) vs `scraper_one` sekarang ($4/1K, mode `latest`, sudah adaptif). Pengungkit terbesar FB = lantai post & jadwal.

### 12.5 Update 2026-10-03 (malam): Facebook → silentflow, sumber mahal dimatikan, CaptAPI
**Facebook → Apify `silentflow/facebook-search-scraper`** (`apify.facebook.silentflow`, VERIFIED 20 post). Tagihan run nyata:
1 start + 10 item = **$0,023 → ± $0,0023/post** (vs `scraper_one` $0,004/post, **−42%**). `recent_posts: true` → terurut terbaru →
maxItems adaptif berlaku. Satu-satunya sumber FB; `scrapeforge` gagal verify (0 item dengan filter tanggal) → mati.

**Dimatikan (permintaan pemilik "API mahal dimatikan dulu"):** YouTube Apify `streamers` (YouTube cukup API resmi gratis), Threads
`scrapersdelight` (filter per hari → tagihan berulang), X `scraper_one`, Facebook `scraper_one` & `scrapeforge`. Cadangan yang tetap
hidup hanya yang murah: X `kaito` ($0,25/1K). Akibatnya FB & Threads tanpa cadangan — bila sumber utama gagal, platform itu kosong
sampai pulih (lebih baik daripada diam-diam pindah ke actor 2× lebih mahal).

**CaptAPI (captapi.com) — dievaluasi, tidak dipakai:** ± $0,009/request (2 kredit × ± $0,0045; Starter $9/2.000 kredit/bln, Business
$90/20.000). Per request **9× lebih mahal** dari HikerAPI/LamaTok ($0,001). Facebook hanya Marketplace (**tidak ada pencarian post
keyword**), X hanya community search. Threads search (`orderBy=post_dated`, ≤ 200 post/request) layak teknis tapi ScrapeCreators
lebih murah ($0,002/request). Cakupan platformnya lebar, tapi untuk kebutuhan SMIP (pencarian post keyword terbaru) hanya Threads yang
terpakai → tidak menggantikan provider sekarang.

Dampak paket (10 topik campuran, perkiraan): bagian Facebook turun ± 40% di semua paket; Real-time ± Rp 52 jt/kantor (dari Rp 56 jt).


### 12.6 Perbandingan jadwal tetap (server) + auto-refresh layar — 2026-10-03 (keputusan: kembali ke model ini)
Model: jadwal pengambilan diatur owner untuk semua topik; layar klien auto-refresh (5 menit–1 jam) hanya membaca DB → **$0**
tambahan (± 15 query ClickHouse ringan per refresh per pengguna). **Off** di dashboard = topik dijeda = $0 pengambilan.
Tarif dari provider aktif (X xquik, Threads themineworks $0,005/run + $0,001/post, FB silentflow $0,0023/post, IG HikerAPI &
TikTok LamaTok $0,001/request, YouTube resmi gratis), lantai adaptif 5 post/run, ukuran topik §11.3, AI $0,33/1K teks (post +
komentar 20 post teratas/hari TikTok + YouTube), server $90/bln. Skrip model diverifikasi terhadap tagihan Apify 2026-10-02
(3 topik kecil, 1 jam: ± $0,6/hari Apify; model sedikit lebih tinggi = konservatif).

**Biaya ambil data per topik / bulan (USD, tanpa AI):**
| Jadwal semua platform | Kecil | Sedang | Ramai |
|---|---:|---:|---:|
| 5 menit | 177 | 243 | 247 |
| 15 menit | 60 | 83 | 105 |
| **30 menit** | **30** | **48** | **71** |
| **1 jam** | **16** | **30** | **58** |
| 3 jam | 5 | 21 | 52 |

Rincian topik sedang, 30 menit vs 1 jam: Facebook $16,6 vs $8,3 · Threads $18,7 vs $14,4 · IG $5,0 vs $2,9 · TikTok $4,3 vs $2,2 ·
X $2,9 vs $2,8 · YouTube $0. **Penyumbang utama = biaya per run** (Threads $0,005 start + lantai 5 post; FB lantai 5 post), bukan
jumlah post — makin sering jadwal, makin banyak run.

**Kantor 10 topik (3 kecil + 5 sedang + 2 ramai), total termasuk AI + komentar ($222) + server ($90):**
| Paket (Pengaturan) | Jadwal | Total / bln | Harga jual (×1,2 ÷ 0,4) | YouTube request/hari |
|---|---|---:|---:|---:|
| Hemat | semua 3 jam | Rp 8,9 jt | ± Rp 27 jt | 240 (1 key) |
| **Standar** | semua 1 jam · YouTube 3 jam | **Rp 10,4 jt** | **± Rp 31 jt** | 240 (1 key) |
| **Plus** | semua 30 menit · YouTube 1 jam | **Rp 12,9 jt** | **± Rp 39 jt** | 720 (> 400/key → perluasan kuota) |
| Cepat | semua 15 menit · YouTube 1 jam | Rp 18,4 jt | ± Rp 55 jt | 720 |
| Real-time | semua 5 menit · YouTube 1 jam | Rp 42,1 jt | ± Rp 126 jt | 720 |

Topik yang ada sekarang (4 aktif, kecil): 1 jam **$62 + AI $20 ≈ Rp 2,8 jt/bln** (dengan server); 30 menit Rp 3,8 jt. Bila 7 topik
(5 kecil + 2 sedang) dinyalakan: 1 jam Rp 5,0 jt, 30 menit Rp 6,7 jt.

**Pembanding "ambil setiap refresh layar"** (ditolak): biaya = jumlah pengguna × refresh — 3 pengguna × refresh 5 menit × 8 jam kerja
= 288 pengambilan/topik/hari (≈ biaya 5 menit, Rp 42 jt/kantor) dan **0 pengambilan di luar jam kerja** (data bolong, alert & laporan
tidak lengkap karena API pencarian hanya memberi post terbaru).

**Cara menekan biaya tanpa mengubah tampilan klien (urut dampak):**
1. Jadwal 1 jam (Standar) — klien tetap melihat layar segar via auto-refresh; data paling lambat ± 1 jam.
2. Lantai post per run 5 → 2 (`fetch.min_items_per_run`): kantor 1 jam $315 → $292 (−7%), 30 menit $471 → $401 (−15%).
3. Mode malam (00–06 WIB tiap 3 jam): 30 menit $471 → $409 (−13%) — **aktif 2026-10-04** (`schedule.night_*`).
4. Jadwal adaptif per topik: topik sepi (run tanpa post baru berturut-turut) otomatis melambat sampai 3 jam — penghematan terbesar
   untuk topik kecil (biaya per run dominan); **aktif 2026-10-04** (`schedule.adaptive_*`, scheduler `pace.ts`).
7. Paket per kantor (2026-10-04, migrasi 0029): tiap kantor memilih Hemat/Standar/Plus/Cepat/Real-time di menu Kantor.
5. Keyword sama antar kantor → satu pengambilan (collection stream, ADR-009, sudah aktif).
6. YouTube > 5 topik di 1 jam: ajukan perluasan kuota Google (gratis) — jangan membuat banyak project untuk mengakali kuota (ToS).

"Ambil sekarang" (dashboard, analis+) = satu pengambilan tambahan per platform (jeda 5 menit, adaptif → biasanya < $0,01 per klik).
