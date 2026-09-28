# PROVIDER MATRIX

> **Tujuan dokumen ini: mencegah mengarang.** Tidak ada angka rate limit, harga, atau klaim capability yang ditulis di sini tanpa sumber. Semua sel yang belum diverifikasi di-set `UNVERIFIED` dan **tidak boleh** dipakai routing produksi.
>
> Pengisian dilakukan di TASK fase 0 (S-10..S-13, S-16, S-17). Setiap verifikasi mencatat: tanggal, URL dokumen, versi API/actor, dan (jika dites) link evidence contract test.

## 1. Status legend

| Status | Arti |
|---|---|
| `UNVERIFIED` | Belum dicek. Dilarang dipakai produksi. |
| `DOCS` | Tercantum di dokumentasi resmi provider (URL + tanggal akses wajib). |
| `TESTED` | Sudah dibuktikan oleh contract test (evidence_ref). |
| `NOT_AVAILABLE` | Dokumentasi/tes membuktikan tidak tersedia. |

## 2. Kandidat per platform

### 2.0 Ringkasan multi-provider (2026-09-28) — urutan = rekomendasi prioritas routing awal

Uji kontrak nyata via Apify (kata kunci "koperasi merah putih", 10–20 item/run, evidence `docs/evidence/S-11/` & `docs/evidence/S-11-S-17/`). Harga = **tier FREE Apify** kecuali disebut; tier berbayar biasanya lebih murah. "Biaya tetap/run" = biaya yang dibayar walau hasil 0 — **dominan pada polling rapat** (COST_MODEL §3).

| Platform | Prioritas | Provider · connector | Status | Tarif/1K hasil | Biaya tetap / run | Catatan kunci |
|---|---|---|---|---|---|---|
| X | 1 | twitterapi.io · `twitterapi_io.x` | DOCS (API key belum ada) | $0,15 | min $0,00015/request | §6.1 |
| X | 2 | Apify `xquik/x-tweet-scraper` · `apify.x.xquik` | **VERIFIED** (connector verify 2026-09-29, 5 sampel) | $0,15 | ~0 | 50/50 item valid, p50 5,5 s / p95 5,9 s, field janji 100%; inkremental via operator `since_time:`/`until_time:` di `searchTerms` (skema input actor); `queryType: Latest` = terbaru dulu; `createdAt` Twitter klasik. Evidence `docs/evidence/I-17/` |
| X | 3 | Apify `apidojo/tweet-scraper` | **TESTED** | $0,40 | ~0 | 10/10 relevan, 52 detik |
| X | 4 | X API official | DOCS | $5,00 | — | cadangan mahal, cap 3 juta read/bln |
| Instagram (keyword) | 1 | Apify `scraping_solutions/instagram-boolean-search-scraper-posts-reels` | **TESTED** | $1,55 | $0,01/halaman search | **tanpa login**; boolean AND/OR/NOT; 8/8 relevan, 1 cocok lewat caption saja; hasil **tidak terurut terbaru** (post Mei–Jun) → pakai `oldestPostDate` |
| Instagram (keyword) | 2 | Apify `crawlerbros/instagram-keyword-search-scraper` | **TESTED** | $5,00 | $0,05 per GB memori (pakai 1 GB) | hasil segar (≤ 3 hari), 9/10 relevan, 2 caption-only; **memakai pool sesi Instagram yang login** (risk tinggi, S-15); `pub_date` **tanpa zona waktu** |
| Instagram (hashtag) | 3 | Apify `apidojo/instagram-scraper` / `apify/instagram-hashtag-scraper` | DOCS | $0,47 / $2,60 | — | cadangan recall via hashtag (§6.3) |
| Instagram | 4 | ScrapeCreators `/v1/instagram/search` · EnsembleData IG keyword | DOCS | tidak publik / langganan | — | vendor non-Apify |
| Instagram | — | Apify `viralanalyzer/instagram-keyword-search-scraper` | **TESTED → gagal** | $1,00 | — | `BLOCKED` (tembok login) tanpa cookie → tidak dipakai |
| Facebook (keyword) | 1 | Apify `scraper_one/facebook-posts-search` | **TESTED** | $4,00 | ~0 | **keyword search FB ADA** — 11/11 relevan, semua ≤ 3 jam; `timestamp` epoch ms |
| Facebook (keyword) | 2 | Apify `scrapeforge/facebook-search-posts` | **TESTED** | $2,59 | ~0 | 7/8 relevan, tidak terurut waktu; `start_date`/`end_date`, `recent_posts`; `timestamp` epoch detik |
| Facebook (Page) | 3 | Apify `apify/facebook-posts-scraper` | DOCS | $2,00 | — | daftar Page per topic (tetap berguna untuk akun resmi) |
| Facebook | 4 | Data365 | DOCS | €300+/bln | — | vendor non-Apify (FB, IG, X, TikTok, Threads, Reddit) |
| Threads | 1 | Threads API official | DOCS | gratis | — | butuh App Review `threads_keyword_search` |
| Threads | 2 | Apify `scrapersdelight/threads-keyword-search-scraper` | DOCS | $1,00 | tidak ada start fee | tanpa cursor (~50–70 post/keyword) — murah untuk polling rapat |
| Threads | 3 | Apify `futurizerush/meta-threads-scraper` | **TESTED** | $2,50 | **$0,08/run** (paksa 4 GB × $0,02) | 10/10 relevan, terurut terbaru, `start_date`/`end_date`; **mengeluarkan email & telepon** → buang di normalizer; mahal untuk polling < 1 jam |
| Threads | 4 | ScrapeCreators `/v1/threads/search` · EnsembleData Threads keyword | DOCS | tidak publik / 1 unit | — | vendor non-Apify |
| TikTok | 1 | Apify `apidojo/tiktok-scraper` | **TESTED** | $0,30 | ~0 | 9/10 relevan, `keywords` + `dateRange`, `uploadedAt` epoch detik |
| TikTok | 2 | Apify `clockworks/tiktok-scraper` | DOCS | $3,70 (FREE) / $1,70 (berbayar) | — | paling populer |
| TikTok | 3 | ScrapeCreators `/v1/tiktok/search/keyword` · EnsembleData | DOCS | tidak publik / 1 unit | — | vendor non-Apify |
| YouTube | 1 | YouTube Data API v3 official | DOCS | gratis | — | 100 `search.list`/hari |
| YouTube | 2 | Apify `streamers/youtube-scraper` | **TESTED** | $4,00 | ~0 | 10/10 relevan, 73 detik |
| YouTube | 3 | ScrapeCreators `/v1/youtube/search` · EnsembleData | DOCS | — | — | vendor non-Apify |

