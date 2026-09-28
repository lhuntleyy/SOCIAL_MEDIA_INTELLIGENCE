# S-07 — ClickHouse: DDL, MV sign-based, dedup token, performa FINAL feed

- Tanggal: 2026-09-28 · ClickHouse 26.10.1.832 (binary resmi, single node) · host 2 vCPU / 1,9 GB · `@clickhouse/client` 1.23.1 di Bun 1.4.2
- Uji fungsional otomatis: `bun run compat clickhouse` → [compat/results.md](../compat/results.md) (baris S-07)

## Hasil fungsional
| Uji | Hasil |
|---|---|
| Override sentiment pasangan sign −1/+1 → `agg_topic_1h` | benar tanpa UPDATE |
| `engagement_known_posts` | memisahkan "tak diketahui" dari 0 |
| `topic_matches` (ReplacingMergeTree, MV `sign=1`) + FINAL | 1 baris label terbaru |
| `insert_deduplication_token` (token sama 2×) | 1 baris di mode default server (`async_insert=1`), `async_insert=0`, dan `async_insert_deduplicate=1` |
| Token **tanpa** `non_replicated_deduplication_window` | **2 baris — token diabaikan diam-diam** → setting tabel WAJIB (DATA_MODEL §6.2) |
| `agg_author_1d` SummingMergeTree (v0.3) | followers 1000+1100 **dijumlah = 2100** (bug terbukti) |
| `agg_author_1d` AggregatingMergeTree + `SimpleAggregateFunction(anyLast)` (v0.4) | 1100 ✓ |
| `media_items` MV `ARRAY JOIN media` | 2 baris/post (kolom `media` baru di events) |
| ORDER BY kolom Nullable | ditolak (`allow_nullable_key` off) → geo unknown = `''` |

## Performa FINAL feed (AC "catatan performa")
Data sintetis 2,1 juta baris (3 tenant × 5 topic × 4 platform, 60 hari, 5% post punya versi kedua). Query: 1 tenant/topic, window 7 hari, `ORDER BY published_at DESC LIMIT 50`, 30 iterasi `clickhouse benchmark -c 1`. Baris cocok di window setelah FINAL: 13.440.

| Skema `topic_matches` | p50 | p95 | p99 |
|---|---:|---:|---:|
| v0.3 ORDER BY (tenant, topic, platform, post_id) + FINAL | 72 ms | 73 ms | 89 ms |
| v0.3 tanpa FINAL (hasil bisa duplikat) | 13 ms | 16 ms | 19 ms |
| **v0.4 ORDER BY (tenant, topic, published_at, platform, post_id) + FINAL** | **18 ms** | **22 ms** | **25 ms** |

Output mentah: [final-benchmark.txt](final-benchmark.txt). Kesimpulan: FINAL layak untuk feed (target NFR-04 p95 ≤ 1,5 s jauh di atas), dengan syarat `published_at` di sorting key. Uji ulang pada volume produksi (H-01).

## Reproduksi
```bash
scripts/spike-infra.sh start
bun run compat clickhouse
# benchmark: perintah di bagian bawah final-benchmark.txt
```
