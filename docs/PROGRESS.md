# PROGRESS

Aturan:
- Status: `todo` · `in_progress` · `blocked` · `review` · `done`.
- `done` **wajib** mengisi kolom *Bukti* (link CI run / laporan test / evidence_ref). Tanpa bukti → maksimal `review`.
- Update setiap akhir hari kerja atau saat status berubah.

Ringkasan per 2026-09-28: dokumentasi **v0.4** (review: [REVIEW-2026-09-28](REVIEW-2026-09-28.md)); spike Fase 0 berjalan — **8 done, 7 review, 1 in_progress (S-14), sisanya todo** · Fase 1: **11 done** (F-01..F-11), 1 blocked (F-12: butuh repo git + remote CI), sisanya todo. Belum ada kode produksi.

Kebijakan bukti Fase 0 (sebelum CI di F-12): laporan tercommit di `docs/evidence/<ID>/` + perintah reproduksi (TASK.md). Semua `done` di bawah dijalankan 2026-09-28 di host 2 vCPU/1,9 GB, Bun 1.4.2; laporan gabungan: [evidence/compat/results.md](evidence/compat/results.md).

## Fase 0 — Spike & Verifikasi
| ID | Status | PIC | Bukti | Catatan |
|---|---|---|---|---|
| S-01 | done | claude | [evidence/S-01](evidence/S-01/README.md) | Bun 1.4.2 dipin; `bun run compat` jalan; `tsc` lulus. Pakai-di-CI menyusul F-12 |
| S-02 | done | claude | [compat](evidence/compat/results.md) | hono **WORKAROUND** (SSE butuh `idleTimeout: 0`), zod & jose COMPATIBLE |
| S-03 | done | claude | [compat](evidence/compat/results.md) | bullmq/ioredis/Bun.redis COMPATIBLE; jobId tanpa `:` (spec diperbaiki) |
| S-04 | done | claude | [compat](evidence/compat/results.md) | TS↔Python bullmq pada queue yang sama, dua arah |
| S-05 | todo | | — | Docker sudah ada; butuh kind/kubectl/helm (agent bisa pasang user-space). **Prioritas rendah**: hanya untuk profil Kubernetes, VPS 2 GB terlalu kecil untuk kind+KEDA |
| S-06 | done | claude | [compat](evidence/compat/results.md) | OTLP/HTTP protobuf + AsyncLocalStorage + traceparent |
| S-07 | done | claude | [evidence/S-07](evidence/S-07/README.md) | DDL/MV/dedup token/FINAL diuji; 3 koreksi DDL (window dedup, AggregatingMergeTree, sort key feed) |
| S-08 | done | claude | [compat](evidence/compat/results.md) | Postgres/drizzle/Bun.SQL **WORKAROUND** (set_config+nullif); Bun.s3, Vite, drizzle-kit COMPATIBLE; Playwright **WORKAROUND** (lib sistem Chromium diekstrak user-space; dev/CI: `playwright install-deps`) |
| S-09 | done | claude | [compat](evidence/compat/results.md) | AES-GCM Bun↔Python, tamper/AAD, envelope, Vault transit (dev) |
| S-10 | review | claude | [S-10](evidence/S-10/twitterapi-io.md), [apify-contract](evidence/S-11-S-17/apify-contract.json) | twitterapi.io & X official: DOCS; **Apify xquik & apidojo TESTED** (cadangan X). Butuh reviewer ke-2 |
| S-11 | review | claude | [provider-docs](evidence/S-11-S-17/provider-docs.md), [IG contract](evidence/S-11/ig-keyword-contract.json) | **Contract test Apify (2026-09-28): keyword caption IG TERSEDIA** — scraping_solutions (tanpa login) & crawlerbros TESTED; viralanalyzer gagal (login wall). Butuh reviewer ke-2 |
| S-12 | review | claude | [apify-contract](evidence/S-11-S-17/apify-contract.json) | **FB keyword search TESTED** (scraper_one 11/11 relevan ≤ 3 jam; scrapeforge 7/8). Graph API FB belum dicek |
| S-13 | review | claude | [apify-contract](evidence/S-11-S-17/apify-contract.json) | Official keyword search ADA (App Review). futurizerush TESTED (10/10) tapi start fee $0,08/run; scrapersdelight cadangan murah (DOCS) |
| S-14 | in_progress | claude | [apify-contract](evidence/S-11-S-17/apify-contract.json) | Apify: 1 sampel latency/actor sudah ada (4–73 s); butuh ≥ 5 sampel (hemat kuota $5). **twitterapi.io menunggu API key** dari pemilik |
| S-15 | todo | | | Legal sign-off wajib sebelum I-19; termasuk transfer lintas negara & ToS twitterapi.io |
| S-16 | review | claude | [apify-contract](evidence/S-11-S-17/apify-contract.json) | Research API NOT_AVAILABLE; **apidojo/tiktok-scraper TESTED $0,30/1K** (9/10 relevan) |
| S-17 | review | claude | [apify-contract](evidence/S-11-S-17/apify-contract.json) | Official: 100 search.list/hari; **streamers/youtube-scraper TESTED** (10/10) sebagai cadangan |
| S-20 | todo | | | + keputusan jalur NLP A/B & model fallback |
| S-21 | review | claude | [ADR-001 §Keputusan final](adr/ADR-001-bun-runtime.md) | Stack final tanpa fallback; S-05 dipindah jadi gate H-05 saja (tidak memblokir Fase 1). Butuh review |
| S-22 | todo | | | Baseline emotion (8 emosi) |
| S-23 | todo | | | Metode + legal demografi (ADR-007), sign-off DPO, keputusan `below_18` |

