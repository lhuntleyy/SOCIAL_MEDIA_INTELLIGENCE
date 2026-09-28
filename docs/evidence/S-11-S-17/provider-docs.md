# S-10 (sisa), S-11, S-12, S-13, S-16, S-17 — verifikasi dokumen provider

- Tanggal akses: 2026-09-28 · Pelaksana: claude (agent) · **Status: `review`** (butuh reviewer manusia ke-2).
- Bagian **uji kontrak** (contract test dengan akun/API key nyata) **di-skip atas arahan pemilik produk** (2026-09-28) → tetap terbuka di S-14.
- Hasil terstruktur: PROVIDER_MATRIX §6.2–§6.7.

| Task | Sumber (primer) | Kutipan / fakta |
|---|---|---|
| S-10 X official | https://docs.x.com/x-api/getting-started/pricing | Posts read "$0.005 per resource"; "Owned Reads … $0.001 per resource"; "3 million Post reads per monthly billing cycle" (lebih → Enterprise); tanpa tier bulanan |
| S-10 Apify X | https://apify.com/kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest | "$0.18-$0.25 per 1,000 tweets"; ada "minimum charge … per API call, even if the response contains no results" (angka tidak disebut); `since_time`/`until_time`; `maxItems` minimum 20 |
| S-11 IG Graph API | https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/hashtag-search | Akun Business/Creator; `instagram_basic` + fitur "Instagram Public Content Access" (App Review); "30 unique hashtags … within a rolling, 7 day period"; `ig_hashtag_search`, `recent_media`, `top_media`; tidak ada keyword non-hashtag |
| S-11 Apify IG | https://apify.com/apify/instagram-scraper | `searchType`: hashtag, profile, place — **bukan caption keyword**; $1,50–2,70/1K tergantung plan; `onlyPostsNewerThan` |
| S-11 Apify IG (apidojo) | https://apify.com/apidojo/instagram-scraper | "from $0.47 / 1,000 posts"; input = URL profil/hashtag/lokasi; "doesn't perform arbitrary caption-based keyword searches"; filter `until` (= lebih baru dari) |
| S-12 FB | https://apify.com/apify/facebook-posts-scraper | "from $2.00 / 1,000 posts"; `startUrls` = URL Page; `onlyPostsNewerThan`/`onlyPostsOlderThan`; **tidak ada keyword search lintas Facebook** |
| S-13 Threads official | https://developers.facebook.com/docs/threads/keyword-search | `/v1.0/keyword_search`, permission `threads_keyword_search`; tanpa approval → hanya post milik user sendiri; "maximum of 2,200 queries within a rolling 24-hour period"; `search_type` TOP/RECENT; `since`/`until` (unix, ≥ 1688540400); default 25, maks 100/request |
| S-13 Threads Apify | https://apify.com/scrapersdelight/threads-keyword-search-scraper | "$1.00 / 1,000 per post returned", tanpa start fee; **tanpa cursor paginasi** → ~50–70 post unik/keyword maksimum; `postedWithinDays` |
| S-16 TikTok Research API | https://developers.tiktok.com/products/research-api/ | Hanya peneliti non-komersial (akademik/nirlaba di wilayah tertentu) → **tidak tersedia untuk produk ini** |
| S-16 TikTok Apify | https://apify.com/clockworks/tiktok-scraper | "$1.70 per 1,000 results"; input `search`/hashtag/profil; komentar opsional (`commentsPerPost`, ditagih sebagai hasil) |
| S-17 YouTube quota | https://developers.google.com/youtube/v3/determine_quota_cost | "100 `search.list` calls … and 10,000 units per day combined for all other endpoints"; `videos.list` 1 unit; reset tengah malam PT |
| S-17 YouTube search | https://developers.google.com/youtube/v3/docs/search/list | "quota cost of 1 unit in the Search Queries quota bucket"; `publishedAfter` RFC 3339; `order=date`; `maxResults` 0–50; `q` mendukung NOT (`-`) & OR (`\|`); **tidak mengembalikan statistik** (butuh `videos.list`) |

## Koreksi terhadap asumsi sebelumnya
1. **Instagram keyword search via pihak ketiga — tidak didukung** oleh dua actor yang disebut dokumen pembanding (keduanya hashtag/profil/lokasi). Dokumen pembanding (koreksi 2026-09-03) menyebut `searchType: "search"`; nilai itu tidak ada di daftar input actor resmi. Status: NOT_AVAILABLE (DOCS) untuk dua actor ini; vendor lain belum dicek.
2. **Threads official keyword search ada** (dengan App Review). Klaim "Threads API hanya publishing" keliru.
3. **YouTube**: model quota bukan lagi "search = 100 unit dari 10.000", melainkan bucket terpisah 100 search/hari — efek sama (~100 search/hari) tapi harus dimodelkan sebagai quota tersendiri.
4. Harga IG apidojo $0,47/1K (estimasi v0.3: $1,50).
