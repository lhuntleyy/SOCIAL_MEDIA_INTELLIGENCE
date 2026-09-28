# AGENTS.md — panduan kerja untuk model/agent (dan manusia)

Dokumen ini membuat siapa pun yang mengerjakan repo **Social Media Intelligence Platform (SMIP)** tetap di jalur, walau model/agent-nya berganti. **Baca ini lebih dulu**, lalu `README.md`, lalu dokumen sesuai kebutuhan.

> Status repo: **dokumentasi v0.4 + Fase 1 berjalan** (paket `packages/*`, script `scripts/*`). **Melanjutkan pekerjaan? Baca `docs/PROGRESS.md` § Serah-terima dulu** — berisi urutan task berikutnya, cara kerja, dan daftar yang menunggu pemilik. Scope = TASK.md; jangan diubah tanpa keputusan pemilik. Jangan menandai task `done` tanpa bukti test (lihat DoD).

---

## 1. Apa yang sedang dibangun
Platform social listening + analitik **multi-tenant, provider-agnostic, Bun-first**: tarik data dari 6 platform MVP (X, Instagram, Facebook, Threads, TikTok, YouTube; Bluesky & Reddit di registry, connector Fase 6) lewat **banyak provider sekaligus** (official / third-party / unofficial) dengan routing + failover + rate limit + quota + health check yang **dikonfigurasi, bukan di-hardcode**. Analitik: exposure, sentiment (+by-engagement), emotion (8 emosi), issues, hashtags, geo, audience, psychography (gender/age agregat), contributors, gallery.

## 2. Golden Rules (TIDAK BOLEH dilanggar)
1. **Jangan mengarang** API, rate limit, harga, atau capability provider. Semua angka provider disimpan di DB + `source_ref` + `verified_at`; yang belum → `UNVERIFIED` dan **tidak dipakai routing produksi**. (Lihat `docs/PROVIDER_MATRIX.md`.)
2. **Jangan hardcode provider.** Business logic hanya kenal `platform` + `operation`. Provider dipilih Router dari konfigurasi DB.
3. **Provider-specific logic HANYA** di `packages/connectors/*` dan `workers-py/connectors/*`. Tidak di `packages/core`, tidak di route API.
4. **Credential tidak pernah plaintext** di DB/log/queue/response (envelope encryption; secret write-only).
5. **Semua ingest asynchronous** via queue. API server tidak memanggil provider eksternal langsung.
6. **Unofficial API (instagrapi, dll.) hanya di worker Python terisolasi** (egress allowlist, non-root), tidak pernah di API server.
7. **Analytics dibaca dari tabel agregat** (`agg_*`), bukan dari raw/`posts` langsung.
8. **Jangan asumsikan npm package kompatibel dengan Bun** — lolos `scripts/compat-check.ts` (fase 0) dulu; hasil di `docs/adr/ADR-001`.
9. **Task tidak `done` tanpa test lulus** + bukti (link CI) di `docs/PROGRESS.md`.
10. **Psychography (gender/age) hanya agregat** + coverage + confidence; **tidak pernah** label individu di feed/export; **tidak ada label `below_18` per akun** (data anak, UU PDP). **Tidak ada** inferensi atribut sensitif lain (agama, etnis, orientasi politik/seksual, kesehatan). (ADR-007, SECURITY §9, AI_SPEC §12.)
11. **JANGAN** buat konten yang melibatkan anak (CSAM) dalam bentuk apa pun; **jangan** bangun teknik bypass anti-bot/captcha atau fingerprint spoofing — kalau provider di-block, **failover**, bukan melawan blokir.

