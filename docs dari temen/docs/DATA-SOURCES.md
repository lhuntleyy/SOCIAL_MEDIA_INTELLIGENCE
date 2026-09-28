# Sumber Data & Provider

Dokumen pendamping [PRD.md](../PRD.md) dan [ARCHITECTURE.md](ARCHITECTURE.md). Berisi keputusan provider, kontrak adapter, dan rencana cadangan.

Harga per September 2026. Tautan sumber di bagian 7 — **verifikasi ulang sebelum committing budget**, tarif scraping berubah cukup sering.

---

## 1. Kenapa Third-Party, Bukan API Resmi

Ini bukan keputusan penghematan. Untuk sebagian besar platform, API resmi **tidak bisa** melakukan yang produk ini butuhkan.

| Platform | API resmi | Bisa cari keyword publik? | Putusan |
|---|---|---|---|
| X / Twitter | Pay-per-use, ~$5/1K post dibaca | Ya | Terlalu mahal — 33x harga third-party |
| Instagram | Graph API | **Tidak** — hanya akun sendiri | Tidak bisa dipakai |
| Facebook | Graph API | **Tidak** — Page sendiri saja sejak CrowdTangle ditutup | Tidak bisa dipakai |
| TikTok | Research API | Terbatas, khusus akademik, perlu approval | Tidak praktis |
| Threads | API | **Tidak** — hanya publishing | Tidak bisa dipakai |
| YouTube | Data API v3 | Ya, gratis dalam batas quota | **Dipakai** |
| Reddit | API resmi | Ya | Dipakai di Fase 4 |
| Bluesky | AT Protocol | Ya, gratis | Dipakai di Fase 4 |

**Kesimpulan:** empat dari enam platform Fase 1 sama sekali tidak menyediakan pencarian keyword publik lewat jalur resmi. Fitur inti produk — "cari semua post yang cocok query boolean ini" — hanya bisa dibangun di atas provider third-party.

Ini juga berarti risiko provider adalah risiko eksistensial, bukan sekadar merepotkan. Karena itu bagian 4 (rencana cadangan) bukan pelengkap.

---

## 2. Provider Terpilih

| Platform | Provider | Harga | Model penagihan |
|---|---|---|---|
| X / Twitter | twitterapi.io | $0,15 / 1K post | Pay per result, tanpa biaya bulanan |
| Instagram | Apify actor | $1,50 / 1K hasil | Pay per result + $29/bln platform |
| TikTok | Apify actor | $1,70 / 1K hasil | idem |
| Facebook | Apify actor | $2,00 / 1K hasil | idem |
| Threads | Apify actor | ~$1,50 / 1K hasil | idem |
| YouTube | Data API v3 | Gratis | Quota 10.000 unit/hari |

Biaya Apify $29/bulan dibayar sekali untuk semua platform Apify — itu sebabnya di skenario satu-topic bebannya terasa berat, dan hampir tidak terasa di 30 topic.

### Catatan per platform

**X / Twitter** — sumber volume terbesar (~89% korpus, lihat [COST-MODEL.md](COST-MODEL.md)). Punya dukungan `since_id` yang benar, jadi fetch inkremental bersih dan overhead rendah. Ini platform yang paling penting untuk dioptimalkan dan sekaligus paling mudah dioptimalkan.

**Instagram, TikTok, Facebook, Threads** — lewat Apify actor. Berperilaku sebagai *run*, bukan request: mulai run, poll sampai selesai, ambil dataset. Konsekuensinya penting untuk biaya:

> Apify menagih per hasil yang dikembalikan actor, bukan per hasil unik yang baru bagi kita. Kalau actor mengembalikan 25 item dan 23 di antaranya sudah kita punya, kita tetap membayar 25.

