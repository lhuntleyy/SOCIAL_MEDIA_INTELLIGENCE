# TASK

Format: `ID — Judul` · **Dep** (dependensi) · **AC** (acceptance criteria) · **Test** (bukti wajib). Estimasi dalam hari-orang (hari), kasar.

Sebuah task hanya boleh `done` jika **Test** lulus dan bukti dicatat di PROGRESS.md. **Fase 0 (sebelum CI ada di F-12):** bukti = laporan di `docs/evidence/<ID>/` (perintah reproduksi + output mentah + versi tool). Mulai F-12: link CI run.

Kode test di kolom **Test**: `R-/P-` = TESTING §4.1–4.2, `SEC-` = TESTING §4.4 (security). `S-xx` hanya dipakai untuk task Fase 0.

---

## Fase 0 — Spike & Verifikasi (tidak ada kode produksi)

| ID | Task | Dep | AC | Test | Est |
|---|---|---|---|---|---|
| S-01 | Pin versi Bun; scaffold `scripts/compat-check.ts` | — | script jalan lokal, output tercatat; dipakai CI setelah F-12 | evidence `docs/evidence/S-01/` | 0.5 |
| S-02 | Compat: hono (+SSE), zod, jose | S-01 | status tercatat di ADR-001 | compat-check | 0.5 |
| S-03 | Compat: bullmq + ioredis di Bun (delay, retry, stalled, priority) | S-01 | status + catatan | compat-check | 1 |
| S-04 | Interop BullMQ TS ↔ Python (`bullmq` PyPI) pada queue sama | S-03 | job TS diproses Python & sebaliknya | integration test | 1 |
| S-05 | KEDA scaling source untuk BullMQ (Redis key vs Prometheus) | S-03 | keputusan tercatat | demo di kind/minikube | 1 |
| S-06 | Compat: OpenTelemetry JS di Bun | S-01 | span sampai ke collector | compat-check | 0.5 |
| S-07 | ClickHouse: DDL DATA_MODEL §6, MV sign-based, insert dedup token, performa `FINAL` feed | — | query referensi benar, catatan performa | integration test | 2 |
| S-08 | Compat: drizzle + Bun.sql/postgres (transaksi, SET LOCAL, RLS), Bun.s3 ke server S3-compatible, Vite build, Playwright | S-01 | status tercatat | compat-check | 1 |
| S-09 | Interop AES-256-GCM Web Crypto (Bun) ↔ Python `cryptography` + Vault transit wrap/unwrap | S-01 | encrypt di Bun → decrypt di Py & sebaliknya | unit test dua sisi | 1 |
| S-10 | PROVIDER_MATRIX: X — **twitterapi.io (utama)** + Apify (cadangan) + X official (cadangan mahal): dokumen, harga, limit, operator inkremental | — | template §3 terisi dengan URL + tanggal untuk twitterapi.io; konflik angka dicatat | review 2 orang | 1 |
| S-11 | PROVIDER_MATRIX: Instagram (Graph API, ≥1 Apify actor, instagrapi) — termasuk **uji keyword search** | — | status keyword TESTED/NOT_AVAILABLE per provider | laporan contract test manual | 2 |
| S-12 | PROVIDER_MATRIX: Facebook | — | idem | idem | 1 |
| S-13 | PROVIDER_MATRIX: Threads (official keyword search + third-party) — selesaikan klaim bertentangan | — | idem | idem | 1 |
| S-16 | PROVIDER_MATRIX: TikTok (Apify actor + cadangan; Research API kelayakan) | — | idem | idem | 1 |
| S-17 | PROVIDER_MATRIX: YouTube Data API v3 (quota unit per operasi, `publishedAfter`) + Apify cadangan | — | idem | idem | 0.5 |
| S-14 | Ukur latency p50/p95 per kandidat (≥ 5 sampel) → min_interval realistis; **uji `since_id` & status HTTP rate-limit twitterapi.io**; ukur biaya poll kosong | S-10..13, S-16, S-17 | tabel `measured` | laporan | 1 |
| S-15 | Review legal: ToS provider (termasuk twitterapi.io tanpa afiliasi X Corp), UU PDP, transfer lintas negara (LLM & provider luar negeri), penggunaan unofficial, retensi korpus training | S-10..13 | memo keputusan tertulis | sign-off | — |
| S-20 | Baseline sentiment: kumpulkan & label 2.000 post (dev/test), evaluasi ≥ 2 model kandidat **+ keputusan jalur NLP A/B dan model fallback (akurasi per $, COST_MODEL §4a)** | — | macro-F1 per model + target G3 + jalur NLP ditetapkan | eval report | 5 |
| S-21 | Keputusan akhir stack (update ADR) | S-02..04, S-06..09 (S-05 hanya gate H-05) | ADR final | review | 0.5 |
| S-22 | Baseline emotion (8 emosi): label subset + evaluasi kandidat model | S-20 | macro-F1 per model | eval report | 3 |
| S-23 | Metode & legal demografi (gender/age): leksikon/model kandidat, coverage, cek disparitas, memo UU PDP + sign-off DPO — **termasuk keputusan bucket `below_18` (data anak)** | — | metode versioned + memo legal (ADR-007) | review + sign-off | 2 |