## 3. Konvensi teknis kunci
- **Bun-first** (TS). Library non-JS (instagrapi, model NLP) → worker Python; kontrak lewat JSON Schema bersama (`packages/contracts` → pydantic).
- **Hexagonal**: `packages/core` = domain + use-case + ports, tanpa impor DB/queue/connector. Dependency-rule dicek CI (`dependency-cruiser`/script).
- **Canonical Item**: field tak diketahui = **`null`, bukan 0/string kosong**. Jangan menebak timestamp/ID.
- **OLTP ≠ OLAP**: Postgres (config/state, RLS per tenant) vs ClickHouse (konten + agregat).
- **Event-sourcing `sign` -1/+1 + SummingMergeTree** untuk SEMUA agregat (sentiment, emotion, hashtag, gender, age). Override/reprocess/engagement = insert pasangan -1/+1, jangan UPDATE. Widget berbasis `uniq` tidak bisa dikurangi → rebuild periodik.
- **Enrichment mahal di-cache lintas tenant**: `enr:` (per konten: sentiment/emotion/issues), `enrdem:` (per akun: gender/age). Sentiment/emotion per post, bukan per tenant.
- **Idempoten**: setiap consumer aman diproses 2×. Dedupe konten via Redis `seen*` **plus** guard ClickHouse (jangan bergantung pada satu saja). Redis **queue** (`noeviction`) dipisah dari Redis **cache/dedupe**.
- **Multi-tenancy**: Postgres RLS (`app.tenant_id`), query ClickHouse wajib `tenant_id` (tipe branded). `posts` global; `topic_match_events` per tenant.
- **Model LLM** (fallback AI): ID via config + verifikasi `GET /v1/models`, **tanpa suffix tanggal**. Default `claude-opus-5` (bukan model tertinggi; Haiku 4.5/Sonnet 5 dipilih via eval S-20). Structured output via `output_config.format`; untuk klasifikasi set `effort: "low"` (thinking ditagih sebagai output).
- **Provider X utama = twitterapi.io** (PROVIDER_MATRIX §6.1, status DOCS). Minimum biaya per request walau kosong → poll kosong tidak gratis.

## 3a. Kesalahan yang mudah terjadi (hindari)
- **Catat biaya dari post yang DISIMPAN, bukan yang DIKEMBALIKAN provider.** Provider menagih untuk yang mereka kirim. `usage.results` = dikembalikan (CONNECTOR_SPEC §4a, COST_MODEL §3).
- **Menghapus post yang tak cocok topic mana pun.** Dibutuhkan untuk backfill topic baru tanpa fetch ulang berbayar (ARCHITECTURE §12). Simpan (murah); hanya NLP untuk yang match (mahal).
- **Menghitung ulang agregat dari nol.** Rollup wajib inkremental (`sign` MV). Recompute penuh OK di 100K post, bencana di 10 juta.
- **`0` untuk metrik tak tersedia.** `null` = tak ada data; `0` = nol nyata. Menyamakannya merusak rata-rata diam-diam.
- **Menyembunyikan kategori `unknown`** (provinsi/bahasa/demografi tak terdeteksi). Harus selalu terlihat + coverage.
- **Fetch tidak inkremental.** Menghancurkan model biaya s/d 12,7× (COST_MODEL §3). Kalau platform tampak tak dukung inkremental → angkat sebagai masalah, cari mitigasi, jangan diam-diam lewati.
- **Memajukan high-watermark pada run `partial`**, atau melanjutkan dari `since = max(published_at)`. Hasil search terurut terbaru→terlama; celahnya ada di bagian **lama** (CONNECTOR_SPEC §7).
- **Kolom non-aditif di SummingMergeTree** (followers, handle). Akan dijumlah saat merge → pakai `SimpleAggregateFunction(anyLast)`.
- **Mengira poll kosong gratis.** twitterapi.io menagih minimum per request.

## 4. Peta dokumen (urutan baca)
`README.md` → `docs/SOCIAL_MEDIA_INTELLIGENCE_PRD.md` → `ARCHITECTURE.md` → `DATA_MODEL.md` → `CONNECTOR_SPEC.md` → `PROVIDER_MATRIX.md` → `COST_MODEL.md` → `QUEUE_SPEC.md` → `AI_SPEC.md` → `API_SPEC.md` → `UI_SPEC.md` → `SECURITY.md` → `OBSERVABILITY.md` → `DEPLOYMENT.md` → `TESTING.md` → `RUNBOOK.md` → `adr/` (ADR-001..009) → `TASK.md` → `PROGRESS.md` → `CHANGELOG.md`.

Saat menambah fitur, **jaga konsistensi silang**: endpoint (API_SPEC) ↔ agg/tabel (DATA_MODEL) ↔ widget (UI_SPEC) ↔ queue/AI (QUEUE_SPEC/AI_SPEC) ↔ test (TESTING) ↔ task (TASK/PROGRESS) ↔ CHANGELOG.