Karena itu `maxItems` harus diketatkan dan interval polling untuk platform-platform ini harus lebih longgar daripada X. Detail penanganannya di [COST-MODEL.md bagian 4](COST-MODEL.md#4-jebakan-polling).

**YouTube** — gratis tapi ada quota. Pencarian menghabiskan 100 unit; quota harian 10.000 unit berarti sekitar 100 pencarian per hari. Cukup untuk polling per jam pada beberapa stream. Kehabisan quota harus menurunkan interval dengan anggun, bukan bikin crash (T-018).

### Kemampuan pencarian per platform

Ditemukan saat mengerjakan T-014 s/d T-017. **Tidak semua platform bisa dicari dengan cara yang sama**, dan perbedaannya menentukan arti angka di dashboard.

| Platform | Pencarian teks bebas? | Cara adapter bekerja | Arti angkanya |
|---|---|---|---|
| X / Twitter | Ya | Query penuh + `since_id` | Semua post publik yang cocok |
| TikTok | Ya | Keyword apa adanya | Semua video publik yang cocok |
| Threads | Ya | Keyword apa adanya | Semua post publik yang cocok |
| Instagram | Ya (lewat pihak ketiga) | Keyword apa adanya | Semua post publik yang cocok |
| **Facebook** | **Tidak** | Butuh daftar **Page** per topic | **Hanya Page yang dikonfigurasi** |
| YouTube | Ya | Query penuh + `publishedAfter` | Semua video publik yang cocok |

**Instagram — dan pembedaan yang mudah salah.** Graph API **resmi** Instagram tidak punya pencarian keyword publik. Itu benar, dan itu sebabnya jalur resmi tidak dipakai (lihat bagian 1).

Tapi batasan itu **tidak berlaku untuk actor pihak ketiga**. Actor Apify membaca antarmuka pencarian Instagram sendiri, yang mendukung pencarian konten — post yang menyebut sebuah kata di caption ikut terkumpul walaupun tanpa hashtag. Adapter memakai `searchType: "search"` sebagai default.

Menyamakan batasan API resmi dengan batasan pihak ketiga akan memangkas cakupan Instagram tanpa alasan, dan membuat angkanya di dashboard lebih rendah daripada kenyataan.

Mode hashtag masih tersedia lewat `InstagramAdapter(search_type="hashtag")` untuk topic berbasis kampanye tagar, di mana pencarian tagar lebih presisi daripada pencarian teks.

**Facebook.** Batasan paling berat. Sejak CrowdTangle ditutup, tidak ada pencarian keyword publik yang bisa diandalkan; actor pihak ketiga umumnya bekerja per-halaman (diberi URL Page, mengambil post-nya). Adapter membaca daftar Page dari keyword yang berbentuk URL `facebook.com/...` atau `page:<nama>`.

**Stream Facebook tanpa Page yang ditentukan tidak menghasilkan apa-apa**, dan adapter sengaja melewatinya dengan biaya nol alih-alih menjalankan run yang pasti sia-sia tapi tetap ditagih. Facebook hanya 0,24% korpus referensi — angka yang mungkin justru mencerminkan keterbatasan yang sama di produk pembanding.

Kalau Facebook kelak jadi penting, jalannya adalah menambah UI pendaftaran Page per topic (perluasan FR-103), bukan mengubah adapternya.

---

## 3. Kontrak SourceAdapter

```python
from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass(frozen=True)
class Cursor:
    """Posisi ingestion, khusus per platform.

    twitterapi.io  -> {"since_id": "..."}
    Apify          -> {"last_seen_ids": [...], "last_run_at": "..."}
    YouTube        -> {"published_after": "..."}
    """

    data: dict


@dataclass(frozen=True)
class CostRecord:
    provider: str
    unit_count: int  # jumlah hasil yang DIKEMBALIKAN, bukan yang disimpan
    unit_cost: float  # USD per unit
    total_cost: float


@dataclass
class FetchResult:
    posts: list[RawPost]
    next_cursor: Cursor | None
    cost: CostRecord
    rate_limit: RateLimitInfo | None


class SourceAdapter(ABC):
    platform: Platform

    @abstractmethod
    async def fetch(self, stream: CollectionStream, cursor: Cursor | None) -> FetchResult:
        """Ambil post baru sejak cursor.

        Kontrak:
        - WAJIB inkremental. Kalau cursor diberikan, hanya ambil yang lebih baru.
        - WAJIB melaporkan biaya sebenarnya, dihitung dari hasil yang
          dikembalikan provider — bukan dari hasil yang kita simpan.
        - WAJIB menghormati maxItems dari konfigurasi stream.
        - Boleh mengembalikan post duplikat; dedup ada di hilir.
        """

    @abstractmethod
    def estimate_cost(self, expected_results: int) -> float:
        """Estimasi biaya sebelum fetch. Dipakai preview (FR-107) dan cap (FR-702)."""
```

### Kenapa `cost` bagian dari nilai balik

Kalau pencatatan biaya berupa efek samping — adapter menulis ke database sendiri — maka adapter yang lupa mencatat akan menghabiskan uang secara diam-diam, dan kesalahannya baru ketahuan saat tagihan datang.

Dengan menjadikannya bagian dari `FetchResult`, adapter yang tidak melaporkan biaya tidak akan lolos type check. Kesalahan yang mungkin, jadi kesalahan yang mustahil.

### Kenapa `unit_count` adalah hasil yang dikembalikan, bukan yang disimpan

Ini pembedaan yang paling gampang salah, dan salahnya mahal. Provider menagih untuk apa yang mereka kirim. Kalau kita mencatat hanya post baru yang benar-benar disimpan, pencatatan biaya akan terlihat sehat sementara tagihan sebenarnya membengkak — persis mode kegagalan yang ingin dicegah oleh FR-701.

---

## 4. Rencana Cadangan

Setiap platform butuh minimal satu alternatif yang sudah teridentifikasi **sebelum** dibutuhkan. Kalau provider mati mendadak, waktu bukan untuk riset.

| Platform | Utama | Cadangan 1 | Cadangan 2 |
|---|---|---|---|
| X / Twitter | twitterapi.io ($0,15/1K) | Apify actor kaitoeasyapi ($0,25/1K) | Apify xtdata ($0,40/1K) |
| Instagram | Apify apidojo ($1,50/1K) | ScrapeCreators (~$1,88/1K) | Bright Data (~$1,50–2,50/1K) |
| TikTok | Apify ($1,70/1K) | EnsembleData (langganan) | ScrapeCreators |
| Facebook | Apify ($2,00/1K) | Bright Data | ScrapeCreators |
| Threads | Apify (~$1,50/1K) | EnsembleData | ScrapeCreators |
| YouTube | Data API v3 (gratis) | Apify actor | — |

### Kriteria pemicu pindah provider

Pindah ke cadangan kalau salah satu terjadi:
- Tingkat error di atas 20% selama lebih dari 6 jam
- Harga naik lebih dari 50%
- Kesenjangan data terdeteksi (spot check menemukan post yang seharusnya ada tapi tidak terkumpul)
- Provider mengumumkan penghentian layanan

Karena semua provider berada di balik interface `SourceAdapter`, pindah berarti menulis satu kelas adapter baru dan mengganti satu baris konfigurasi. Perkiraan waktu: 1–2 hari per platform.

---

## 5. Strategi Fetch Inkremental

Setiap platform butuh pendekatan berbeda. Ini yang menentukan apakah model biaya bertahan atau runtuh.

| Platform | Mekanisme | Overhead | Catatan |
|---|---|---|---|
| X / Twitter | `since_id` | ~1,1x | Terbersih. Provider hanya mengembalikan yang lebih baru dari ID |
| Instagram | Filter timestamp + saring ID lokal | ~1,4x | Actor mengembalikan N terbaru; kita buang yang sudah ada tapi tetap bayar |
| TikTok | idem | ~1,4x | idem |
| Facebook | idem | ~1,4x | idem |
| Threads | idem | ~1,4x | idem |
| YouTube | `publishedAfter` | ~1,1x | Didukung API dengan benar |

**Overhead rata-rata terbobot: ~1,25x** — karena X mendominasi volume dan overhead-nya rendah.

Untuk platform yang tidak punya cursor sejati, mitigasinya:
1. `maxItems` diketatkan (25–50 per run, bukan 100+)
2. Interval polling lebih longgar (30 menit sampai 1 jam, bukan 5 menit)
3. Adaptive polling melambat saat stream sepi (FR-203)
4. Filter ID lokal membuang duplikat sebelum masuk storage

Poin 1 dan 2 yang paling menentukan. Poin 4 menjaga kebersihan data tapi **tidak menghemat uang** — biayanya sudah terjadi saat actor mengembalikan hasil.

---

## 6. Legal & Kepatuhan

Bagian ini merangkum posisi kita. Bukan nasihat hukum — lihat [PRD.md bagian 11](../PRD.md#11-risiko--mitigasi), review hukum direkomendasikan sebelum produksi.

**Yang dikumpulkan:** konten publik dan metadata penulis yang tersedia publik (username, display name, jumlah follower, bio). Tidak ada akun privat, tidak ada DM, tidak ada konten di balik login.

**ToS platform.** Sebagian besar platform melarang scraping otomatis di ketentuan layanannya. Memakai third-party provider memindahkan aktivitas pengumpulan ke pihak mereka, tapi tidak menghilangkan pertanyaannya. Ini risiko yang diketahui dan diterima, sama seperti seluruh industri social listening. Yang mengurangi paparan:
- Hanya konten publik
- Tidak menembus rate limit sendiri
- Tidak melakukan rekayasa balik terhadap API privat
- Retensi terbatas 12 bulan

**UU PDP (Perlindungan Data Pribadi).** Data publik umumnya di luar cakupan paling ketat, tapi kombinasi profiling, retensi berkepanjangan, dan inferensi demografi (Fase 3) memindahkan produk ini ke wilayah yang perlu kehati-hatian. Kontrol yang sudah masuk desain:
- Analisis level agregat sebagai default (FR di PRD tidak ada yang butuh pelacakan individu)
- Retensi mentah 12 bulan, otomatis (FR-208)
- Audit log untuk semua akses (FR-603)
- Minimisasi data — tidak menyimpan field profil yang tidak dipakai fitur mana pun

**Yang membutuhkan review hukum sebelum Fase 3:** inferensi demografi berarti menurunkan gender, umur, dan lokasi seseorang dari data publik. Ini profiling, dan penanganannya di UU PDP lebih ketat daripada penyimpanan data publik biasa.

---

## 7. Sumber Harga

Diverifikasi September 2026. Cek ulang sebelum committing budget.

- [X (Twitter) API Pricing 2026 — Postproxy](https://postproxy.dev/blog/x-api-pricing-2026/)
- [twitterapi.io](https://twitterapi.io/)
- [Best Social Media Scrapers on Apify 2026](https://use-apify.com/docs/best-apify-actors/best-social-media-scrapers)
- [Apify Instagram Scraper (pay per result)](https://apify.com/apidojo/instagram-scraper)
- [Best Twitter/X Scrapers on Apify 2026](https://use-apify.com/docs/best-apify-actors/best-twitter-scrapers)
- [Best Social Media Scraping APIs 2026 — ScrapeCreators](https://scrapecreators.com/blog/best-social-media-scraping-apis)
- [YouTube Data API v3 quota](https://developers.google.com/youtube/v3/determine_quota_cost)