Kandidat dicoret: `igview-owner/threads-search-scraper` (minimal 20 post × $0,02 = $20/1K), `datamagnet/instagram-search-posts-reels` ($6/1K), `khadinakbar/instagram-keyword-search-scraper` (hasilnya profil, bukan post), `automation-lab/instagram-keyword-search-scraper` (berbasis hashtag, tingkat gagal 30 hari tinggi).

**Prinsip multi-provider (diterapkan ke semua platform, termasuk yang punya jalur official):** minimal 1 official (bila ada) + 2 pihak ketiga Apify + 1 vendor non-Apify teridentifikasi. Official tidak otomatis prioritas 1 (§4). Semua di balik interface `Connector` — menambah/menukar = connector + routing rule, tanpa ubah core.

Kolom "Catatan awal" di tabel per platform di bawah adalah catatan historis; **§2.0 dan §6 yang berlaku**.

### 2.1 X (Twitter)
| Provider | Kind | Runtime | Operation kandidat | Status | Catatan (lihat §6 untuk fakta terverifikasi) |
|---|---|---|---|---|---|
| **twitterapi.io** — kandidat **utama** | third_party | bun | search_keyword, user_timeline, post_detail, profile | **DOCS** (S-10, 2026-09-28) | `GET https://api.twitterapi.io/twitter/tweet/advanced_search`, header `X-API-Key`, ≤ 20 tweet/halaman, cursor. Inkremental: `since_time`/`until_time` (DOCS); `since_id:` **UNVERIFIED**. $0,15/1K tweet + **minimum $0,00015/request walau kosong**. QPS: sumber resmi saling bertentangan → belum boleh dipakai. Detail §6.1. |
| Apify actor `kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest` — cadangan 1 | third_party | bun | search_keyword, user_timeline | **DOCS** (§6.2) | $0,18–0,25/1K tweet + minimum per call (angka tak disebut); `since_time`/`until_time`; `maxItems` ≥ 20. Actor lain (xtdata) UNVERIFIED |
| X API (official) — cadangan mahal | official | bun | search_keyword, user_timeline, post_detail | **DOCS** (§6.2) | $0,005/post read (= $5/1K, ~33× twitterapi.io); cap 3 juta read/bln per pay-per-use. Dipakai hanya jika pihak ketiga gagal / kebutuhan legal. |