## 5. Menambah platform/provider baru (tanpa ubah core)
1. `INSERT platforms(...)`. 2. Buat connector (TS/Python) yang penuhi interface `Connector` + lolos contract suite. 3. Daftar manifest → upsert `connectors` + `connector_capabilities(declared)`. 4. Job `connector.verify` → `verified`. 5. Buat `routing_policy` + `routing_rules` (`enabled=false` dulu, weight kecil setelah verified). 6. UI baca `GET /platforms` otomatis. **Nol perubahan** di `packages/core`/route analytics/skema ClickHouse.

## 6. Definition of Done (per task)
- [ ] Kode + test (unit/contract/integration sesuai jenis) lulus di CI (Fase 0 sebelum F-12: evidence di `docs/evidence/<ID>/`).
- [ ] Tidak menurunkan coverage paket inti (`core`/`router`/`query` ≥ 90%).
- [ ] Lint, typecheck, dependency-rule lulus.
- [ ] Dokumen terkait diperbarui (spec/ADR/RUNBOOK).
- [ ] Connector: contract suite + fixture + verify staging (`evidence_ref`).
- [ ] Model AI: eval report (macro-F1 tak turun; coverage untuk emotion/gender/age).
- [ ] Entri `CHANGELOG.md [Unreleased]` + `PROGRESS.md` dgn bukti.

## 7. Perintah
Semua perintah `bun run …` dijalankan dari **root repo** (`cd ~/social-intel`) — dari folder lain Bun tidak menemukan `package.json` ("Script not found").
- `bun install` · `bun run check` (Biome lint + `tsc` + dependency-rule `scripts/check-deps.ts`) · `bun test` · `bun run compat` (spike Fase 0 → `docs/evidence/compat/`).
- Infra lokal tanpa Docker: `scripts/spike-infra.sh start|stop|status` (Redis ×2, ClickHouse, Postgres 16, S3, Vault dev) — dipakai test integrasi sampai compose (F-11) bisa jalan.
- Rekam bukti task: `scripts/evidence.sh <TASK-ID> <perintah>` → `docs/evidence/<TASK-ID>/`.
- Bun ada di `~/.bun/bin` (tambahkan ke PATH). Paket baru **wajib** ditambah check di `scripts/compat/` dulu (Golden Rule 8).
- `bun run dev:up` / `dev:down` — infra dev via Docker Compose + migrasi + seed (F-11). Sesi shell yang dibuat sebelum user masuk grup `docker` perlu `sg docker -c "…"`.
- `bun run dev:workers` — jalankan scheduler + worker-dispatch + worker-fetch-bun + worker-pipeline + worker-ai-stub (label netral `stub-0`, dev saja) + worker-sink (env `.env.dev`, connector `fake.*` menghasilkan item demo); seed membuat topik "Demo KDMP" + akun provider fake sehingga alur run langsung jalan. Ctrl+C = shutdown graceful.
- Migrasi: `bun run db:migrate up|down|status` (Postgres, SQL-first), `bun run ch:migrate up|down|status` (ClickHouse).
- Placeholder: `pytest`.

## 8. Yang belum pasti (verifikasi sebelum implement)
- Makna persis `media_tags`/`not_media_tags` di produk (ADR-008).
- Isi submenu **Resume** (tidak terlihat penuh di screenshot).
- Provider per platform: lihat **PROVIDER_MATRIX §2.0** (ladder multi-provider, banyak sudah **TESTED** via Apify 2026-09-28). IG & FB **punya** keyword search via pihak ketiga (koreksi atas kesimpulan dokumen sebelumnya).
- Token Apify ada di `~/.config/smip/secrets.env` (bukan di repo). Kuota Apify pemilik = plan FREE $5/bln — setiap probe wajib `maxTotalChargeUsd` kecil & `memory` minimum; laporkan biaya.
- **twitterapi.io API key belum ada** → jangan uji twitterapi.io sampai pemilik memberi key. S-14 (latency ≥ 5 sampel) boleh dikerjakan untuk connector Apify dalam batas kuota.
- Keputusan jalur NLP A/B & model fallback (S-20); bucket `below_18` (S-23).
- Kompatibilitas Bun tiap dependency (fase 0 / ADR-001).
