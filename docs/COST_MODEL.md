# COST MODEL

Model biaya operasi platform. **Semua angka di dokumen ini adalah estimasi** (per September 2026); hanya yang bertanda **DOCS** sudah dicek ke halaman resmi provider — tiap tarif punya `source_ref` di §10 dan **wajib diverifikasi ulang sebelum committing budget** (tarif scraping berubah sering). Angka final yang dipakai routing produksi tetap tinggal di [PROVIDER_MATRIX.md](PROVIDER_MATRIX.md) dengan status verifikasi.

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
