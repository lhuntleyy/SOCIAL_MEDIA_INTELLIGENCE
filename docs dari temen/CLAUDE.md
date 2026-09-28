# Panduan Kerja Repo

Untuk Claude Code dan siapa pun yang mengerjakan repo ini.

## Alur wajib

Repo ini dijalankan dengan siklus PRD → TASK → PROGRESS. Ikuti urutannya:

1. **Sebelum mulai:** baca [TASK.md](TASK.md), ambil task berikutnya yang dependency-nya sudah selesai.
2. **Selama mengerjakan:** kalau ternyata acceptance criteria salah atau tidak realistis, ubah di TASK.md dan catat alasannya di entri PROGRESS nanti. Jangan diam-diam mengerjakan sesuatu yang berbeda dari yang tertulis.
3. **Setelah selesai:** centang task di TASK.md **dan** tulis entri di [PROGRESS.md](PROGRESS.md). Keduanya, di commit yang sama.
4. **Perbarui tabel Status** di bagian atas TASK.md (jumlah selesai, task saat ini).

**Task tanpa entri PROGRESS dianggap belum selesai.** Ini bukan formalitas — entri progress adalah tempat deviasi tercatat, dan deviasi adalah hal yang paling mahal kalau hilang.

## Aturan yang tidak bisa ditawar

**Adapter wajib inkremental.** Adapter yang mengambil ulang data lama akan menghancurkan model biaya sebesar 12,7x. Kalau sebuah platform tampak tidak mendukung fetch inkremental, jangan diam-diam melewatinya — angkat sebagai masalah dan cari mitigasinya (lihat [COST-MODEL.md bagian 4](docs/COST-MODEL.md)).

**Setiap panggilan provider mencatat biayanya.** `FetchResult.cost` bukan opsional. Jangan pernah menambahkan jalur kode yang memanggil provider tanpa mencatat biaya.

**Setiap inference NLP menulis ke `nlp_labels`.** Ini korpus training untuk Fase 4. Data training tidak bisa dibuat surut — inference yang tidak tercatat hilang selamanya.

**Angka biaya hanya dari [COST-MODEL.md](docs/COST-MODEL.md).** Kalau ada dokumen lain yang berbeda, perbaiki dokumen itu, jangan buat versi baru.

## Struktur folder

```
apps/web/           Next.js 15 — dashboard, admin UI
  lib/schema.generated.ts   tipe hasil generate, JANGAN diedit manual
services/api/       FastAPI — analytics & admin API
services/worker/    Celery — collector, normalizer, enricher
  adapters/         Implementasi SourceAdapter, satu file per platform
  nlp/              Preprocessing, klasifikasi, ekstraksi
  tasks/            Task Celery per antrean
packages/schema/    Model Pydantic — SUMBER KEBENARAN bentuk data
packages/core/      Infrastruktur bersama: config, logging, db, search
migrations/         Alembic
infra/              docker-compose, script tunggu-service
tests/              Cermin struktur di atas
docs/               Arsitektur, sumber data, model biaya, roadmap
docs/screenshots/   13 screenshot referensi produk asal
```

**Kenapa `schema` dan `core` dipisah:** `schema` menjawab "data ini bentuknya apa", `core` menjawab "cara mengakses infrastruktur". Keduanya berubah karena alasan yang berbeda, dan `schema` harus tetap bisa diimpor tanpa menyeret SQLAlchemy, Redis, atau OpenSearch.

## Konvensi

**Bahasa.** Dokumentasi dan komentar dalam Bahasa Indonesia. Nama identifier, field schema, pesan commit, dan nama file dalam bahasa Inggris.

**Schema.** Model Pydantic di `packages/schema/` adalah sumber kebenaran. Tipe TypeScript di-generate dari sana. Jangan pernah mengedit tipe hasil generate secara manual.

**Commit.** `<tipe>(<scope>): <deskripsi> [T-xxx]`
Contoh: `feat(adapter): tambah fetch inkremental twitterapi.io [T-012]`
Tipe: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`.

**Test.** Adapter butuh test kontrak plus fixture terekam. Kode NLP butuh evaluasi terhadap gold set, bukan cuma unit test — unit test membuktikan kode berjalan, bukan membuktikan hasilnya benar.

## Perintah

```bash
docker compose up -d        # nyalakan Postgres, OpenSearch, Redis, MinIO
make dev                    # jalankan web + api + worker
make test                   # semua test
make eval                   # evaluasi NLP terhadap gold set
make schema                 # regenerasi tipe TS dari model Pydantic
make lint                   # lint dan typecheck ketiga bahasa
```

## Kesalahan yang mudah terjadi

**Mencatat biaya dari post yang disimpan, bukan hasil yang dikembalikan.** Provider menagih untuk apa yang mereka kirim. Mencatat hanya yang tersimpan membuat pelacakan biaya terlihat sehat sementara tagihan sebenarnya membengkak — persis mode kegagalan yang ingin dicegah FR-701.

**Memakai `0` untuk metrik yang tidak tersedia.** TikTok punya view, Twitter tidak. `null` berarti tidak ada data; `0` berarti nolnya nyata. Menyamakan keduanya membuat rata-rata jadi salah tanpa ada yang menyadari.

**Menghapus post yang tidak cocok topic apa pun.** Post tersebut dibutuhkan untuk backfill saat topic baru ditambahkan (FR-109). Membuangnya berarti backfill harus menarik ulang dari provider, dan itu berbayar.

**Menghitung ulang agregat dari nol.** Rollup harus inkremental. Menghitung ulang penuh baik-baik saja pada 100K post dan menjadi bencana pada 10 juta.

**Menyembunyikan kategori `unknown` di visualisasi.** Provinsi tak dikenal, bahasa tak terdeteksi, demografi tak terinferensi — semuanya harus terlihat. Menyembunyikannya membuat grafik lebih rapi dan membuat data jadi bohong.