## Fase 1 — Foundation

| ID | Task | Dep | AC | Test | Est |
|---|---|---|---|---|---|
| F-01 | Monorepo Bun workspaces, tsconfig strict, lint, dependency-rule check | S-21 | `bun run check` hijau | CI | 1 |
| F-02 | `packages/config` + validasi env | F-01 | service gagal start saat env invalid | unit | 0.5 |
| F-03 | `packages/observability` (logger redaction, metrics, tracing) | F-01, S-06 | log JSON + /metrics | unit (redaction) | 1.5 |
| F-04 | Postgres schema + migrasi DATA_MODEL §2–§5 + RLS | F-01 | migrate up/down bersih | integration (RLS, SEC-01 subset) | 3 |
| F-05 | ClickHouse migrasi DATA_MODEL §6 | S-07 | tabel + MV terbuat | integration (golden agg) | 1.5 |
| F-06 | `packages/crypto` envelope encryption + adapter vault/local-dev | S-09 | encrypt/decrypt/rewrap | unit SEC-03, SEC-04 | 2 |
| F-07 | `packages/contracts` (JSON Schema) + generator pydantic | F-01 | TS & Py tipe sinkron | unit + CI diff check | 1.5 |
| F-08 | `packages/queue` (port + BullMQ/Streams impl, envelope, tracing) | S-03,S-04 | enqueue/consume/DLQ/idempotency | integration §4.3 | 2 |
| F-09 | Auth: login, JWT, refresh rotation, MFA, RBAC middleware | F-04 | endpoint §2 API_SPEC | unit + integration SEC-05, SEC-06 | 3 |
| F-10 | Tenant/user/membership/api-key admin API | F-09 | endpoint §10 | integration | 2 |
| F-11 | docker compose dev + seed | F-04,F-05 | `bun run dev:up` jalan | smoke | 1 |
| F-12 | CI pipeline lengkap (lint→unit→contract→integration→build) | F-01 | pipeline hijau | — | 1.5 |

## Fase 2 — Ingest MVP