### 2.2 Instagram
| Provider | Kind | Runtime | Operation kandidat | Status | Catatan awal |
|---|---|---|---|---|---|
| Instagram Graph API (Meta) | official | bun | search_hashtag, user_timeline (akun bisnis sendiri) | **DOCS** (§6.3) | Business/Creator + fitur "Instagram Public Content Access" (App Review); **30 hashtag unik / 7 hari rolling**; keyword bebas: tidak ada |
| Apify actor `apidojo/instagram-scraper` (utama) / `apify/instagram-scraper` | third_party | bun | search_hashtag, user_timeline, post_comments | **DOCS** (§6.3) | **Keyword caption: NOT_AVAILABLE (DOCS)** — input hanya hashtag/profil/lokasi. apidojo $0,47/1K; apify $1,50–2,70/1K |
| instagrapi | unofficial | python | search_hashtag, user_timeline, post_comments, profile, search_keyword? | UNVERIFIED | Library Python private API; butuh login akun IG → risiko challenge/ban & pelanggaran ToS. Hanya fallback, akun khusus, di worker terisolasi. |

### 2.3 Facebook
| Provider | Kind | Runtime | Operation kandidat | Status | Catatan awal |
|---|---|---|---|---|---|
| Graph API (Pages) | official | bun | user_timeline (page yang dikelola/izin), post_comments | UNVERIFIED | Pencarian publik lintas Facebook umumnya tidak tersedia untuk app biasa; akses konten publik tertentu butuh fitur/izin khusus — cek docs |
| Apify actor `apify/facebook-posts-scraper` | third_party | bun | user_timeline (page publik) | **DOCS** (§6.4) | $2,00/1K post; input URL Page; `onlyPostsNewerThan`; **keyword search: NOT_AVAILABLE** |

### 2.4 Threads
| Provider | Kind | Runtime | Operation kandidat | Status | Catatan awal |
|---|---|---|---|---|---|
| Threads API (Meta) — **utama bila App Review lolos** | official | bun | search_keyword, user_timeline (akun sendiri), post_comments | **DOCS** (§6.5) | `/keyword_search` + permission `threads_keyword_search` (tanpa approval → hanya post sendiri); 2.200 query/24 jam; `RECENT`; `since`/`until`; ≤ 100/halaman. Klaim "hanya publishing" keliru |
| Apify actor `scrapersdelight/threads-keyword-search-scraper` — cadangan | third_party | bun | search_keyword | **DOCS** (§6.5) | $1,00/1K post; **tanpa cursor** → ~50–70 post unik/keyword maksimum (cakupan terbatas saat isu ramai) |

### 2.5 TikTok & YouTube (MVP, S-16/S-17) · Bluesky & Reddit (registry, connector Fase 6)
TikTok & YouTube masuk **MVP** (6 platform, sesuai volume referensi & COST_MODEL). Bluesky & Reddit ada di tabel `platforms` (`enabled=false`) dan UI, connector di Fase 6. Semua angka tetap `UNVERIFIED` sampai diisi.

| Platform | Kandidat | Catatan awal |
|---|---|---|
| TikTok | Apify `clockworks/tiktok-scraper` ($1,70/1K, keyword/hashtag, **DOCS** §6.6); TikTok Research API **NOT_AVAILABLE** (hanya peneliti non-komersial) | DOCS |
| YouTube | YouTube Data API v3 (official) — **100 `search.list`/hari** (bucket terpisah) + 10.000 unit lainnya; `publishedAfter`; OR via `\|` | **DOCS** §6.7 |
| Bluesky | AT Protocol public API (`app.bsky.feed.searchPosts`), Jetstream/firehose | UNVERIFIED — cek rate limit docs Bluesky |
| Reddit | Reddit Data API (butuh registrasi & syarat penggunaan) | UNVERIFIED — cek terms & limit terbaru |

