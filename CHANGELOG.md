# Changelog

Format mengikuti [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) dan [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Dokumentasi awal v0.1: PRD, ARCHITECTURE, DATA_MODEL, CONNECTOR_SPEC, PROVIDER_MATRIX, QUEUE_SPEC, AI_SPEC, API_SPEC, UI_SPEC, SECURITY, OBSERVABILITY, DEPLOYMENT, TESTING, RUNBOOK, ADR-001..006, TASK, PROGRESS.
- **v0.2 — parity dengan produk referensi + AGENTS.md:**
  - `AGENTS.md` (golden rules, konvensi, DoD untuk portabilitas antar-model).
  - **Emotion/Perception** (8 emosi Plutchik): `topic_match_events.emotion`, `agg_emotion_*`, AI_SPEC §4A, endpoint & widget.
  - **Psychography** (gender & age range, agregat, aktif default, dgn kontrol UU PDP): `author_demographics`, `agg_psycho_*`, AI_SPEC §12, ADR-007, endpoint & halaman.
  - **Model query** diperkaya: `keywords`, `media_tags`/`not_media_tags`, `languages` (id/en/ms) — ADR-008.
  - Section **Conversation** (Chronology, Gallery, Issues, Engagement, Emotion, Sentiment, Contributors, Issues Comparison) & **Resume**; **Hashtags** (treemap/cloud, `agg_hashtag_*`), **Most Reposted Accounts** (`parent.author`, `agg_reposted_author_*`), **Total Posts Comparison**, **Gallery** (`media_items`), **Contributors**.
  - 8 platform (incl. TikTok/YouTube/Bluesky/Reddit) menjadi first-class di registry & PROVIDER_MATRIX.

- **v0.3 — serapan konsep dari dokumen pembanding (`docs dari temen/`), diadaptasi ke stack kita:**
  - `docs/COST_MODEL.md` (baru): model biaya lengkap — volume baseline, tarif estimasi bersumber, jebakan polling (bill per hasil dikembalikan, overhead 1,25×), model token NLP, skenario 1/30/108 topic, cost guard 3 lapis, self-host NLP.
  - **Collection stream** (dedup fetch antar topic beririsan) — ADR-009, ARCHITECTURE §12, `collection_streams`/`stream_topic_links` (additive, near-term).
  - PROVIDER_MATRIX: **backup provider ladder** + kriteria pindah + "arti angka per platform" (FB page-list, IG official-vs-third-party) + aturan `usage`=hasil dikembalikan.
  - `nlp_labels` (korpus training permanen) + jalur **self-host IndoBERT** (AI_SPEC §14, DATA_MODEL §5.10).
  - Ekspektasi akurasi realistis (AI_SPEC §6.4); framing intelijen (User Created Time = indikator buzzer).
  - Cost guard **throttle, bukan stop** di soft cap (CONNECTOR_SPEC §11, QUEUE_SPEC §6).
  - Skalabilitas matcher (inverted-index term→kandidat topic) — CONNECTOR_SPEC §5.
  - Anti-goals di PRD (realtime <1m, prediksi viral, skor per-individu, platform sprawl).
  - AGENTS.md: "kesalahan yang mudah terjadi"; UI_SPEC: tabel cakupan screenshot (QA); media hotlink-vs-simpan.

- **Sesi 5 (2026-09-28) — Fase 2: I-01..I-15, F-12:**
  - `packages/query` (parser/AST/matcher/compiler set penutup), `packages/connector-sdk` (+ SSRF guard, contract suite), connector `fake`.
  - Router: tipe `RoutingSnapshot` di core, `loadRoutingSnapshot` (@smip/db), `SnapshotStore` + outbox (`writeOutbox`/`publishOutbox`, `cfg:version`) — R-12; `select()` dengan eliminasi berjejak, weighted-by-health, standby, round_robin/cost_aware, BYO per tenant — R-01..R-05, R-13, R-15.
  - Rate limit + quota (I-08/I-09): reservasi atomik satu skrip Lua (quota → Retry-After → token bucket → semaphore), commit/release idempoten, sweeper, threshold 50/80/95%, flush/seed `quota_usage` — R-10, R-11. Migrasi 0010: `period` di PK `quota_usage`. Snapshot router memuat `rate_limit_policies` & `quota_policies`; `cost_aware` memperhitungkan `fixed_cost_per_run`.
  - Failover & health (I-10/I-11): `decideFailover` (tabel §7 → keputusan + efek), kelas `Router` (port `ProviderRouter`, `reportOutcome(o, ctx)`), `HealthMonitor` circuit breaker Lua + `HealthCache`, adapter `@smip/db` (akun needs_attention/cooldown, capability failed, provider_health) — R-06..R-09.
  - Topic API (I-03): CRUD + validate/preview/cost-estimate + SyncCrawlPlans, scope API key ditegakkan; migrasi 0011 (`topics.version`), 0012 (grant INSERT outbox ke smip_app); helper `textArray`/`inList`.
  - Scheduler (I-12): `apps/scheduler` (leader lock, tick SKIP LOCKED + coalescing + backpressure + jitter, reaper, relay outbox → BullMQ), API backfill & riwayat run, kontrak `CrawlDispatchPayload`.
  - Worker (I-13): `apps/worker-dispatch`, `apps/worker-fetch-bun`, `@smip/storage`, `bun run dev:workers`, migrasi 0013 (`crawl_runs.routing`), kontrak `queries[]`/`PipelineItemsPayload`; seed membuat akun fake + topik demo. CI GitHub Actions (F-12) hijau.
  - Pipeline (I-14): `apps/worker-pipeline`, `@smip/geo` + ADR-010 (gazetteer provinsi, UNVERIFIED), migrasi 0014 (counter penutupan run) & 0015 (38 provinsi), `finalizeRunIfDone`/`settleGap`, kontrak `PostRecord`.
  - Sink (I-15): `apps/worker-sink` (ClickHouse + guard dedup + penutupan run + realtime.notify), ledger `processed_messages` (migrasi 0016), `apps/worker-ai-stub` (dev), `FakeConnector.autoRespond`; `dev:workers` kini mengalir sampai ClickHouse.
  - Atribusi biaya stream (I-25): `tenant_matches`, `allocateStreamRunCost`, `cost_allocations` diterapkan ke quota tenant (Redis), riwayat run stream di API; migrasi 0018. P-20.
  - Admin API provider management (I-21, API_SPEC §9): providers, connectors (config ↔ `config_schema` + SSRF guard, health-check/verify via outbox), accounts (secret write-only, fingerprint HMAC, rotasi/revoke crypto-shred, BYO admin tenant), routing policies (If-Match/versioned, simulate read-only), rate limits (wajib bersumber), quotas, usage, DLQ, audit logs. Env api baru `CREDENTIAL_PEPPER_B64`.
  - Cost guard (I-23): soft cap biaya → scheduler throttle interval ke 1 jam (bukan stop), stream multi-tenant adil, alert transisi via outbox, `would_throttle` di cost-estimate; migrasi 0019. P-16.
  - Connector YouTube Data API v3 official (I-18) verified live; manifest `allowedHosts` ditegakkan worker-fetch (egress per connector), `providerKind`; redaksi API key Google.
  - Collection stream (I-22): dedup planner, stream dijadwalkan & di-dispatch seperti plan, pipeline mode stream dgn `QueryIndex` (inverted index), migrasi 0017, flag `SCHEDULER_STREAMS_ENABLED`. P-14 e2e.
  - Partial success (I-24): sisi celah per `result_order`, maks 20 celah, `pruneGaps` + `smip_crawl_gap_abandoned_total`, P-18 e2e.
  - Fix: semua connector habis setelah sebagian item diterima → run `partial` (sebelumnya `failed`, celah hilang).
  - Keputusan pemilik: actor `apidojo` dikeluarkan (batas run bulanan plan FREE). Pengganti VERIFIED live: X `apify.x.kaito`, `apify.x.scraperone`; TikTok `apify.tiktok.clockworks` (sinyal iklan & bahasa), `apify.tiktok.xmolodtsov`.
  - Connector per platform (I-18): `apify.instagram.boolean`, `apify.facebook.scraperone`, `apify.tiktok.apidojo`, `apify.youtube.streamers`, `apify.threads.scrapersdelight` (VERIFIED live), `apify.x.apidojo` (FAILED: batas plan FREE → dipetakan `QUOTA_EXHAUSTED`). Evidence `docs/evidence/shapes/` & `docs/evidence/verify/`.
  - Fix: YouTube `oldestPostDate` tidak dihormati mode search → `dateFilter`; placeholder `noResults` tidak dihitung sebagai hasil.
  - Connector nyata #1 (I-17): `packages/connectors/apify` (`apify.x.xquik`, VERIFIED live), run async `fetch.resume`, `scripts/connectors.ts` (register/account/verify), `scripts/provider-probe/shape.ts`. ADR-010: daftar 38 provinsi dikonfirmasi pemilik.
  - Fix: jobId `fetch.result` sama untuk semua bagian async → hasil resume dibuang BullMQ.
  - Fix (tes): flaky `admin.test.ts` — bagian acak secret API key (base64url) bisa diawali `_`, `split("_")` menghasilkan string kosong (CI run 36410366283 gagal karenanya).
  - Fix: `engagement_known=false` dari AI menimpa metrik post yang diketahui.
  - Fix: pembanding `scheduled_for` lewat `Date` JS kehilangan mikrodetik (UPDATE meleset diam-diam).
  - Fix: `BullMqQueue` tanpa opsi worker gagal start (stalledInterval undefined).
  - Fix: payload `outbox` tersimpan sebagai string JSON (encode ganda, sama dengan F14) — ditangkap tes I-06.
- **Sesi 4 (2026-09-28) — Fase 1 hampir selesai (F-04, F-05, F-09, F-10, F-11):**
  - `packages/db`: 9 migrasi SQL up/down (skema DATA_MODEL §2–§5, 5 tabel partisi, RLS, role `smip_app/system/auth/py_reader`, trigger audit append-only & owner terakhir), migrator ber-checksum, `withTenant/withAuthRole/withSystem`, skema drizzle + test sinkron, tipe `jsonb` aman untuk bun-sql.
  - `packages/analytics`: 2 migrasi ClickHouse (konten + 16 agregat/MV), `sinkInsertSettings()`; lulus di ClickHouse 26.10 & 26.3 LTS.
  - `apps/api`: auth (login, JWT EdDSA, refresh rotation + reuse detection, lockout, MFA TOTP), admin tenant/user/membership/API key, impersonasi operator teraudit.
  - `infra/compose` + `bun run dev:up` (compose + migrasi + seed idempoten); test integrasi default ke compose (97 test).
  - Bug 🔴 ditemukan & diperbaiki: dedup token tidak menjangkau MV (agregat dobel), email bocor ke log via pesan error ORM, `users` terbaca lintas tenant, JSONB ter-encode ganda (REVIEW F10–F14).
- **Sesi 3 (2026-09-28) — uji kontrak provider via Apify + multi-provider:**
  - PROVIDER_MATRIX §2.0 (ladder multi-provider semua platform: official + ≥ 2 Apify + vendor non-Apify) & §6.8 (hasil uji kontrak 10 actor). **Koreksi:** IG & FB **punya** keyword search via pihak ketiga (TESTED).
  - COST_MODEL: biaya tetap per run actor (start fee per GB memori, per halaman) + tarif TESTED.
  - CONNECTOR_SPEC §12: `memory` & `maxTotalChargeUsd` per run, buang PII tambahan, `resultOrder` tak terurut. Konvensi key connector per actor (DATA_MODEL §4.2).
  - Kode: `scripts/provider-probe/*` (probe Apify dengan batas biaya; evidence tanpa konten/PII).
  - Docker & library Chromium terpasang oleh pemilik → F-11 unblocked, Playwright COMPATIBLE.
- **Sesi 2 (2026-09-28) — verifikasi provider + Fase 1 dimulai:**
  - PROVIDER_MATRIX §6.2–§6.7: fakta resmi X cadangan, IG (**hashtag saja**, keyword caption NOT_AVAILABLE), FB (per Page), Threads (keyword search official via App Review), TikTok (Research API non-komersial), YouTube (100 `search.list`/hari). COST_MODEL §2 memakai tarif DOCS.
  - CONNECTOR_SPEC §5: derivasi hashtag dari query untuk platform tanpa keyword search.
  - ADR-001: Playwright (WORKAROUND) & drizzle-kit (COMPATIBLE) + keputusan final stack (S-21).
  - Kode Fase 1: `packages/core` (ID branded, port JobQueue), `config`, `observability`, `crypto`, `contracts` (+ JSON Schema & pydantic hasil generate), `queue`; `scripts/check-deps.ts`, `scripts/gen-contracts.ts`, `scripts/evidence.sh`; Biome.
  - PROGRESS § Serah-terima untuk kelanjutan lintas model.
- **v0.4 — review menyeluruh + spike Fase 0 dijalankan** (detail & alasan: `docs/REVIEW-2026-09-28.md`):
  - **Provider X = twitterapi.io** (utama), Apify & X official cadangan; fakta resmi di PROVIDER_MATRIX §6.1 (S-10, status DOCS): endpoint, `since_time`, **minimum $0,00015/request walau kosong**, konflik angka QPS dicatat.
  - Scope MVP diseragamkan jadi **6 platform** (X, IG, FB, Threads, TikTok, YouTube); task S-16/S-17 baru.
  - COST_MODEL: biaya minimum per request, dua jalur NLP (LLM-first vs hybrid) + harga model Claude, jebakan thinking token, infra hanya untuk profil MVP, sumber primer vs sekunder.
  - DEPLOYMENT: **profil MVP single-node**; MinIO OSS diganti (diarsipkan).
  - SECURITY/API: endpoint `POST /stream/ticket` (cookie `sse_ticket`), transfer lintas negara UU PDP, tanpa label `below_18` per akun.
  - Skenario test baru R-15, P-18..P-21, SEC-11, SEC-12; skenario security diganti prefix `SEC-`.
  - Task baru I-24 (celah partial success), I-25 (atribusi biaya stream).
  - Kode spike: `package.json`, `.bun-version` (1.4.2), `scripts/compat-check.ts` + `scripts/compat/*`, `scripts/spike-infra.sh`, bukti `docs/evidence/`.

### Fixed
- **v0.4:** partial success melompati celah (`since = max`) → window celah + watermark hanya maju saat `succeeded`; post tak-match tanpa jalur ke ClickHouse; `media_items` MV tanpa kolom sumber; SummingMergeTree menjumlahkan followers; agregat issue/akun tanpa dimensi sentiment; `agg_author_age_1d` menghitung post bukan akun; coverage psychography tak bisa dihitung; `nlp_labels` menunjuk teks yang terhapus 30 hari; retensi post tak-match; collection stream (interval, atribusi biaya, BYO); estimasi biaya berbasis request; nama queue `fetch.failed`; SSE tanpa cookie yang bisa dipakai.
- **v0.4 (dari spike):** jobId BullMQ tanpa `:`; SSE `idleTimeout: 0`; `set_config` + `nullif` untuk RLS; `non_replicated_deduplication_window` wajib; sort key `topic_matches` + `published_at`.
- FK ke tabel partisi `crawl_runs` (sertakan `scheduled_for`).
- Konflik retensi `posts` global vs per-tenant (kebijakan retensi global terpisah).
- Dedupe tidak lagi 100% bergantung Redis: **split Redis queue/cache** + **guard dedup sisi ClickHouse**.
- **Reaper `inflight_run_id`** untuk mencegah plan "beku" saat worker mati.
- SSE **wajib cookie-auth** (larang token di URL).
- Interval refresh disamakan ke produk: **5m/15m/30m/45m/1h** (dari sebelumnya termasuk 10m, tanpa 45m).
- Limitasi `uniqState` (override/reprocess) didokumentasikan + strategi rebuild.

### Notes
- Belum ada kode aplikasi (hanya kode spike Fase 0). Fakta provider berstatus `UNVERIFIED` kecuali twitterapi.io (`DOCS`, 2026-09-28).
- Model ID LLM (`claude-opus-5`) valid; bukan model tertinggi (ada `claude-fable-5-1`). Pilihan fallback final via eval S-20; cek ulang via `GET /v1/models` saat build (tanpa suffix tanggal).