| ID | Task | Dep | AC | Test | Est |
|---|---|---|---|---|---|
| I-01 | `packages/query`: parser, AST, validator (limit panjang/kedalaman), matcher lokal + **keyword OR, languages, media_tags/not_media_tags** (ADR-008) | F-01 | contoh di CONNECTOR_SPEC §5 | unit ≥ 90% + P-04, P-12 | 3.5 |
| I-02 | Query compiler generik (decompose by features) | I-01 | sub-query minimal | unit | 1.5 |
| I-03 | Topic CRUD + validate/preview/cost-estimate + SyncCrawlPlans | I-01,F-09 | endpoint §4 | integration | 3 |
| I-04 | `packages/connector-sdk`: interface, ConnectorError, HttpClient (timeout, SSRF guard, redaction), contract suite | F-07 | suite jalan untuk `fake` | contract + SEC-07 | 3 |
| I-05 | Connector `fake` (scriptable) | I-04 | mendukung skenario TESTING §3 | contract | 1 |
| I-06 | `packages/router`: policy loader + cache + outbox invalidation | F-04 | R-12 | integration | 2 |
| I-07 | Router: seleksi priority/weight + eliminasi | I-06 | R-01..R-05, R-13 | unit + simulasi | 2 |
| I-08 | Rate limiter token bucket Lua + dynamic override + semaphore | F-08 | R-11 | integration (Redis) | 2 |
| I-09 | Quota reservation/commit/release + sweeper + flush ke PG | I-08 | R-10, R-11 | integration | 2 |
| I-10 | Error taxonomy → failover decision | I-07 | R-06..R-08 | integration | 1.5 |
| I-11 | Health: passive window, active probe, circuit breaker | I-10 | R-09 | integration | 2.5 |
| I-12 | Scheduler (leader, SKIP LOCKED, coalescing, jitter, backpressure, outbox) + **reaper `inflight_run_id`** | I-03,F-08 | P-07, P-10 | integration | 3 |
| I-13 | worker-dispatch + worker-fetch-bun | I-07..I-10 | alur run end-to-end dgn fake | integration | 2.5 |
| I-14 | worker-pipeline: match (incl. keyword/lang/media filter), dedupe, geo gazetteer, ads | I-01 | P-01..P-04, P-12 | integration | 2.5 |
| I-15 | worker-sink: batch insert CH + **guard dedup ClickHouse (§6.2)** + partisi consumer per post + run update (watermark hanya saat succeeded) + jalur post tak-match + realtime notify | F-05 | P-03, P-09, P-17 | integration | 3 |
| I-16 | worker-fetch-py skeleton (BaseConnector, consume, credential decrypt, session lock) | S-04,S-09 | fake connector Python lulus contract | pytest contract | 3 |
| I-17 | Connector nyata #1: **`twitterapi_io.x`** (X utama, PROVIDER_MATRIX §6.1) — `since_time` + overlap, BigInt ID, parse `createdAt`, biaya minimum per request | I-04, S-10, S-14 | verified di staging | contract + verify evidence + P-19 | 3 |
| I-18 | Connector nyata #2..#6 (satu per platform MVP: IG, FB, Threads, TikTok via Apify; YouTube Data API) + cadangan X `apify.x` | I-17, S-11..13, S-16, S-17 | idem | idem | 3/connector |
| I-19 | Connector unofficial Python (mis. instagrapi) sebagai standby — **hanya jika S-15 menyetujui** | I-16,S-15 | default disabled, weight 0 | contract + review keamanan | 3 |
| I-20 | Engagement refresh | I-13,I-15 | P-08 | integration | 2 |
| I-21 | Admin API provider/connector/account/routing/quota/usage/simulate/DLQ | I-06..I-11 | endpoint §9 | integration + SEC-02 | 4 |
| I-22 | Collection stream: dedup planner + `collection_streams`/`stream_topic_links` + matcher inverted-index (ADR-009, ARCHITECTURE §12) | I-12,I-14 | fetch 1× untuk topic beririsan; matcher map ke banyak topic; post tak-match tetap disimpan | integration + P-14 | 3.5 |
| I-23 | Cost guard: soft cap throttle (turun interval, bukan stop) + preview/estimate hasil+request (COST_MODEL §8, CONNECTOR_SPEC §5) | I-09,I-12 | soft cap → throttle; hard → skip | integration + P-16 | 1.5 |
| I-24 | Partial success: `gap_windows`, watermark hanya maju saat succeeded, pengambilan ulang celah, metrik gap (CONNECTOR_SPEC §7) | I-12,I-15 | tidak ada post hilang saat halaman tengah gagal | integration + P-18 | 1.5 |
| I-25 | Atribusi biaya collection stream + stream `private:` untuk BYO (ADR-009 amandemen) | I-22,I-09 | biaya teralokasi proporsional; BYO tidak lintas tenant | integration + P-20, R-15 | 1.5 |

## Fase 3 — AI & Dashboard

