# Ringkasan connector verify (live, Apify)

| Connector | Status | Sampel | Item valid | p50 ms | p95 ms | Field janji terisi |
|---|---|---|---|---|---|---|
| `apify.facebook.scraperone` | verified | 5 | 6 | 2932 | 10897 | metrics.likes 100%, metrics.comments 100% |
| `apify.instagram.boolean` | verified | 5 | 5 | 7095 | 10969 | metrics.likes 100%, metrics.comments 100% |
| `apify.threads.scrapersdelight` | verified | 5 | 25 | 7139 | 8035 | metrics.likes 100%, metrics.comments 100% |
| `apify.tiktok.clockworks` | verified | 5 | 25 | 15379 | 24422 | metrics.likes 100%, metrics.views 100%, author.followers 100% |
| `apify.tiktok.xmolodtsov` | verified | 5 | 20 | 7373 | 8151 | metrics.likes 100%, metrics.views 100%, author.followers 100% |
| `apify.x.kaito` | verified | 5 | 25 | 12528 | 15105 | metrics.likes 100%, metrics.views 100%, author.followers 100% |
| `apify.x.scraperone` | verified | 5 | 10 | 3649 | 9942 | metrics.likes 100%, metrics.comments 100% |
| `apify.x.xquik` | verified | 5 | 50 | 5545 | 5883 | metrics.likes 100%, metrics.views 100%, author.followers 100% |
| `apify.youtube.streamers` | verified | 1 | 4 | 18341 | 18341 | metrics.views 100%, author.followers 100% |

**Ditolak pemilik (2026-09-29):** actor penerbit `apidojo` (`apify.x.apidojo`, `apify.tiktok.apidojo`) — plan FREE punya batas run bulanan per pengguna (log: "Monthly run limit exceeded per user"; actor hanya mengembalikan placeholder `noResults`). Laporan lama di `ditolak/`. Pengganti: X → `apify.x.kaito`, `apify.x.scraperone`; TikTok → `apify.tiktok.clockworks`, `apify.tiktok.xmolodtsov`.

**Biaya nyata** (selisih pemakaian akun, lebih akurat dari `cost_usd` per run yang bisa tertinggal): probe + verify I-17/I-18 ≈ $0,71 (akun $1,67 → $2,39 dari kuota FREE $5/bln, 2026-09-29). Termahal: TikTok clockworks (~$0,024/run 5 item: hasil $3/1K + filter tanggal/sortir berbayar) dan YouTube (~$0,04/run).