## 3. Template fakta per connector (isi saat verifikasi)

```yaml
connector: apify.instagram
provider_docs: https://docs.apify.com/...       # URL persis
actor_id: <owner>/<actor-name>                  # dari Apify Store
actor_version_or_build: <...>
verified_at: 2026-10-xx
verified_by: <nama>
api_surface:
  start_run: <endpoint persis dari docs>
  poll_run:  <endpoint persis dari docs>
  get_items: <endpoint persis dari docs>
operations:
  search_keyword: { status: TESTED|NOT_AVAILABLE|UNVERIFIED, evidence: <link> }
  search_hashtag: { ... }
rate_limit:
  value: <angka dari docs atau "not documented">
  source: <URL>
pricing:
  model: <per result | per compute unit | subscription | ...>
  value: <angka dari halaman pricing>
  source: <URL>
  checked_at: <tanggal>
measured:
  p50_latency_ms: <dari contract test>
  p95_latency_ms: <...>
  min_interval_sec: <turunan>
legal_notes: <ToS, larangan penggunaan, dsb.>
```

## 4. Rekomendasi urutan prioritas routing (default, bisa diubah di UI)

Urutan **bukan** "official selalu pertama". Kriteria berurutan:
1. **Capability terverifikasi** untuk operation yang dibutuhkan (keyword search publik). Official API yang tidak punya keyword search publik tidak bisa jadi utama, sebagus apa pun legalitasnya.
2. **Biaya per hasil** (COST_MODEL) — beda 10–30× antar provider untuk data yang sama.
3. **Risiko legal/ToS** (`providers.risk_level`) — official < third-party terkelola < unofficial.

Konsekuensi default:
- **X**: twitterapi.io (priority 1) → Apify actor (priority 2) → X official (priority 3, weight kecil/standby karena mahal).
- **YouTube**: Data API v3 official (gratis, quota) → Apify actor.
- **IG / FB / Threads / TikTok**: Apify actor terverifikasi → vendor cadangan (§4a) → unofficial (instagrapi) **standby `weight = 0`**, hanya setelah sign-off legal (S-15), bisa dimatikan total per tenant.

## 4a. Backup provider ladder & kriteria pindah

Karena sebagian besar dari 6 platform MVP (IG, FB, TikTok, dan kemungkinan Threads — lihat §4b) **tidak** punya pencarian keyword publik lewat jalur resmi, risiko provider adalah risiko **eksistensial**, bukan sekadar merepotkan. Setiap platform butuh minimal satu cadangan yang **sudah teridentifikasi sebelum dibutuhkan** — saat provider mati, waktu bukan untuk riset. (Angka = estimasi, verifikasi; lihat COST_MODEL §10.)

Ladder lengkap per platform (utama → cadangan, termasuk vendor non-Apify) ada di **§2.0** (diperbarui 2026-09-28 dari uji kontrak). Tabel ladder v0.3 dihapus agar tidak ada dua versi.

**Kriteria pemicu pindah** (salah satu terpenuhi):
- Tingkat error > 20% selama > 6 jam.
- Harga naik > 50%.
- Data gap terdeteksi (spot-check menemukan post yang seharusnya ada tapi tak terkumpul).
- Provider mengumumkan penghentian layanan.

Karena semua provider di balik interface `Connector` + Router (provider-agnostic), pindah = **tulis 1 connector baru + ubah 1 baris config routing** (perkiraan 1–2 hari/platform). Tidak ada perubahan business logic.

## 4b. Arti angka per platform & kemampuan pencarian

Tidak semua platform bisa dicari dengan cara sama; perbedaannya **menentukan arti angka di dashboard** (dokumentasikan di UI tooltip ⓘ). **Kolom "Pencarian teks bebas" adalah hipotesis** (sebagian dari dokumen pembanding) — hanya baris berstatus DOCS/TESTED yang boleh dianggap fakta.