| ID | Task | Dep | AC | Test | Est |
|---|---|---|---|---|---|
| A-01 | worker-ai: preprocessing + lang ID | S-20 | unit preprocessing | pytest | 2 |
| A-02 | Sentiment encoder serving + kalibrasi + cache enrich | A-01 | throughput tercatat | pytest -m eval | 3 |
| A-03 | LLM fallback (provider abstraction, structured output, quota) | A-02 | refusal & 429 ditangani | pytest (mock) + eval | 2.5 |
| A-04 | Keyphrase per post + scoring c-TF-IDF query-time | A-01 | precision@5 dilaporkan | pytest + golden | 3 |
| A-05 | Override sentiment end-to-end | I-15 | P-06 | integration | 1.5 |
| A-06 | Reprocess job | A-02 | tidak double count | integration | 1.5 |
| A-07 | Emotion classifier (8 emosi) serving + cache + agg | S-22,A-02 | pytest -m eval + P-13 | pytest + golden | 3 |
| A-08 | Demografi: gender inference per akun + cache + agg | S-23 | precision + coverage dilaporkan | pytest + golden + SEC-09, SEC-12 | 3 |
| A-09 | Demografi: age range inference per akun + cache + agg | S-23 | precision + coverage dilaporkan | pytest + golden + SEC-09, SEC-12 | 3 |
| A-10 | `nlp_labels` writer (semua inferensi model/llm/human) + ekspor training (DATA_MODEL §5.10, AI_SPEC §14) | A-02 | tiap inferensi tercatat; ekspor by model_version | integration | 1.5 |
| D-01 | Analytics endpoints §5 (query builder tenant-safe) — exposure/sentiment/emotion/issues/hashtags/locations/totals/comparison/accounts/contributors | F-05 | golden test TESTING §4.5 | integration + SEC-01 | 5 |
| D-02 | Posts feed + detail (tanpa demografi individu) | F-05 | cursor stabil, SEC-09 | integration | 1.5 |
| D-03 | SSE stream + `POST /stream/ticket` (cookie `sse_ticket`, SECURITY §7) | I-15 | event diterima < 5 s setelah sink | integration + SEC-10, SEC-11 | 1.5 |
| D-04 | Psychography endpoints (gender/age + coverage) & Gallery/Chronology | A-08,A-09 | golden + coverage_pct benar | integration + SEC-09 | 3 |
| U-01 | Web shell: auth, layout, nav 5 section, filter bar URL state, auto-refresh (5/15/30/45/60) | F-09 | e2e login | Playwright | 3 |
| U-02 | Topic & Account page (list + form 3 tab: General/Query Lists(keyword,media,lang)/Demography + cost modal) | I-03 | e2e buat topik | Playwright | 4.5 |
| U-03 | Dashboard page (widget + Hashtags treemap) | D-01 | render data seed | Playwright + visual snapshot | 4 |
| U-04 | Conversation: Sentiment(+by-engagement)+override, Emotion, Issues, Engagement, Chronology, Gallery, Contributors, Issues Comparison | D-02,D-04,A-05,A-07 | e2e override + render | Playwright | 5 |
| U-05 | Audience page (+Total Posts Comparison, Most Reposted) | D-01 | render | Playwright | 3 |
| U-06 | Psychography page (gender/age + coverage + per-sentiment) | D-04 | render + coverage tampil | Playwright | 3 |
| U-07 | Resume page (overview/summary + export) | D-01 | render (konfirmasi isi) | Playwright | 2 |

## Fase 4 — Provider Ops UI & Alert

| ID | Task | Dep | AC | Test | Est |
|---|---|---|---|---|---|
| O-01 | Admin Providers page (toggle, priority, weight, health, rate, quota, verify) | I-21 | e2e toggle provider → berlaku | Playwright + R-12 | 4 |
| O-02 | Routing simulator UI | I-21 | trace eliminasi tampil | Playwright | 1.5 |
| O-03 | Accounts & credential UI (write-only) | I-21 | secret tidak pernah tampil | Playwright + SEC-02 | 2 |
| O-04 | Usage & cost, crawl monitor, DLQ, audit pages | I-21 | — | Playwright | 3 |
| O-05 | Alert rules + evaluasi + channel email/webhook/telegram | D-01 | alert terkirim di test | integration | 3 |
| O-06 | Export CSV/XLSX | D-02 | file valid | integration | 2 |
| O-07 | Grafana dashboards + Alertmanager rules | F-03 | alert terpicu di chaos test | chaos test | 2 |

## Fase 5 — Hardening

| ID | Task | Dep | AC | Test | Est |
|---|---|---|---|---|---|
| H-01 | Load test ingest & API; tuning concurrency/replika | fase 3 | NFR-01, NFR-04 terpenuhi atau direvisi | laporan k6 | 4 |
| H-02 | Chaos suite nightly (fake fault injection, Redis restart, CH down) | I-11 | tidak ada data loss/double | nightly | 2 |
| H-03 | Security: SAST, secret scan, ZAP, pentest eksternal | — | temuan high = 0 | laporan | 3 + vendor |
| H-04 | Retensi & tenant purge | F-04,F-05 | data kedaluwarsa hilang | integration | 2 |
| H-05 | Helm chart + KEDA + NetworkPolicy + egress proxy | S-05 | deploy staging | smoke | 4 |
| H-06 | Backup/restore & DR drill | H-05 | RPO/RTO terukur | drill report | 2 |
| H-07 | Dokumentasi final (RUNBOOK, annotation guide, onboarding connector) | — | review | — | 2 |

## Fase 6 — Expansion
Bluesky & Reddit connectors (masing-masing: PROVIDER_MATRIX → connector → verify); target-aware/aspect sentiment (ABSA); emotion multi-label penuh; issue clustering; NER & deteksi koordinasi; SSO OIDC. (TikTok & YouTube pindah ke MVP Fase 2; shared crawl = I-22/ADR-009.) (Emotion dasar & psychography gender/age sudah di fase 3.)
