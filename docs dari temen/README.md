# SMA — Social Media Analytics & Sentiment Platform

Platform monitoring dan analisis percakapan media sosial untuk konten berbahasa Indonesia. Definisikan topic lewat boolean query, sistem mengumpulkan post yang cocok dari 6 platform secara berkelanjutan, mengklasifikasi sentimen dan isu otomatis, lalu menyajikannya sebagai dashboard yang bisa di-refresh tiap 5 menit sampai 1 jam.

**Status:** E1 (fondasi) selesai — 7 task `[x]`, 4 `[~]` menunggu Docker. Berikutnya: T-011 (interface SourceAdapter). Lihat [TASK.md](TASK.md).

---

## Dokumen

| File | Isi |
|---|---|
| [PRD.md](PRD.md) | Requirement produk — 46 FR yang bisa diuji, data model, kriteria sukses |
| [TASK.md](TASK.md) | 75 task Fase 1, terpetakan ke FR, dengan acceptance criteria |
| [PROGRESS.md](PROGRESS.md) | Log pengerjaan — satu entri per task selesai |
| [CLAUDE.md](CLAUDE.md) | Panduan kerja repo dan konvensi |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Desain sistem, alur data, skema |
| [docs/DATA-SOURCES.md](docs/DATA-SOURCES.md) | Provider, kontrak adapter, rencana cadangan, catatan legal |
| [docs/COST-MODEL.md](docs/COST-MODEL.md) | Perhitungan biaya lengkap dengan penurunannya |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Fase 2–4 menuju paritas penuh |

Mulai dari [PRD.md](PRD.md).

---

## Ringkasan teknis

**Stack.** Next.js 15 + TypeScript (dashboard), FastAPI + Celery (worker/NLP), PostgreSQL (konfigurasi), OpenSearch (post, pencarian, agregasi), Redis (antrean, cache).

**Platform Fase 1.** X/Twitter, Instagram, TikTok, Facebook, Threads, YouTube.

**Sumber data.** Provider third-party di balik satu interface adapter. API resmi tidak dipakai karena Meta, TikTok, dan Threads sama sekali tidak menyediakan pencarian keyword publik — rincian di [DATA-SOURCES.md](docs/DATA-SOURCES.md).

**NLP.** Klasifikasi lewat Claude Haiku 4.5 di Fase 1, sekaligus mengumpulkan labeled corpus. Fase 4 melakukan fine-tune IndoBERT dari korpus itu dan pindah ke inference self-host di CPU.

---

## Biaya

| Skenario | Total/bulan | Per topic |
|---|---:|---:|
| 1 topic (pilot) | $94–149 | Rp 1,55–2,45 jt |
| 30 topic | $345 | **Rp 190 rb** |
| 108 topic | $699 | **Rp 107 rb** |
| 30 topic, NLP self-host | $275 | **Rp 151 rb** |

Biaya per topic turun seiring jumlah topic bertambah — konsekuensi dari desain collection stream bersama. Penurunan angkanya di [COST-MODEL.md](docs/COST-MODEL.md).

---

## Quick start

Butuh Python 3.12+, Node 22+, dan Docker.

```bash
make install
cp .env.example .env    # isi SMA_SECRET_KEY minimal
make up                 # Postgres, OpenSearch, Redis, MinIO + pasang index
make migrate
make dev
```

Tabel user kosong setelah migrasi, dan tidak ada pendaftaran mandiri — ini
sistem internal. Buat akun pertama dari baris perintah:

```bash
python -m sma_api.auth.buat_user admin@instansi.go.id --role admin
```

Password diminta lewat prompt, tidak pernah lewat argumen: argumen baris
perintah tercatat di riwayat shell dan terlihat di daftar proses.

Verifikasi tanpa Docker (lint, typecheck, unit test):

```bash
make lint && make test-unit
```