| Platform | Pencarian teks bebas? | Status | Cara adapter | Arti angka |
|---|---|---|---|---|
| X / Twitter | Ya | **DOCS** (twitterapi.io, S-10) | query penuh + `since_time` (+ `since_id` bila terbukti) | semua post publik yang cocok |
| TikTok | Ya (via pihak ketiga) | **DOCS** (Apify, S-16) | keyword | semua video publik yang cocok (sejauh hasil search actor) |
| Threads | Ya — official (butuh App Review) & pihak ketiga | **DOCS** (S-13) | keyword `RECENT` + `since` | official: semua post publik cocok; pihak ketiga: **maks ~50–70 post/keyword/run** |
| **Instagram** | **Ya — via pihak ketiga tertentu** (scraping_solutions, crawlerbros); actor apify/apidojo hanya hashtag | **TESTED** (S-11, 2026-09-28) | keyword (boolean) + fallback hashtag | post publik yang ditemukan pencarian IG (caption & hashtag); cakupan < X karena IG search memilih hasil |
| **Facebook** | **Ya — via pihak ketiga** (scraper_one, scrapeforge) + daftar Page | **TESTED** (S-12, 2026-09-28) | keyword search posts; Page list untuk akun resmi | post publik yang muncul di pencarian FB + Page terkonfigurasi |
| YouTube | Ya | **DOCS** (S-17) | query penuh (OR `\|`) + `publishedAfter` + `order=date` | semua video publik cocok, **dibatasi 100 search/hari** |

- **Instagram — koreksi 2026-09-28 (uji kontrak):** keyword caption **tersedia** lewat actor lain (lihat §2.0); catatan di bawah hanya berlaku untuk actor `apify/instagram-scraper` & `apidojo`. Derivasi hashtag tetap dipakai sebagai cadangan recall.
- ~~**Instagram — diputuskan dari dokumen (S-11, 2026-09-28).**~~ Dokumen pembanding sempat mengklaim actor pihak ketiga bisa keyword caption (`searchType: "search"`). Halaman resmi dua actor yang disebut hanya menerima hashtag/profil/lokasi. Maka connector IG memakai operation `search_hashtag`: compiler menurunkan hashtag dari term positif query (+ `keywords`), local matcher tetap menilai caption. Tooltip UI wajib menyatakan "IG: hanya post ber-hashtag". Bila kelak ada vendor yang terbukti (contract test) mendukung keyword caption, cukup tambah connector + capability `search_keyword` — tanpa ubah core.
- **Facebook — koreksi 2026-09-28:** keyword search post publik tersedia via `scraper_one/facebook-posts-search` & `scrapeforge/facebook-search-posts` (TESTED). Catatan historis: sejak CrowdTangle ditutup, tak ada keyword search publik **resmi**; actor lama umumnya per-halaman. Adapter membaca daftar Page dari keyword berbentuk URL `facebook.com/...` atau `page:<nama>`. **Stream FB tanpa Page = skip biaya nol** (jangan jalankan run yang pasti sia-sia tapi tetap ditagih — CONNECTOR_SPEC §4a). Perluasan: UI pendaftaran Page per topic (FR-103), bukan mengubah adapter.

> **`usage.results` = hasil yang DIKEMBALIKAN provider, bukan yang disimpan/unik.** Ini dasar akurasi biaya (COST_MODEL §3). Connector yang mencatat hanya post tersimpan membuat pelacakan biaya terlihat sehat sementara tagihan membengkak. Ditegakkan di kontrak `FetchResult.usage` (CONNECTOR_SPEC §4a).

## 5. Catatan penting soal interval 5 menit

- Provider berbasis *run* (actor) memiliki waktu start + eksekusi. Jika `p95_latency` > interval, interval tsb **tidak feasible** untuk connector itu → router otomatis menolak via `min_interval_sec` terukur.
- Interval 5m × banyak sub-query × banyak topik mengalikan biaya. Gunakan cost estimate (FR-T05) dan pertimbangkan: 5m hanya untuk topik prioritas, 15m–1h untuk sisanya.

## 6. Fakta terverifikasi per connector

### 6.1 `twitterapi_io.x` — hasil S-10 (status: `review`, butuh reviewer ke-2)