## Fase 1 — Foundation
Dimulai 2026-09-28 dengan S-21 berstatus `review` (keputusan stack terdokumentasi di ADR-001; bila reviewer mengubah stack, F-01..F-08 disesuaikan).

| ID | Status | PIC | Bukti | Catatan |
|---|---|---|---|---|
| F-01 | done | claude | [evidence/F-01](evidence/F-01/) | Bun workspaces + `paths @smip/*`, tsconfig strict (TS 7), Biome (lolos compat S-01), `scripts/check-deps.ts` (layer + relative-escape + external + provider-leak) ber-test. `bun run check` hijau |
| F-02 | done | claude | [evidence/F-02](evidence/F-02/) | `loadConfig(service)` Zod; aturan: Redis queue ≠ cache, KMS local-dev dilarang di prod, vault wajib addr+token; error tanpa nilai secret. 9 test |
| F-03 | done | claude | [evidence/F-03](evidence/F-03/) | Logger JSON + redaksi (key sensitif, Bearer/JWT/key vendor/kredensial URL/query param — SEC-02 bagian log; **regresi 2026-09-28**: `key=value`/JSON secret di teks bebas — ditemukan oleh test F-08, diperbaiki), registry Prometheus sendiri (label kardinalitas tinggi ditolak), tracing OTel + inject/extract envelope. 8 test |
| F-04 | done | claude | [evidence/F-04](evidence/F-04/) | 7 migrasi SQL up/down (DATA_MODEL §2–§5, 50+ tabel, 5 tabel partisi bulanan + DEFAULT), migrator ber-checksum, RLS 23 tabel (tenant, global-read, via policy), grant kolom (hash password tak terbaca app), audit append-only via trigger, `withTenant()` Bun.SQL+drizzle, skema drizzle identitas + test sinkron. 17 test integrasi (SEC-01 subset). **Deviasi**: drizzle-kit tanpa *down* → migrasi SQL-first (ADR-001) |
| F-05 | done | claude | [evidence/F-05](evidence/F-05/) | 2 migrasi ClickHouse up/down (7 tabel konten + 16 agregat + 17 MV) dengan semua koreksi review/S-07; migrator ber-checksum (`bun run ch:migrate`); golden test: override sign, repost, engagement tak diketahui, geo unknown `''`, followers anyLast (bukan dijumlah), uniq akun, psychography, media MV, posts ReplacingMergeTree. **Bug ditemukan & diperbaiki: dedup token tidak menjangkau MV → agregat dobel (REVIEW F10)**; τ demografi diterapkan worker sebelum sink. 5 test |
| F-06 | done | claude | [evidence/F-06](evidence/F-06/) | `seal/open/rewrap`, adapter local-dev (multi-versi KEK) & vault-transit (integrasi Vault dev: seal/open/rotate+rewrap), SEC-03 (tamper ciphertext & wrapped_dek), SEC-04 (AAD tenant lain), DEK di-zero setelah pakai, fingerprint HMAC, display hint. aws-kms/gcp-kms: belum (saat deploy cloud). 8 test |
| F-07 | done | claude | [evidence/F-07](evidence/F-07/) | Zod → JSON Schema (`packages/contracts/schemas/`) → pydantic v2 (`workers-py/smip_contracts/generated.py`) via `bun run gen:contracts`; `--check` masuk `bun run check`. 18 fixture divalidasi Zod & pydantic, hasil identik. Catatan: node `format`+`pattern` dibuat `str`+pattern di pydantic (pydantic gagal menerapkan regex ke datetime/UUID); `AgeRange` kontrak tanpa `below_18` (ADR-007) |
| F-08 | done | claude | [evidence/F-08](evidence/F-08/) | Port `JobQueue`/`QueueConsumer` di core; `BullMqQueue`: envelope divalidasi kontrak (jobId tanpa `:`, ≤ 256 KB), kebijakan per queue QUEUE_SPEC §3, poison & `PermanentJobError` → DLQ tanpa retry, retry habis → DLQ (error ter-redact), redrive/discard, timeout via AbortSignal, trace lintas queue, graceful shutdown **mengembalikan** job (moveToDelayed, attempt tidak terpakai). 8 test integrasi Redis |
| F-09 | done | claude | [evidence/F-09](evidence/F-09/) | `apps/api` (Hono): login argon2id (anti-enumerasi + hash tiruan), JWT EdDSA 15m (`kid`), refresh opaque 256-bit hash SHA-256 + rotasi + **reuse → family dicabut + audit (SEC-05)**, lockout bertahap + limit per IP, MFA TOTP wajib owner/admin/operator (token terbatas `setup_required`), RBAC + viewer read-only (**SEC-06**), envelope error, request id; role DB `smip_auth` (migrasi 0008). 9 test integrasi + smoke server nyata (menemukan kebocoran email di log → diperbaiki). Impersonasi `X-Tenant-Id` operator → F-10 |
| F-10 | done | claude | [evidence/F-10](evidence/F-10/) | Admin tenant (operator), user & membership (undang + token sekali pakai + accept-invite, aturan owner + trigger owner terakhir), API key (secret sekali, SHA-256, scope→peran, verifikasi waktu-konstan, manusia-only untuk rute akses), `X-API-Key` authn, impersonasi operator (alasan wajib + audit per request). **2 bug 🔴 ditemukan & diperbaiki: users bocor lintas tenant (RLS baru, migrasi 0009) & JSONB ter-encode ganda di drizzle bun-sql.** 7 test integrasi; total suite 97 test |
| F-11 | done | claude | [evidence/F-11](evidence/F-11/) | `bun run dev:up` jalan dari nol (6 container sehat, migrasi PG+CH, seed idempoten, kunci Vault); test F-04 & F-05 juga lulus terhadap Postgres 16 resmi & **ClickHouse 26.3 LTS** di compose. Service aplikasi ditambahkan saat kodenya ada |
| F-12 | done | claude | [CI run #1](https://github.com/lhuntleyy/SOCIAL_MEDIA_INTELLIGENCE/actions/runs/36400437915) | `.github/workflows/ci.yml`: bun (`.bun-version`) + venv codegen dipin → `bun run check` → `bun run dev:up` (compose) → `bun test`; tanpa call provider eksternal. Run pertama di GitHub **lulus** (2026-09-28). Build image/SBOM menyusul saat Dockerfile ada (DEPLOYMENT §7). Mulai sekarang bukti task = link CI run (TESTING §1) |

## Fase 2 — Ingest MVP
| ID | Status | PIC | Bukti | Catatan |
|---|---|---|---|---|
| I-01 | done | claude | [evidence/I-01](evidence/I-01/) | `packages/query`: parser + error berposisi, validator DoS (SEC-08), matcher lokal (term utuh, frasa kontigu, hashtag, keyword ke inti positif, bahasa dgn alias `in`→`id`, media tags), `ast_hash` kanonis. 15 test, coverage 100% baris / 99% fungsi. P-04 & P-12 lulus. Semantik: ADR-008 §Semantik final |
| I-02 | done | claude | [evidence/I-02](evidence/I-02/) | `compileGeneric`: 1 query eksak bila fitur didukung; selain itu **set penutup minimal** (AND → satu sisi terkecil/terspesifik, OR → semua, NOT → tak dipakai recall) dikemas ke query OR sesuai `maxQueryLength` (request minimal); `coverHashtags` untuk connector hashtag-only. Uji properti recall acak. 9 test, coverage 100% baris |
| I-03 | done | claude | [evidence/I-03](evidence/I-03/) | `apps/api` `/topics` (API_SPEC §4): list (search/status/type/sort/cursor+total), create/get/patch (`If-Match` → VERSION_MISMATCH), archive (admin), pause/resume, validate-query, preview (kandidat ClickHouse 7 hari via set penutup → presisi matcher lokal → estimasi/hari), cost-estimate (rumus hasil×tarif + request×minimum + run×biaya tetap; tanpa tarif → `unverified_rates`), clamp interval (plan & `min_interval_sec` connector) + warning, PLAN_LIMIT `max_topics`, FR-T05 hard quota tenant → 422 QUOTA_WOULD_EXCEED. **SyncCrawlPlans** (query aktif × platform aktif × operation; kombinasi hilang → `disabled`, watermark dipertahankan). Outbox `topic.*` + audit. `requireScope` API key (topics:read/write — sebelumnya scope tidak ditegakkan). Migrasi 0011 (`topics.version`), 0012 (smip_app INSERT outbox — tanpa ini API tak bisa menulis outbox). Helper `@smip/db textArray/inList` (array JS di drizzle+Bun.SQL diekspansi jadi list → kolom text[] gagal). 10 test. Backfill & `GET /topics/{id}/runs` → I-12/I-13 |
| I-04 | done | claude | [evidence/I-04](evidence/I-04/) | `packages/connector-sdk`: tipe Connector/Manifest (+`resultOrder`), `ConnectorError` + klasifikasi status, HttpClient (timeout, Retry-After, redaksi, redirect dicek ulang, **SSRF guard SEC-07**: https wajib, allowlist, IP literal & hasil DNS non-publik ditolak), helper normalisasi (semua format waktu dari uji kontrak, `null≠0`, ID BigInt, buang PII), contract suite `@smip/connector-sdk/contract`. Residual: DNS rebinding → ditutup egress proxy |
| I-05 | done | claude | [evidence/I-05](evidence/I-05/) | `FakeConnector` (`fake.<platform>[.<varian>]`) scriptable per TESTING §3 (respond/fail/delay/malformed, `returned` untuk P-15, health on/off, jejak calls); lolos contract suite (7 skenario + signal + health + SEC-02) |
| I-06 | done | claude | [evidence/I-06](evidence/I-06/) | Tipe snapshot di `core` (`RoutingSnapshot`), loader Postgres `@smip/db loadRoutingSnapshot` (smip_system), `SnapshotStore` di `packages/router` (port `SnapshotLoader`, router TIDAK impor @smip/db — ARCHITECTURE §6); cek `cfg:version` maks sekali per `pollMs` (default 10 s) + `refresh()` untuk subscriber. Outbox: `writeOutbox` (1 transaksi dgn perubahan config) + `publishOutbox` (SKIP LOCKED, pub/sub `config.changed`, INCR `cfg:version` hanya untuk aggregate config). R-12: weight baru terlihat ~0,3 s setelah publish (pollMs 300 ms di test). Tes menemukan lagi encode-ganda jsonb (F14) di outbox → diperbaiki |
| I-07 | done | claude | [evidence/I-07](evidence/I-07/) | `select()` murni atas snapshot: eliminasi berjejak (`TraceEntry` → dipakai simulator I-21), grup prioritas, weighted random × faktor kesehatan (1/0,5/0,1), weight 0 = standby, strategi `round_robin`/`cost_aware`, policy tenant > global, BYO hanya tenant pemilik, `sharedPoolOnly` (R-15), `max_share_pct`, `run_kinds`. Reservasi (rate+quota+semaphore) lewat port `Reserver` → diisi I-08/I-09; kesehatan lewat `HealthView` → I-11. 12 test: R-01..R-05, R-13, R-15 (R-02: 10.000 simulasi ±3%) |
| I-08 | done | claude | [evidence/I-08](evidence/I-08/) | `RedisReserver` (`packages/router/src/reserve.ts`): SATU skrip Lua atomik — quota hard → `rl:dyn` (Retry-After, hanya memperpanjang) → token bucket provider/connector/account → semaphore (lease = deadline reservasi). Cek semua dulu baru potong (tanpa potongan parsial). `fixed_window` diperlakukan token bucket (batas atas sama); token per run = estimasi request dibatasi kapasitas. R-11: 100 paralel → tepat kapasitas (bucket 10, quota 25, semaphore 3). Batas: Lua commit menyentuh kunci di luar KEYS → sah di Redis single-node (profil MVP), perlu hash tag bila Redis Cluster |
| I-09 | done | claude | [evidence/I-09](evidence/I-09/) | commit (reserved −est, used +aktual) / release idempoten, `sweep()` untuk reservasi lewat deadline, event threshold 50/80/95% (`onThreshold`), `drainDirty`/`markDirty` + `@smip/db flushQuotaUsage` (upsert absolut, `used` tak pernah mundur) & `loadQuotaUsage` untuk **seed ulang** saat kunci Redis hilang (tanpa itu quota diam-diam reset → overspend). Periode per `reset_tz`; bulanan berkunci `YYYY-MM`. **Migrasi 0010**: `period` masuk PK `quota_usage` (harian & bulanan bentrok tiap tgl 1). R-10: hard quota habis → `QUOTA_EXHAUSTED`, retryAfter = sisa periode, tak ada connector dipanggil. Stream shared pool tidak kena quota tenant/topic (atribusi I-25). Loop worker-ops (sweep/flush tiap ~30 s) dirangkai di I-13/I-20 |
| I-10 | done | claude | [evidence/I-10](evidence/I-10/) | `decideFailover` murni (tabel CONNECTOR_SPEC §7 → keputusan + daftar efek data): RATE_LIMITED → `rl:dyn` akun + failover; QUOTA_EXHAUSTED → throttle scope akun/connector; AUTH/CHALLENGE/FORBIDDEN → `needs_attention` (+alert kecuali FORBIDDEN); BLOCKED → cooldown 6 jam + alert; NOT_SUPPORTED → capability `failed`; INVALID_QUERY → recompile sekali lalu fail; 5XX/NETWORK → retry sama 1× lalu failover; PARSE_ERROR → alert schema_drift; ASYNC_PENDING → resume (tak memakan attempt); `max_attempts`/`failover_enabled` dihormati; `failureBackoffSec` (cap 4× interval) untuk R-08. Adapter `@smip/db` (markAccountAttention, setAccountCooldown, reactivateCooledAccounts, markCapabilityFailed — semua + outbox). Kelas `Router` (port `ProviderRouter`: plan/reportOutcome/simulate/release). Port `reportOutcome(o, ctx: AttemptContext)`. R-06, R-07, R-08 lulus end-to-end (PG+Redis, dua connector palsu). Update `crawl_runs`/`crawl_plans` (status, consecutive_failures, next_run_at) = bagian I-12/I-13 |
| I-11 | done | claude | [evidence/I-11](evidence/I-11/) | `HealthMonitor` (Lua atomik): passive window `hw:*` 5 m (bobot 0 tidak dihitung; PARSE_ERROR = ceil(N/2) → open setelah 2), circuit `cb:*` closed→open (failure ≥ N atau success rate < X dgn total ≥ N)→half_open (lazy setelah cooldown)→closed (M probe sukses) / open lagi (cooldown ×2, cap). `claimProbe` = 1 probe inflight (dipakai selector). Score = 100 × success × min(1, SLO/p95), label healthy/degraded/unhealthy/unknown. `HealthCache` (HealthView sinkron, `refresh(snapshot)`). `@smip/db upsertProviderHealth` + `health_checks`. R-09 lulus. **Belum dirangkai:** loop worker-health (refresh + upsert tiap 30 s) & job `health.probe` aktif (hanya half_open untuk connector berbayar) → I-13/I-20 |
| I-12 | done | claude | [evidence/I-12](evidence/I-12/) | `apps/scheduler`: `LeaderLock` (`lock:scheduler:leader`, SET NX PX + perpanjang hanya pemilik), `schedulerTick` (plan aktif jatuh tempo `FOR UPDATE SKIP LOCKED`, coalescing P-07, backpressure → plan priority ≥ 5 ditunda 60 s, window = hw − max(60 s, 0,2×interval) / lookback awal, jitter ±5%, run celah `gap_windows` sebagai backfill), `reapStuckRuns` (P-10: STUCK_RUN + bebaskan plan/stream), relay outbox → BullMQ (`publishOutbox({enqueue})`, jobId = `run.<id>.attempt.1` → publish ulang idempoten; relay tanpa enqueuer tidak menelan baris job), `main.ts` (tick 15 s, reaper 60 s, relay 1 s, SIGTERM). `@smip/db createCrawlRun` (run + outbox job satu transaksi) dipakai scheduler & API. Kontrak `CrawlDispatchPayload` (+`scheduled_for` untuk partisi). API `POST /topics/{id}/backfill` (admin; per plan per hari, maks 31 hari, prioritas 10) & `GET /topics/{id}/runs` (+attempts). `BullMqQueue.waitingCount`. Config `SCHEDULER_*`. 8+1 test. Belum: cost guard soft cap (I-23), pelepasan celah saat run celah sukses (I-24) |
| I-13 | done | claude | [evidence/I-13](evidence/I-13/) | `apps/worker-dispatch` (`handleDispatch`: CAS queued→dispatching, Router.plan + reservasi, compile sub-query sesuai capability connector terpilih, `fetch.<runtime>`; QUOTA_EXHAUSTED → `skipped`, ALL_THROTTLED → tunggu & dispatch ulang, lainnya → `failed` + backoff plan. `handleFetchResult`: CAS attempt, `reportOutcome`, `provider_attempts`, `pipeline.items` (item tetap diteruskan walau attempt gagal), failover/retry/recompile → attempt berikutnya, 0 item → `succeeded`, ada item → `processing` (ditutup sink I-15)). Semua enqueue via outbox (atomik). `apps/worker-fetch-bun` (`executeFetch`: semua sub-query × halaman, pageLimit/maxItems/deadline, item unik → JSONL.gz, kredensial didekripsi di memori, redaksi error). Paket baru `@smip/storage` (Bun.S3Client, dites ke versitygw). Migrasi 0013 `crawl_runs.routing`. Kontrak: `request.queries[]`, `recompile`, `PipelineItemsPayload`. **Bug ditemukan:** `BullMqQueue` tanpa opsi worker gagal start (`stalledInterval` undefined menimpa default) → diperbaiki + regresi. E2E 6 test (sukses multi sub-query+cursor, R-06, R-08, kosong, duplikat, quota) + smoke 3 proses terpisah di dev (`bun run dev:workers`). **Belum:** ASYNC_PENDING/`fetch.resume` (dibutuhkan actor Apify, I-17) → sementara `fail`; `retry_same` tidak memaksa connector yang sama |
| I-14 | todo | | | |
| I-15 | todo | | | |
| I-16 | todo | | | |
| I-17 | todo | | | Connector nyata #1. twitterapi.io menunggu API key → bila belum ada, mulai dari connector Apify yang TESTED (PROVIDER_MATRIX §2.0) |
| I-18 | todo | | | Per ladder PROVIDER_MATRIX §2.0 |
| I-19 | todo | | | Hanya jika S-15 menyetujui |
| I-20 | todo | | | |
| I-21 | todo | | | |
| I-22 | todo | | | |
| I-23 | todo | | | |
| I-24 | todo | | | Baru v0.4 |
| I-25 | todo | | | Baru v0.4 |

## Fase 3 — AI & Dashboard
| ID | Status | PIC | Bukti | Catatan |
|---|---|---|---|---|
| A-01 … A-10, D-01 … D-04, U-01 … U-07 | todo | | | Termasuk emotion (A-07), demografi (A-08/A-09), psychography (D-04/U-06), Conversation subpages (U-04), Resume (U-07) |

## Fase 4 — Provider Ops & Alert
| ID | Status | PIC | Bukti | Catatan |
|---|---|---|---|---|
| O-01 … O-07 | todo | | | |

## Fase 5 — Hardening
| ID | Status | PIC | Bukti | Catatan |
|---|---|---|---|---|
| H-01 … H-07 | todo | | | |

> Saat sebuah fase dimulai, pecah baris "F-01 … F-12" menjadi satu baris per task.

## Serah-terima (baca ini dulu saat melanjutkan / ganti model)

**Terakhir diperbarui: 2026-09-28 (sesi 5).** Scope tidak berubah dari TASK.md v0.4. Fase 2 selesai: I-01..I-13. F-12 CI hijau di GitHub. **Berikutnya: I-14 worker-pipeline → I-15 worker-sink (menutup run + watermark) → I-17 connector nyata (Apify, butuh fetch.resume) → I-13 worker-dispatch + worker-fetch-bun (pakai `Router` + pola loop run di `packages/router/test/router.test.ts`) → I-14/I-15 → I-03 Topic CRUD.** Urutan kerja asli (dependency sudah terpenuhi):

1. Fase 1 selesai kecuali **F-12** (CI) — butuh repo git + remote dari pemilik.
2. **Fase 2 berikutnya (tanpa API key):** **I-01** query parser/AST/matcher (`packages/query`) → **I-02** compiler → **I-04** `packages/connector-sdk` (+ contract suite) → **I-05** connector `fake` → **I-06/I-07** router → **I-08/I-09** rate limit & quota → **I-12** scheduler → **I-13..I-15** worker dispatch/fetch/pipeline/sink → **I-03** Topic CRUD API.
3. Lalu: Fase 2 mulai **I-01** (query parser) dan **I-04/I-05** (connector-sdk + connector `fake`), lalu connector nyata sesuai ladder **PROVIDER_MATRIX §2.0** — mulai dari yang TESTED via Apify (xquik X, scraping_solutions IG, scraper_one FB, apidojo TikTok) karena twitterapi.io masih menunggu API key.
6. Probe provider: `set -a; . ~/.config/smip/secrets.env; set +a; bun scripts/provider-probe/multi.ts <actor>` — **selalu** batas biaya kecil; kuota Apify pemilik FREE $5/bln (sisa ≈ $3,35 per 2026-09-28).

Cara kerja yang dipakai (ikuti agar konsisten):
- Infra dev: **`bun run dev:up`** (Docker Compose — Postgres 16, ClickHouse 26.3 LTS, Redis ×2, S3, Vault). `bun test packages apps scripts` menjalankan SEMUA test termasuk integrasi terhadap compose (220 test per 2026-09-28 sesi 5); test integrasi di-skip otomatis bila infra mati. Override: `TEST_PG_URL`, `TEST_CLICKHOUSE_URL`, `TEST_REDIS_QUEUE_URL`, `TEST_REDIS_CACHE_URL`, `VAULT_ADDR`. `scripts/spike-infra.sh` hanya untuk `bun run compat` (spike Fase 0).
- Setiap task selesai: `bun run check` hijau → `scripts/evidence.sh <ID> <perintah test>` → baris PROGRESS diisi → CHANGELOG bila ada perubahan dokumen.
- Paket npm baru → tambah check di `scripts/compat/` dulu (Golden Rule 8).
- **Jangan** kerjakan hal yang butuh API key / akun provider (S-14, contract test S-11..S-17) sampai pemilik meminta.

### Menunggu pemilik (tidak bisa dikerjakan agent di host ini)
| Butuh | Membuka | Perintah / tindakan (Ubuntu 24.04) |
|---|---|---|
| ~~Docker Engine + compose~~ | F-11, S-05 | **SUDAH** (2026-09-28). Sesi shell lama perlu `sg docker -c …` atau login ulang |
| kind + kubectl + helm (+KEDA) | S-05 (hanya profil Kubernetes) | lihat blok perintah di jawaban agent 2026-09-28 / DEPLOYMENT §4 |
| ~~Library sistem Chromium~~ | Playwright E2E | **SUDAH** (2026-09-28) — check Playwright kini COMPATIBLE tanpa workaround |
| ~~Token GitHub ber-scope `workflow`~~ | F-12 | **SUDAH** (2026-09-28) — workflow di-push pemilik, CI run pertama lulus |
| API key twitterapi.io | S-14 (X utama), I-17 | pemilik akan memberikan; Apify sudah ada (plan FREE $5/bln — sisa ≈ $3,35 per 2026-09-28) |
| Reviewer manusia ke-2 | S-10..S-13, S-16, S-17, S-21 → `done` | review dokumen & ADR-001 |

## Log Keputusan / Blocker
| Tanggal | Item | Keterangan |
|---|---|---|
| 2026-09-27 | Docs v0.1 | Seluruh spesifikasi awal dibuat; angka provider masih UNVERIFIED |
| 2026-09-27 | Docs v0.2 | Parity dgn produk referensi: emotion, psychography (gender/age, aktif default — ADR-007), model query (keyword/media/lang — ADR-008), Conversation/Resume, hashtag/most-reposted/gallery/contributors, 8 platform first-class. Bug fix: FK partisi, retensi post global, split Redis + guard dedup CH, reaper inflight, SSE cookie-auth, interval 5/15/30/45/60. + AGENTS.md |
| 2026-09-28 | Lanjutan sesi 2 | API key di-skip (arahan pemilik). S-08 done (Playwright via lib user-space, drizzle-kit). Verifikasi dokumen provider S-11..S-17 (IG hashtag saja, Threads official keyword search ada, YouTube 100 search/hari, TikTok Research API non-komersial). S-21 keputusan stack. Fase 1 dimulai: F-01, F-02, F-03, F-06, F-07, F-08 done. |
| 2026-09-28 | Docs v0.4 + spike Fase 0 | Review menyeluruh (REVIEW-2026-09-28): 53 temuan diperbaiki; twitterapi.io jadi provider X utama (S-10, DOCS); scope MVP 6 platform; spike S-01..S-09 dijalankan tanpa Docker — 8 bug baru hanya terlihat saat dijalankan (jobId `:`, SSE idleTimeout, SET LOCAL/nullif, dedup window ClickHouse, MinIO diarsipkan, sort key feed). |
| 2026-09-28 | Docs v0.3 | Serap dari docs pembanding: COST_MODEL.md (baru), collection stream/dedup planner (ADR-009), backup provider ladder + arti-angka per platform, nlp_labels + self-host NLP, ekspektasi akurasi realistis, cost guard throttle, matcher inverted-index, anti-goals, framing buzzer, cakupan screenshot QA. Task baru: I-22/I-23/A-10. Stack tidak diubah (tetap Bun/ClickHouse). |
