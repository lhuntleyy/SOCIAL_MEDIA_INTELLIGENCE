# Hasil compat-check Fase 0

Dibuat otomatis oleh `bun run compat` — 2026-09-28T02:02:03.964Z. Bun 1.4.2 (744846f84), linux x64, 2 vCPU, 1.9 GB.
Reproduksi: `scripts/spike-infra.sh start && bun run compat` (VAULT_ADDR/VAULT_TOKEN opsional untuk Vault transit).

| Task | Check | Status | Durasi | Catatan |
|---|---|---|---:|---|
| S-01 | `biome` | **COMPATIBLE** | 115 ms | biome lint via `bun --bun` mendeteksi noExplicitAny & noDoubleEquals, exit ≠ 0 |
| S-02 | `hono` | **WORKAROUND** | 24014 ms | routing + middleware OK<br>SSE streaming inkremental OK (event pertama 0 ms, 3 event)<br>GOTCHA: Bun.serve default idleTimeout (10 s) MEMUTUS SSE yang diam 12 s (dapat 1/2 event). API_SPEC heartbeat 25 s → wajib Bun.serve({ idleTimeout: 0 }) untuk route SSE atau heartbeat < 10 s.<br>workaround Bun.serve({ idleTimeout: 0 }) terbukti: 2/2 event |
| S-02 | `zod` | **COMPATIBLE** | 13 ms | safeParse/default/issue path OK<br>z.toJSONSchema → https://json-schema.org/draft/2020-12/schema (kontrak packages/contracts bisa digenerate tanpa lib tambahan) |
| S-02 | `jose` | **COMPATIBLE** | 14 ms | EdDSA: sign/verify/tamper-reject OK<br>ES256: sign/verify/tamper-reject OK |
| S-08 | `bun-builtins` | **COMPATIBLE** | 198 ms | Bun.password argon2id OK (m=19456 KiB, t=2: 43 ms/hash di host spike)<br>Bun.randomUUIDv7: 20k unik, terurut monoton dalam proses |
| S-03 | `bullmq` | **COMPATIBLE** | 4504 ms | jobId dengan ':' → DITOLAK ("Custom Id cannot contain :") → format jobId v0.4: run.{id}.attempt.{n}<br>enqueue/consume + jobId idempotency OK (enqueue ganda diabaikan)<br>delay 1500 ms → diproses setelah 1526 ms<br>retry attempts=3 backoff fixed: sukses di panggilan ke-3 (attemptsMade=2)<br>priority: urutan 1→3→5 OK<br>stalled: worker di-SIGKILL saat job aktif → job diproses ulang worker lain setelah 2010 ms (lockDuration 2 s)<br>ioredis SCRIPT LOAD + EVALSHA token bucket OK<br>Bun.RedisClient SET NX EX (dedupe seen:*) OK |
| S-04 | `bullmq-interop-py` | **COMPATIBLE** | 1308 ms | TS enqueue → Python Worker consume → returnvalue kembali ke TS (waitUntilFinished) OK<br>Python enqueue (jobId=py-1, attempts=2) → TS Worker consume OK |
| S-05 | `keda-bullmq-scaler` | **UNTESTED** | 0 ms | BLOCKED: host tanpa Docker/Kubernetes. Hanya relevan untuk profil Kubernetes (DEPLOYMENT §4); profil MVP single-node tidak butuh KEDA. |
| S-06 | `opentelemetry` | **COMPATIBLE** | 49 ms | AsyncLocalStorageContextManager: konteks span bertahan melewati setTimeout/await<br>inject/extract traceparent W3C OK (00-b53697666e3345b77b6bf862286fbf3a-482092e67a299762-01)<br>OTLP/HTTP protobuf exporter → collector lokal: 2 request, span & resource terkirim |
| S-07 | `clickhouse` | **COMPATIBLE** | 1332 ms | ClickHouse 26.10.1.832, @clickhouse/client di Bun: query/insert JSONEachRow OK<br>DDL subset DATA_MODEL §6 (events, agg_topic_1h, topic_matches, agg_author_1d, media_items + MV) terbuat<br>override sentiment via pasangan sign -1/+1 → agregat benar tanpa UPDATE; engagement_known_posts memisahkan 'tidak diketahui' dari 0<br>topic_matches (ReplacingMergeTree, MV sign=1) + FINAL → 1 baris label terbaru<br>server default async_insert=1, async_insert_deduplicate=0<br>insert_deduplication_token, batch berbeda isi tapi token sama 2×: default server → 1 baris; async_insert=0 → 1 baris; async_insert=1+async_insert_deduplicate=1 → 1 baris<br>tanpa SETTING non_replicated_deduplication_window: token sama 2× → 2 baris (token DIABAIKAN — setting tabel WAJIB untuk MergeTree non-replicated)<br>token dedup berlaku di default server; tetap set eksplisit di worker-sink agar tidak bergantung default versi<br>BUKTI bug v0.3: SummingMergeTree menjumlahkan followers (1000+1100=2100) saat merge; fix v0.4 AggregatingMergeTree+SimpleAggregateFunction(anyLast) = 1100<br>media_items via MV ARRAY JOIN kolom media (kolom baru v0.4) → 2 baris/post; tanpa kolom ini MV tidak bisa dibuat<br>ORDER BY kolom Nullable ditolak: "Sorting key contains nullable columns, but merge tree setting `allow_nullable_key` is disabled. " → agregat geo memakai '' = unknown (C16) |
| S-08 | `postgres-drizzle-rls` | **WORKAROUND** | 437 ms | FK ke tabel partisi wajib menyertakan kolom partisi: FK (id) ditolak ("there is no unique constraint matching given keys for referenced table…"); FK (id, scheduled_for) OK<br>`SET LOCAL app.tenant_id = $1` DITOLAK Postgres ("syntax error at or near "$1"") → pakai `SELECT set_config('app.tenant_id', $1, true)` (efek sama, transaction-scoped)<br>drizzle(postgres-js) transaksi + set_config(local) + RLS: tenant A hanya melihat datanya<br>GOTCHA koneksi pool: query di luar transaksi setelah set_config lokal → ERROR "invalid input syntax for type uuid: """ — policy naif `current_setting(...)::uuid` gagal karena nilai kembali '' (bukan NULL)<br>fix: `nullif(current_setting('app.tenant_id', true), '')::uuid` → tanpa konteks tenant = 0 baris (default deny), bukan error<br>Bun.SQL builtin (begin + set_config + RLS) OK; drizzle-orm/bun-sql transaksi OK<br>Status WORKAROUND karena dua pola di DATA_MODEL/SECURITY harus diganti (set_config & nullif) — keduanya perilaku Postgres, bukan Bun. |
| S-08 | `drizzle-kit` | **COMPATIBLE** | 970 ms | drizzle-kit generate + migrate via `bun --bun` OK (0000_certain_flatman.sql, enum e_ + timestamptz) |
| S-08 | `bun-s3` | **COMPATIBLE** | 57 ms | put/get/exists/size OK (48 byte gzip)<br>presign GET (dipakai export download_url) OK<br>delete OK<br>CATATAN: MinIO open-source DIARSIPKAN (dl.min.io → 410 'no longer maintained, no security updates'); spike memakai versitygw 1.8.0. DEPLOYMENT diperbarui. |
| S-08 | `vite-build` | **COMPATIBLE** | 687 ms | vite build dijalankan dengan `bun --bun` (runtime Bun, bukan Node): 1 asset, 685 ms |
| S-08 | `playwright` | **COMPATIBLE** | 1573 ms | Playwright library dijalankan DI RUNTIME BUN: launch chromium-headless-shell, goto, click, textContent OK<br>library sistem Chromium lengkap (install-deps sudah dijalankan) — tanpa workaround |
| S-09 | `webcrypto-aesgcm-python` | **COMPATIBLE** | 607 ms | Bun encrypt → Python decrypt OK (format ciphertext\|\|tag identik)<br>Python encrypt → Bun decrypt OK<br>ciphertext diubah 1 byte → ditolak Bun & Python (SEC-03)<br>AAD tenant lain → ditolak Bun & Python (SEC-04)<br>envelope (DEK dibungkus KEK, adapter local-dev) Bun → Python OK<br>Vault transit wrap/unwrap DEK OK (vault:v1:…) via fetch Bun |

## Versi paket

- `hono`: 4.13.9
- `zod`: 4.6.5
- `jose`: 6.2.12
- `bullmq`: 6.3.9
- `ioredis`: 6.0.0
- `@clickhouse/client`: 1.23.1
- `drizzle-orm`: 0.45.3
- `postgres`: 3.4.9
- `@opentelemetry/sdk-trace-base`: 2.11.0
- `@opentelemetry/exporter-trace-otlp-proto`: 0.222.0
- `@opentelemetry/context-async-hooks`: 2.11.0
- `vite`: 8.3.1
- `@vitejs/plugin-react`: 6.1.1
- `react`: 19.3.0
- `embedded-postgres`: 16.14.0-beta.17
- `drizzle-kit`: 0.31.11
- `playwright`: 1.63.0
- `@biomejs/biome`: 2.5.14