```yaml
connector: twitterapi_io.x
provider_docs: https://docs.twitterapi.io/introduction
verified_at: 2026-09-28
verified_by: claude (agent) — menunggu reviewer manusia ke-2 (AC S-10)
api_surface:
  search: GET https://api.twitterapi.io/twitter/tweet/advanced_search   # docs.twitterapi.io/api-reference/endpoint/tweet_advanced_search
  auth_header: X-API-Key            # "Single x-api-key header, no OAuth"
  params:
    query: string (wajib) — operator Twitter search; contoh docs: '"AI" OR "Twitter" from:elonmusk since_time:1776045662'
    queryType: Latest | Top (wajib; kita pakai Latest)
    cursor: string ("" = halaman pertama)
  page_size: "up to 20" (bisa < 20 karena iklan disaring provider)
  response: { tweets[], has_next_page, next_cursor }
  tweet_fields: id, text, url, createdAt ("Tue Dec 10 07:00:30 +0000 2024" — BUKAN ISO, wajib diparse), likeCount, retweetCount,
                replyCount, quoteCount, viewCount, lang, isReply, inReplyToId, inReplyToUsername, author{}, retweeted_tweet, quoted_tweet
  author_fields: id, userName, name, isBlueVerified, followers, createdAt
operations:
  search_keyword: { status: DOCS, evidence: docs URL di atas }
  incremental:
    since_time/until_time (unix detik): DOCS
    since_id: UNVERIFIED — tidak ada di halaman endpoint; dokumen pembanding memakainya. Uji di S-14 sebelum diandalkan.
    catatan docs: "please don't use since:YYYY-MM-DD_HH:MM:SS_UTC ... it's not supported now"
rate_limit:
  value: KONFLIK — "Supports up to 200 QPS per client" (docs.twitterapi.io/introduction) vs "1000+ QPS" (twitterapi.io/readme)
         vs tabel per saldo 3/6/10/20 rps (twitterapi.io/qps-limits; free tier 1 request / 5 detik)
  source: tiga URL di atas, diakses 2026-09-28
  policy_awal: internal_safety, token bucket 3 rps / akun (angka terendah yang terdokumentasi) sampai S-14 mengukur
  http_status_saat_limit: tidak didokumentasikan → connector wajib memetakan 429 DAN pola lain ke RATE_LIMITED (uji S-14)
pricing:
  model: per result (tweet) + minimum per request
  value: "$0.15 per 1K tweets"; "$0.18 per 1K users"; "Minimum $0.00015 (15 Credits) per API call"; "1 USD = 100,000 Credits";
         "$0.0015 (150 Credits) per API call" untuk List function (berlaku 1 Okt)
  empty_response: DITAGIH minimum ("even if no data returned")
  source: https://twitterapi.io/pricing
  checked_at: 2026-09-28
measured:
  p50_latency_ms: null   # S-14 — butuh API key berbayar
  p95_latency_ms: null
  min_interval_sec: null
legal_notes: "independent third-party service. Not affiliated with X Corp." — ToS: https://twitterapi.io/terms (review S-15).
  Data bersumber dari X tanpa perjanjian dengan X Corp → risk_level = medium.
```

**Implikasi desain yang langsung berlaku:**
- `usage.costUnits` = `max(15, 15 × tweets_returned)` credit per request (bukan hanya per tweet) — CONNECTOR_SPEC §4a.
- Polling kosong tidak gratis: 1 stream @5m = 288 request/hari ≥ $0,043/hari walau tidak ada tweet baru. Di 100 stream X @5m ≈ $130/bln **hanya biaya minimum** → interval 5m hanya untuk stream prioritas (COST_MODEL §3).
- `createdAt` bukan ISO-8601 → normalizer wajib parse format Twitter klasik; gagal parse → tolak item (`UNPARSEABLE_TIMESTAMP`), jangan tebak.
- ID tweet dibandingkan sebagai **integer/BigInt**, bukan string (`"9" > "10"` secara leksikal → cursor mundur → bayar ulang). Pelajaran dari dokumen pembanding (T-012).

### 6.2 X cadangan — hasil S-10 (lanjutan) · status `review`
```yaml
apify.x:
  actor: kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest
  source: https://apify.com/kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest   # 2026-09-28
  pricing: "$0.18-$0.25 per 1,000 tweets" + "minimum charge of $X per API call, even if the response contains no results" (X tidak disebut → UNVERIFIED)
  inputs: searchTerms (sintaks advanced search), since_time/until_time (unix), maxItems (min 20), queryType Latest|Top|Photos|Videos
x_api.x:
  source: https://docs.x.com/x-api/getting-started/pricing   # 2026-09-28
  pricing: "$0.005 per resource" (post read); owned reads $0.001; cap "3 million Post reads per monthly billing cycle" → Enterprise
```

