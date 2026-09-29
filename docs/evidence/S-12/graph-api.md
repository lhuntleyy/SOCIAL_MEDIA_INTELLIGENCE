# S-12 — Facebook official: pencarian post publik per kata kunci (cek 2026-09-29, status DOCS)

| Jalur | Keyword search post publik? | Bisa dipakai SMIP (komersial)? | Sumber |
|---|---|---|---|
| Graph API (`/search`) | **Tidak** — dihapus sejak Graph API v2.0 (2015); cakupan search tersisa: Pages, Places, Events. Konten Page publik butuh izin *Page Public Content Access* (App Review) dan tetap bukan pencarian bebas. | Tidak untuk keyword monitoring | [Graph API docs](https://developers.facebook.com/docs/graph-api/), [ringkasan data365](https://data365.co/facebook-search-api) |
| Meta Content Library + API | Ya (FB, IG, Threads, WhatsApp Channels; ≤ 100.000 hasil/query) | **Tidak** — "Affiliation with an academic institution or other non-university organization … which operates as a not-for-profit entity … is required to be eligible"; entitas komersial tidak eligible | [Transparency Center](https://transparency.meta.com/researchtools/meta-content-library), [developer docs](https://developers.facebook.com/docs/content-library-and-api/) |
| Ad Library API | Ya, hanya iklan (politik global; komersial UK/EU) | Hanya untuk fitur iklan, bukan post organik | idem |

**Kesimpulan:** tidak ada jalur official untuk keyword search post FB organik bagi SMIP → ladder FB tetap third-party
(`apify.facebook.scraperone` VERIFIED, cadangan scrapeforge) sesuai PROVIDER_MATRIX; Graph API hanya relevan untuk
`user_timeline` Page milik/terhubung klien (App Review PPCA) — di luar MVP.
