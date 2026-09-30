# ADR-001: Bun sebagai runtime utama + compat matrix wajib

- Status: Accepted — keputusan final stack S-21 (2026-09-28, menunggu review); sisa: KEDA/S-05 (hanya profil Kubernetes)
- Tanggal: 2026-09-27

## Konteks
Tim ingin Bun-first (startup cepat, tooling terpadu: runtime, test, bundler, package manager, built-in `Bun.sql`, `Bun.s3`, `Bun.password`). Tetapi tidak semua package npm dijamin berperilaku identik di Bun.

## Keputusan
- Semua service TS berjalan di Bun, versi dipin di `.bun-version` & image Docker.
- Setiap dependency runtime wajib lulus `scripts/compat-check.ts` sebelum dipakai. Hasil dicatat di bawah.
- Library non-JS (instagrapi, model NLP) berjalan di worker Python (ADR-003).

## Compat Matrix (hasil spike 2026-09-28)

Bun **1.4.2** (`.bun-version`), Linux x64. Evidence: [`docs/evidence/compat/results.md`](../evidence/compat/results.md) (reproduksi: `scripts/spike-infra.sh start && bun run compat`).

| Package | Versi | Status | Catatan / workaround | Task |
|---|---|---|---|---|
| hono (+SSE `streamSSE`) | 4.13.9 | **WORKAROUND** | Routing/middleware/SSE inkremental OK. `Bun.serve` default `idleTimeout` 10 s **memutus SSE yang diam** → route SSE wajib `idleTimeout: 0` (terbukti) atau heartbeat < 10 s | S-02 |
| zod | 4.6.5 | COMPATIBLE | `z.toJSONSchema` → draft 2020-12 (cukup untuk `packages/contracts`) | S-02 |
| jose | 6.2.12 | COMPATIBLE | EdDSA (Ed25519) & ES256 sign/verify/tamper-reject | S-02 |
| drizzle-orm (+`postgres-js`, +`bun-sql`) | 0.45.3 | **WORKAROUND** | Transaksi + RLS OK di kedua driver. Workaround = pola Postgres, bukan Bun: `set_config('app.tenant_id',$1,true)` (bukan `SET LOCAL … = $1`) dan policy `nullif(current_setting(…, true), '')::uuid` | S-08 |
| postgres (porsager) | 3.4.9 | COMPATIBLE | | S-08 |
| Bun.SQL (builtin) | Bun 1.4.2 | COMPATIBLE | `begin()` + set_config + RLS | S-08 |
| bullmq | 6.3.9 | COMPATIBLE | delay, retry+backoff, priority, stalled recovery (worker di-SIGKILL), jobId idempotency. **Custom jobId tidak boleh mengandung `:`** (spec diubah ke `.`) | S-03 |
| ioredis | 6.0.0 | COMPATIBLE | SCRIPT LOAD + EVALSHA (token bucket Lua) | S-03 |
| Bun.RedisClient | Bun 1.4.2 | COMPATIBLE | SET NX EX (dedupe `seen:*`) | S-03 |
| bullmq (PyPI) ↔ bullmq (npm) | 3.2.7 ↔ 6.3.9 | COMPATIBLE | TS→Py dan Py→TS pada queue yang sama, returnvalue kembali ke TS | S-04 |
| @clickhouse/client | 1.23.1 | COMPATIBLE | × ClickHouse 26.10.1; DDL/MV sign-based/FINAL/dedup token terbukti — lihat DATA_MODEL §6.2 untuk setting wajib | S-07 |
| @opentelemetry/* (sdk-trace-base, exporter-otlp-proto, context-async-hooks) | 2.11.0 / 0.222.0 | COMPATIBLE | OTLP/HTTP protobuf ke collector; AsyncLocalStorage context melewati await; W3C traceparent inject/extract | S-06 |
| Bun.s3 | Bun 1.4.2 | COMPATIBLE | put/get/exists/size/presign/delete ke versitygw 1.8.0. **MinIO OSS diarsipkan** (tidak diuji, tidak disarankan) | S-08 |
| Web Crypto AES-256-GCM ↔ Python `cryptography` | Bun 1.4.2 ↔ 50.0.1 | COMPATIBLE | format ciphertext‖tag identik; tamper & AAD-lain ditolak dua sisi; envelope DEK/KEK; Vault transit wrap/unwrap (Vault dev) | S-09 |
| Bun.password (argon2id) / Bun.randomUUIDv7 | Bun 1.4.2 | COMPATIBLE | ~44 ms/hash (m=19 MiB, t=2) di host 2 vCPU; UUIDv7 monoton dalam proses | S-08 |
| Vite build via `bun --bun` | vite 8.3.1 | COMPATIBLE | React 19 + @vitejs/plugin-react 6.1 | S-08 |
| Playwright (library) + chromium-headless-shell | 1.x (bun.lock) | **COMPATIBLE** (2026-09-28, setelah `playwright install-deps`) | Library jalan di runtime Bun (launch/goto/click). Sebelumnya WORKAROUND (lib sistem diekstrak user-space); di CI tetap `playwright install-deps chromium`. Test runner `@playwright/test` tetap dijalankan dengan Node (TESTING §1) | S-08 |
| drizzle-kit | 0.x (bun.lock) | COMPATIBLE | `generate` + `migrate` via `bun --bun` ke Postgres 16 | S-08 |
| KEDA scaler BullMQ | — | **DECIDED: Prometheus scaler** (`smip_queue_depth`) | scaler Redis listLength melewatkan job `prioritized` (dibuktikan terhadap Redis nyata); demo kind menunggu H-05 | S-05 |
| jspdf + html-to-image (web, Laporan → PDF) | 4.2.1 / 1.11.13 | COMPATIBLE | jspdf di runtime Bun menghasilkan PDF valid; keduanya ter-bundle `vite build` via `bun --bun`. html-to-image dipilih (bukan html2canvas) karena warna `oklch` Tailwind v4 dirender browser sendiri. Check `web-pdf` ([evidence](../evidence/U-07/)) | U-07 |

## Keputusan final stack (S-21, 2026-09-28) — status `review`

Berdasarkan compat matrix di atas (0 INCOMPATIBLE):

| Layer | Keputusan | Fallback di ARCHITECTURE §2 dipakai? |
|---|---|---|
| Runtime | Bun 1.4.2 (dipin) | — |
| HTTP | Hono; route SSE `Bun.serve({ idleTimeout: 0 })` | Tidak |
| Validasi/kontrak | Zod 4 + `z.toJSONSchema` → pydantic | Tidak |
| Postgres | `Bun.SQL` untuk query aplikasi via drizzle `bun-sql`; `postgres` (porsager) untuk drizzle-kit & tooling | Tidak |
| ORM/migrasi | drizzle-orm (query) + **migrasi SQL berpasangan up/down** (`packages/db/migrations`, migrator sendiri) | **Ya, sebagian (F-04, 2026-09-28)**: drizzle-kit tidak mendukung migrasi *down* padahal AC F-04 mewajibkan up/down → DDL SQL-first; skema drizzle dijaga sinkron oleh test `schema-sync` |
| Queue | BullMQ (TS) + bullmq PyPI; jobId pemisah `.` | Tidak (Redis Streams tidak perlu) |
| Redis | ioredis (BullMQ) + `Bun.RedisClient` (cache/dedupe/rate) | — |
| Analytics | ClickHouse 26.x via `@clickhouse/client` | Tidak |
| Object storage | `Bun.s3` ke S3 terkelola atau server S3-compatible yang dirawat (bukan MinIO OSS) | Tidak |
| Auth/crypto | `Bun.password` argon2id, `jose` EdDSA, Web Crypto AES-256-GCM, Vault transit | Tidak |
| Telemetry | OpenTelemetry JS (sdk-trace-base + OTLP proto + AsyncLocalStorage) | Tidak |
| Frontend build | Vite via `bun --bun` | Tidak |
| E2E | Playwright; runner `@playwright/test` di Node; `playwright install-deps` di CI | — |
| Autoscaling | **Tidak ada di MVP** (profil single-node, DEPLOYMENT §3a). KEDA (S-05) diputuskan saat migrasi ke profil Kubernetes (H-05) | — |

Sisa terbuka yang **tidak** memblokir Fase 1: S-05 (KEDA, butuh Docker/K8s) — hanya menggating H-05.

## Konsekuensi
Jika sebuah package `INCOMPATIBLE`, gunakan fallback di ARCHITECTURE §2; bila tidak ada fallback, service terkait boleh dijalankan di Node sebagai pengecualian terdokumentasi (ADR baru).