### 6.3 Instagram — hasil S-11 (dokumen) · status `review`, contract test di-skip (tanpa akun)
```yaml
meta_graph.instagram:
  source: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/hashtag-search
  requirements: akun Business/Creator, instagram_basic, fitur "Instagram Public Content Access" (App Review)
  limit: "30 unique hashtags … within a rolling, 7 day period" (per akun IG)
  operations: { search_hashtag: DOCS (recent_media/top_media), search_keyword: NOT_AVAILABLE }
apify.instagram (apidojo/instagram-scraper):
  source: https://apify.com/apidojo/instagram-scraper
  pricing: "from $0.47 / 1,000 posts" (pay-per-result, tanpa platform fee)
  inputs: startUrls (profil, explore/tags, explore/locations, audio, tagged), maxItems, until (= lebih baru dari tanggal)
  operations: { search_hashtag: DOCS, user_timeline: DOCS, search_keyword: NOT_AVAILABLE (DOCS) }
apify.instagram_official_actor (apify/instagram-scraper):
  source: https://apify.com/apify/instagram-scraper
  pricing: $2.70 (free) / $2.30 (starter) / $1.50–1.90 (scale/business) per 1K results
  inputs: searchType hashtag|profile|place, search, resultsType, resultsLimit, onlyPostsNewerThan
  operations: { search_hashtag: DOCS, search_keyword: NOT_AVAILABLE (DOCS) }
```

### 6.4 Facebook — hasil S-12 (dokumen) · status `review`
```yaml
apify.facebook (apify/facebook-posts-scraper):
  source: https://apify.com/apify/facebook-posts-scraper
  pricing: "from $2.00 / 1,000 posts"
  inputs: startUrls (URL Page), resultsLimit, onlyPostsNewerThan/onlyPostsOlderThan
  operations: { user_timeline: DOCS, search_keyword: NOT_AVAILABLE (DOCS) }
meta_graph.facebook: UNVERIFIED (hanya Page yang dikelola / fitur Page Public Content Access — belum dicek)
```

### 6.5 Threads — hasil S-13 (dokumen) · status `review`
```yaml
threads_api.threads:
  source: https://developers.facebook.com/docs/threads/keyword-search
  endpoint: GET /v1.0/keyword_search   (q, search_type TOP|RECENT, since, until, limit)
  permission: threads_keyword_search — tanpa approval "only on posts owned by the authenticated user"
  rate_limit: "maximum of 2,200 queries within a rolling 24-hour period" (per user)  → source: provider_docs
  page_size: default 25, max 100
  fields: id, text, media_type, permalink, timestamp, username, has_replies, is_quote_post, is_reply
  catatan: tidak ada metrik engagement di field keyword search → engagement via endpoint insights/lain (UNVERIFIED)
apify.threads (scrapersdelight/threads-keyword-search-scraper):
  source: https://apify.com/scrapersdelight/threads-keyword-search-scraper
  pricing: "$1.00 / 1,000 per post returned", tanpa start fee
  batasan: tanpa cursor; ~50–70 post unik/keyword maksimum; postedWithinDays
```
Implikasi: 2.200 query/24 jam ÷ 96 (poll 15m) ≈ 22 stream Threads per akun → cukup untuk ~30 topic dengan collection stream; lebih dari itu butuh akun tambahan (router multi-account).

### 6.6 TikTok — hasil S-16 (dokumen) · status `review`
```yaml
tiktok_research_api: NOT_AVAILABLE — "independent of commercial interests … not-for-profit or non-commercial basis" (developers.tiktok.com/products/research-api)
apify.tiktok (clockworks/tiktok-scraper):
  source: https://apify.com/clockworks/tiktok-scraper
  pricing: "$1.70 per 1,000 results" (komentar ditagih sebagai hasil → matikan default)
  inputs: search / hashtags / profiles / video URLs
  fields: createTime, playCount, diggCount, shareCount, commentCount, authorMeta
```

