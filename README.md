# Social Media Intelligence Platform (SMIP)

Platform social listening + sentiment analysis yang **multi-tenant, provider-agnostic, Bun-first**.
Data ditarik dari **6 platform MVP** (X, Instagram, Facebook, Threads, TikTok, YouTube; Bluesky & Reddit sudah di registry, connector Fase 6)
lewat **banyak provider sekaligus** (third-party seperti twitterapi.io untuk X & Apify untuk Meta/TikTok, official API seperti YouTube Data API, unofficial library seperti instagrapi sebagai standby)
dengan **routing, failover, rate limit, quota, dan health check** yang semuanya dikonfigurasi, bukan di-hardcode.

Analitik: exposure, **sentiment** (+ by-engagement), **emotion/perception 8 emosi**, issues & **hashtags**, geo provinsi, audience, **psychography (gender & age range — agregat, dengan coverage + kontrol UU PDP)**, contributors, gallery — di section Dashboard / Conversation / Audience / Psychography / Resume.

> **Status (2026-10-04):** berjalan live di server demo — 6 platform, analitik lengkap (sentimen, emosi, isu, psikografi agregat, galeri),
> alert Telegram/webhook, export Excel/CSV, update instan (SSE), paket jadwal per kantor + jadwal adaptif, retensi, backup/restore,
> monitoring. Status per task: [PROGRESS](docs/PROGRESS.md) · riwayat: [CHANGELOG](CHANGELOG.md).

## Operasional cepat

| Kebutuhan | Dokumen |
|---|---|
| Instalasi dari nol | [docs/INSTALL.md](docs/INSTALL.md) |
| Insiden & prosedur (retensi §14, backup/restore §15, monitoring §16, deploy connector §13) | [docs/RUNBOOK.md](docs/RUNBOOK.md) |
| Menambah sumber data / provider baru | [docs/ONBOARDING_CONNECTOR.md](docs/ONBOARDING_CONNECTOR.md) |
| Biaya & paket | [docs/COST_MODEL.md](docs/COST_MODEL.md) §12 |
| Pedoman pelabelan (anotasi) | [docs/annotation-guide.md](docs/annotation-guide.md) |

> **Baca [`AGENTS.md`](AGENTS.md) lebih dulu** bila kamu (manusia atau agent/model) akan mengerjakan repo ini — berisi golden rules, konvensi, dan Definition of Done agar tidak keluar jalur.

## Urutan dokumen (baca berurutan)

| # | Dokumen | Isi |
|---|---------|-----|
| 1 | [SOCIAL_MEDIA_INTELLIGENCE_PRD.md](docs/SOCIAL_MEDIA_INTELLIGENCE_PRD.md) | Masalah, tujuan, persona, scope, requirement fungsional & non-fungsional |
| 2 | [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Komponen, alur data, keputusan teknologi, struktur folder |
| 3 | [DATA_MODEL.md](docs/DATA_MODEL.md) | Tabel PostgreSQL, ClickHouse, Redis keys, S3 layout, ERD |
| 4 | [CONNECTOR_SPEC.md](docs/CONNECTOR_SPEC.md) | Interface connector, canonical schema, router, failover, health, rate limit, quota |
| 5 | [PROVIDER_MATRIX.md](docs/PROVIDER_MATRIX.md) | *(tambahan)* Kandidat provider per platform + backup ladder + status verifikasi fakta |
| 6 | [COST_MODEL.md](docs/COST_MODEL.md) | *(tambahan)* Model biaya: volume, tarif estimasi, jebakan polling, skenario, cost guard, self-host NLP |
| 7 | [QUEUE_SPEC.md](docs/QUEUE_SPEC.md) | Daftar queue, payload, retry, DLQ, idempotency, backpressure |
| 8 | [AI_SPEC.md](docs/AI_SPEC.md) | Sentiment, emotion, keyphrase, geo, bahasa, psychography, korpus training, eval, LLM fallback |
| 9 | [API_SPEC.md](docs/API_SPEC.md) | Endpoint REST, request/response JSON, error, pagination, SSE |
| 10 | [UI_SPEC.md](docs/UI_SPEC.md) | Halaman, komponen, state, chart, admin provider, cakupan screenshot |
| 11 | [SECURITY.md](docs/SECURITY.md) | AuthN/Z, enkripsi credential, isolasi worker, compliance (UU PDP), ToS risk |
| 12 | [OBSERVABILITY.md](docs/OBSERVABILITY.md) | Log, metric, trace, SLO, alert, dashboard |
| 13 | [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Docker, compose, Kubernetes, scaling, backup, env var |
| 14 | [TESTING.md](docs/TESTING.md) | Strategi test, contract test connector, AI eval, Definition of Done |
| 15 | [RUNBOOK.md](docs/RUNBOOK.md) | *(tambahan)* Prosedur operasional saat insiden |
| 16 | [adr/](docs/adr/) | *(tambahan)* Architecture Decision Records (ADR-001..009; incl. 007 demografi, 008 model query, 009 collection stream) |
| 17 | [TASK.md](docs/TASK.md) | Breakdown task per fase + acceptance criteria |
| 18 | [PROGRESS.md](docs/PROGRESS.md) | Status task (hanya boleh `done` dengan bukti test) |
| 19 | [CHANGELOG.md](CHANGELOG.md) | Riwayat perubahan |
| — | [REVIEW-2026-09-28.md](docs/REVIEW-2026-09-28.md) | Kritik v0.3 + alasan + lokasi perbaikan |
| — | [docs/evidence/](docs/evidence/) | Bukti task Fase 0 (sebelum CI ada) |
| — | [`docs dari temen/`](<docs dari temen/README.md>) | Dokumen pembanding (stack lain, **referensi saja — jangan diedit**) |
| — | [screenshots/](screenshots/) | screenshot produk referensi (dirujuk UI_SPEC §7) |
| — | [ONBOARDING_CONNECTOR.md](docs/ONBOARDING_CONNECTOR.md) | *(tambahan)* Langkah menambah provider/actor baru: probe, kode, tes, urutan deploy, verify, routing |

## Aturan yang tidak boleh dilanggar (Golden Rules)

Sumber tunggal: **[AGENTS.md §2](AGENTS.md)** (11 aturan). Tidak disalin di sini agar tidak drift — v0.3 sempat punya dua versi berbeda (9 vs 11 aturan, `source_url` vs `source_ref`). Ringkasan satu baris: jangan mengarang fakta provider · jangan hardcode provider · credential selalu terenkripsi · ingest selalu async · analytics dari agregat · psychography hanya agregat · task tidak `done` tanpa bukti.

## Menjalankan spike Fase 0

```bash
bun install
bun run compat          # scripts/compat-check.ts → docs/evidence/compat/
```
Hasil & status per library: [ADR-001](docs/adr/ADR-001-bun-runtime.md).