### 6.7 YouTube — hasil S-17 (dokumen) · status `review`
```yaml
youtube_data_api.youtube:
  source: https://developers.google.com/youtube/v3/determine_quota_cost ; https://developers.google.com/youtube/v3/docs/search/list
  quota: "100 search.list calls … and 10,000 units per day combined for all other endpoints"; reset tengah malam PT
  search.list: 1 unit di bucket "Search Queries"; q mendukung NOT (-) & OR (|); publishedAfter RFC 3339; order=date; maxResults ≤ 50
  statistik: TIDAK ada di search.list → videos.list (1 unit, ≤ 50 id/panggilan) untuk views/likes
```
Implikasi: 100 search/hari = ~4 stream @1h. Mitigasi: (1) gabungkan term satu stream dengan `|` (satu search per stream), (2) YouTube default interval 1h, (3) ajukan audit & quota extension Google sebelum > 4 stream, (4) cadangan Apify. Quota ini dimodelkan sebagai `quota_policies` scope connector, unit `requests`, period `day`, hard.

### 6.8 Hasil uji kontrak Apify (2026-09-28) · status `TESTED` (1 sampel/actor — latency p50/p95 butuh ≥ 5 sampel, S-14)

Kata kunci "koperasi merah putih", batas biaya keras per run (`maxTotalChargeUsd`), memori 1 GB kecuali actor memaksa lebih. Total biaya uji ≈ $0,77 dari kuota FREE $5/bln. Detail per actor: `docs/evidence/S-11/ig-keyword-contract.json`, `docs/evidence/S-11-S-17/apify-contract.json`.

| Actor | Durasi | Item | Relevan | Rentang waktu hasil | Field waktu (format) | Field id / likes / author |
|---|---:|---:|---:|---|---|---|
| xquik/x-tweet-scraper | 4 s | 20 | 20 | 16 jam terakhir | `createdAt` ("Mon Sep 28 01:22:46 +0000 2026") | id / likeCount / author |
| apidojo/tweet-scraper | 52 s | 10 | 10 | 9 jam | `createdAt` (sama) | id / likeCount / author |
| scraping_solutions IG boolean | 21 s | 8 | 8 (1 caption-only) | Mei–Jun 2026 | `publishedAt` ISO +00:00 | shortCode / likeCount / username |
| crawlerbros IG keyword | 32 s | 10 | 9 (2 caption-only) | 25–27 Sep | `pub_date` ISO **tanpa offset** | shortcode / like_count / username |
| viralanalyzer IG keyword | 44 s | 0 | — | — | — | `BLOCKED` login wall |
| scraper_one FB search | 19 s | 11 | 11 | 3 jam terakhir | `timestamp` epoch **ms** | postId / reactionsCount / author |
| scrapeforge FB search | 13 s | 8 | 7 | Jun–Sep | `timestamp` epoch **detik** | post_id / reactions_count / author |
| futurizerush Threads | 25 s | 10 | 10 | 6 hari | `created_at` ISO +00:00 | post_code / like_count / username |
| apidojo TikTok | 52 s | 10 | 9 | Jun–Sep | `uploadedAt` epoch detik | id / likes / channel |
| streamers YouTube | 73 s | 10 | 10 | Jul 2025–Sep 2026 | `date` ISO Z | id / likes / channelName |

Implikasi untuk connector (CONNECTOR_SPEC §4, §12):
- **Format waktu beragam** (Twitter klasik, ISO dengan/tanpa offset, epoch detik, epoch ms) → normalizer per connector wajib eksplisit; ISO **tanpa offset** (crawlerbros) = tolak item (`UNPARSEABLE_TIMESTAMP`) kecuali dokumen/uji membuktikan UTC — README menjanjikan `+00:00` tapi output tidak.
- **Keterurutan hasil berbeda** (terbaru vs relevansi) → `resultOrder` di manifest (CONNECTOR_SPEC §2) dan strategi inkremental: actor tak terurut butuh filter tanggal (`oldestPostDate`, `start_date`, `dateRange`) + saring ID lokal.
- **Data pribadi berlebih** (email, telepon, bio) di output sebagian actor → normalizer hanya memetakan field CanonicalItem; field lain dibuang, **tidak** masuk `extra` (SECURITY §9 minimisasi).
- **Biaya start per GB memori** → connector Apify wajib men-set `memory` minimum yang lolos uji, dan `maxTotalChargeUsd` per run sebagai cost guard lapis 0.
