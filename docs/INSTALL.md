# Panduan Instalasi SMIP — dari server kosong sampai dashboard jalan

Dokumen ini untuk **operator** yang memasang SMIP di server baru (dev/demo satu mesin). Semua perintah sudah dipakai di VPS
demo (Ubuntu, 2 vCPU / 2 GB). Untuk produksi lihat bagian **12. Menuju produksi** — beberapa hal di sini sengaja disederhanakan.

> Konvensi: blok perintah dijalankan sebagai user biasa (mis. `ubuntu`) dari folder repo `~/social-intel`, kecuali ditulis `sudo`.
> Nilai rahasia (token, API key, password) **tidak pernah** ditaruh di repo, dokumen, atau log.

## Daftar isi
1. Kebutuhan
2. Siapkan server (paket, Docker, swap, firewall)
3. Ambil kode & pasang Bun
4. Simpan secret di luar repo
5. Nyalakan infrastruktur (Postgres, Redis ×2, ClickHouse, S3, Vault) + migrasi + seed
6. Jalankan API, worker, dan web (mode demo publik HTTPS)
7. Login pertama & akun owner
8. Sumber data media sosial (Apify, YouTube) — daftar, verifikasi, aktifkan routing
9. AI (Gemini / OpenAI / OpenRouter / Claude / custom)
10. Kantor, pengguna, topik — alur pakai
11. Operasional harian (update, restart, log, backup, biaya)
12. Menuju produksi
13. Masalah umum

---

## 1. Kebutuhan

| Item | Minimum demo | Disarankan (produksi awal ≤ 30 topik) |
|---|---|---|
| OS | Ubuntu 22.04/24.04 64-bit | sama |
| CPU / RAM | 2 vCPU / 2 GB **+ swap 4 GB** | 4–8 vCPU / 16 GB |
| Disk | 30 GB SSD | 200 GB+ SSD (ClickHouse tumbuh dengan data) |
| Jaringan | IP publik, port 80 & 443 terbuka | + domain sendiri |
| Akun eksternal | Apify (FREE $5/bln cukup untuk demo kecil), Google Cloud (YouTube Data API v3, gratis), Google AI Studio (Gemini) | Apify berbayar (Starter/Scale), LLM berbayar |

Domain **tidak wajib**: demo memakai `sslip.io` — hostname `43-156-61-233.sslip.io` otomatis menunjuk ke IP `43.156.61.233`, dan Caddy
mengambil sertifikat HTTPS Let's Encrypt untuknya. HTTPS **wajib** (cookie sesi `Secure`).

## 2. Siapkan server

```bash
sudo apt-get update && sudo apt-get install -y git curl unzip ca-certificates openssl
```

**Docker Engine + Compose v2** (repo resmi Docker):
```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER    # lalu LOGOUT & login lagi (atau pakai `sg docker -c "…"` di sesi lama)
docker compose version           # harus v2.x atau lebih baru
```

**Swap** (wajib di RAM 2 GB — build web, test, dan ClickHouse butuh ruang lonjakan):
```bash
sudo fallocate -l 4G /swap.img && sudo chmod 600 /swap.img && sudo mkswap /swap.img && sudo swapon /swap.img
echo '/swap.img none swap sw 0 0' | sudo tee -a /etc/fstab
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-smip.conf && sudo sysctl -p /etc/sysctl.d/99-smip.conf
```
(Jika `/swap.img` sudah ada: `sudo swapoff /swap.img` dulu, lalu ulangi dari `fallocate`.)

**Firewall.** Hanya 22, 80, 443 yang perlu terbuka ke internet:
```bash
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw enable
```
Catatan: port yang di-*publish* Docker melewati ufw. Compose dev mengikat Postgres/Redis/ClickHouse/S3/Vault ke `127.0.0.1` saja,
jadi tidak terbuka ke publik; yang publik hanya Caddy (80/443).

## 3. Ambil kode & pasang Bun

```bash
git clone https://github.com/lhuntleyy/SOCIAL_MEDIA_INTELLIGENCE.git ~/social-intel
cd ~/social-intel
curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.2"      # versi yang dipin repo
echo 'export PATH=$HOME/.bun/bin:$PATH' >> ~/.bashrc && source ~/.bashrc
bun --version        # 1.4.2
bun install          # dependency sesuai bun.lock
bun run check        # lint + typecheck + aturan dependensi (harus lulus)
```
Semua `bun run …` dijalankan dari **root repo**.

## 4. Simpan secret di luar repo

```bash
mkdir -p ~/.config/smip && chmod 700 ~/.config/smip
# kunci tanda tangan JWT (EdDSA) untuk API mode demo
openssl genpkey -algorithm ed25519 -out ~/.config/smip/jwt-demo.pem && chmod 600 ~/.config/smip/jwt-demo.pem
# token/API key provider — isi nilainya dengan editor, JANGAN lewat riwayat shell publik
install -m 600 /dev/null ~/.config/smip/secrets.env
nano ~/.config/smip/secrets.env
```
Isi `secrets.env` (satu baris per kunci):
```
APIFY_TOKEN=…            # https://console.apify.com/settings/integrations
YOUTUBE_API_KEY=…        # Google Cloud Console → APIs & Services → YouTube Data API v3 → Credentials
GEMINI_API_KEY=…         # https://aistudio.google.com/apikey
HIKERAPI_KEY=…           # https://hikerapi.com (Instagram)
```
File ini hanya dibaca oleh skrip operator saat mendaftarkan akun (nilai disegel ke database terenkripsi, tidak pernah dicetak).
Setelah didaftarkan, kunci bisa dihapus dari file ini.

## 5. Nyalakan infrastruktur + migrasi + seed

```bash
bun run dev:up
```
Yang terjadi (`scripts/dev-up.ts`): `docker compose up` (Postgres 16, Redis queue + Redis cache, ClickHouse profil hemat memori,
S3 versitygw, Vault dev) → tunggu sehat → buat bucket S3 → migrasi Postgres (`packages/db/migrations`) & ClickHouse
(`packages/analytics/migrations`) → **seed**. Seed membuat kantor contoh, topik "Demo KDMP", connector uji (`fake.*`), dan
**owner** `admin@contoh.local` — passwordnya **dicetak sekali** di layar (simpan!). Untuk menentukan sendiri:
`SEED_ADMIN_PASSWORD='password-panjang-anda' bun run dev:up`.

Env untuk service & skrip ada di `infra/compose/.env.dev` (nilai dev, bukan rahasia produksi). Cek status:
```bash
docker compose -f infra/compose/docker-compose.yml ps
bun --env-file=infra/compose/.env.dev scripts/db-migrate.ts status
bun --env-file=infra/compose/.env.dev scripts/ch-migrate.ts status
```

## 6. Jalankan API, worker, dan web (demo publik HTTPS)

Atur hostname publik di `infra/compose/.env.demo`:
```
PUBLIC_IP=203.0.113.10
SITE_HOST=203-0-113-10.sslip.io      # atau domain Anda (A record → IP server)
```
Lalu:
```bash
bun run demo:up
```
`demo:up` = build web (`apps/web/dist`) → migrasi → compose up tiga container tambahan:
- **api** (`apps/api`, port internal 8080) — kunci JWT dari `~/.config/smip/jwt-demo.pem`;
- **workers** — scheduler + dispatch + fetch + pipeline + AI + sink dalam **satu proses** (`scripts/workers-all.ts`, hemat RAM);
- **web** — Caddy: file statis web + reverse proxy `/v1/*` → api + sertifikat HTTPS otomatis.

Buka `https://<SITE_HOST>`. Akses via IP langsung dialihkan ke hostname HTTPS.

Setelah mengubah kode: `bun run web:build` (web) lalu
```bash
docker compose -f infra/compose/docker-compose.yml -f infra/compose/docker-compose.demo.yml --env-file infra/compose/.env.demo restart api workers
```
Hentikan: `bun run demo:down` (data tetap). Matikan semua termasuk database: `bun run dev:down`.

## 7. Login pertama & akun owner

1. Login `admin@contoh.local` + password dari seed.
2. **Owner wajib autentikasi 2 langkah**: pindai QR dengan Google Authenticator / Authy / 1Password, masukkan kode 6 digit.
3. Owner = pemilik platform: **tidak berada di kantor mana pun**. Setelah login Anda diminta *memilih kantor* untuk melihat datanya
   (setiap akses tercatat di audit).
4. Tambah owner lain: menu **Kantor & pengguna → Owner → Tambah owner** (isi password, atau kosongkan untuk mendapat link undangan).

Lupa password owner (akses server):
```bash
bun --env-file=infra/compose/.env.dev scripts/set-password.ts admin@contoh.local --operator   # password baru dicetak sekali; MFA didaftar ulang
```

## 8. Sumber data media sosial

Semua sumber dipilih otomatis oleh router (prioritas + bobot + kesehatan + kuota); tidak ada nama provider di kode bisnis.

**8.1 Daftarkan connector & akun** (sekali):
```bash
set -a; . ~/.config/smip/secrets.env; set +a
E="--env-file=infra/compose/.env.dev"
bun $E scripts/connectors.ts register                                         # manifest → DB (nonaktif)
bun $E scripts/connectors.ts account apify apify-1 APIFY_TOKEN                  # token disegel (Vault), tidak dicetak
bun $E scripts/connectors.ts account youtube_data_api yt-1 YOUTUBE_API_KEY api_key
```

**8.2 Verifikasi** tiap connector yang akan dipakai (menjalankan pencarian sungguhan — **berbayar kecil** untuk Apify):
```bash
Q='"koperasi merah putih" OR kopdes'
for k in apify.x.xquik apify.instagram.hashtag apify.instagram.boolean apify.facebook.scraperone \
         apify.threads.scrapersdelight apify.tiktok.clockworks youtube_data_api.youtube; do
  bun $E scripts/connectors.ts verify $k "$Q" --samples 3 --max-items 10 --window-hours 48 --apply
done
```
Hasil & latensi disimpan di `docs/evidence/verify/`. Hanya connector `verified` yang boleh dipakai routing.

**8.3 Aktifkan routing live + pagar biaya:**
```bash
bun $E scripts/live-routing.ts --dry     # pratinjau
bun $E scripts/live-routing.ts
```
Skrip ini: mengaktifkan connector nyata, menetapkan urutan/bobot per platform, batas biaya per run (`maxTotalChargeUsd` $0,02),
kuota biaya bulanan per connector (**saat ini nonaktif** atas keputusan pemilik 2026-10-01 — `MONTHLY_CAP` di skrip; batas nyata =
batas pemakaian akun Apify), batas $1/run (pengaman run liar), dan maks. 8 run Apify bersamaan. Semua angka di `scripts/live-routing.ts`.
Setelah itu, di menu **Pengaturan → Sumber data** Anda bisa menyalakan/mematikan sumber, melihat status sehat, jumlah run, dan biaya
bulan ini.

Urutan saat ini (2026-10-01):

| Platform | Sumber (urutan) | Catatan |
|---|---|---|
| X | xquik → kaito → scraper_one | xquik murah & paling banyak hasil |
| Instagram | **HikerAPI** (100%) — hashtag terbaru + keyword topsearch; Apify IG nonaktif | daftar akun: `bun $E scripts/connectors.ts account hikerapi hiker-1 HIKERAPI_KEY api_key`; isi saldo di hikerapi.com ($1/1.000 request) |
| TikTok | clockworks → xmolodtsov | clockworks punya filter tanggal |
| Facebook | scraper_one | |
| Threads | scrapersdelight | |
| YouTube | YouTube Data API (gratis, kuota harian Google) → Apify (cadangan, mati) | |

Seberapa banyak data yang didapat terutama ditentukan **anggaran Apify**: plan FREE ($5/bln) cukup untuk 1–2 topik kecil. Untuk
volume seperti produk pembanding (ratusan–ribuan post/minggu per platform) gunakan Apify berbayar dan naikkan kuota di
`live-routing.ts`.

## 9. AI (sentimen & emosi)

Menu **Pengaturan → AI**: pilih provider & model → Simpan. Tambah provider: *Pengaturan lanjutan → Tambah provider AI* (preset
Gemini / OpenAI / OpenRouter / Claude / Custom OpenAI-compatible) lalu tambahkan API key (boleh lebih dari satu — dipakai bergiliran,
otomatis jeda saat kena batas). Tombol **Perbarui daftar model** mengambil katalog model terbaru dari provider.

Lewat terminal (setara):
```bash
set -a; . ~/.config/smip/secrets.env; set +a
LLM_DEFAULT_MODEL=gemini-3.5-flash-lite bun $E scripts/llm-provider.ts gemini gemini "Google Gemini" GEMINI_API_KEY
```
Label ulang data lama setelah ganti model: `bun $E scripts/reprocess-ai.ts` (lihat komentar di skrip).

**Privasi:** Gemini gratis boleh memakai data untuk melatih model Google — pakai tier berbayar sebelum memproses data klien.
Setiap label AI juga disimpan (`nlp_labels`, teks dipseudonimkan) untuk melatih model sendiri nanti.

## 10. Kantor, pengguna, topik — alur pakai

| Peran | Bisa |
|---|---|
| **Owner** (platform) | semua kantor & user, tambah owner, Pengaturan sumber data & AI, masuk ke kantor mana pun (diaudit) |
| **Admin kantor** | kelola user kantornya (tambah dengan password / link undangan, reset password, ubah peran), topik |
| **Analis** | buat & ubah topik, semua halaman data |
| **Pembaca** | hanya melihat dashboard & laporan |

1. Owner: **Kantor & pengguna → Kantor → Tambah kantor**, buka kantornya → **Tambah user** peran *Admin kantor* (isi password, atau
   kosongkan untuk link undangan 72 jam).
2. Admin kantor login → **Pengguna** → tambah analis/pembaca.
3. Analis: **Topik → + Buat topik** — pilih platform, tulis query (`"frasa"`, `OR`, `AND`, `NOT`, kurung), keyword tambahan.
   Setelah disimpan, **data 7 hari terakhir langsung diambil** (antre beberapa menit), lalu diperbarui otomatis (bawaan tiap 1 jam;
   owner dapat mengubah bawaan per paket lewat `plans.limits.default_interval_sec` / `initial_backfill_days`).
4. Dashboard / Percakapan / Kontributor / Audiens: pilih topik, rentang (24 jam / 7 / 30 hari), platform. **Klik bagian chart mana
   pun** untuk melihat post di baliknya; *Jadikan filter* untuk platform/tanggal. *Auto-refresh* hanya memuat ulang tampilan.
5. **Laporan**: ringkasan otomatis + chart + post teratas → *Cetak / Simpan PDF*, atau *Unduh data post (CSV)*.

Kantor saling terisolasi di level database (Row-Level Security) — kantor A tidak bisa melihat topik/data kantor B.

## 11. Operasional harian

| Kebutuhan | Perintah / tempat |
|---|---|
| Update ke versi terbaru | `git pull && bun install && bun run demo:up` (migrasi otomatis) |
| Restart API/worker | `docker compose -f infra/compose/docker-compose.yml -f infra/compose/docker-compose.demo.yml --env-file infra/compose/.env.demo restart api workers` |
| Log | `docker logs -f smip-dev-workers-1` · `docker logs -f smip-dev-api-1` · `docker logs -f smip-dev-web-1` |
| Biaya Apify | Pengaturan → Sumber data (bulan ini) · console.apify.com → Billing |
| Kesehatan data | Pengaturan → Sumber data (status sehat/gangguan, % sukses) |
| Test | `bun test` (butuh infra dev menyala) · `bun run check` |
| Backup cepat (demo) | `docker exec smip-dev-postgres-1 pg_dump -U smip_owner smip \| gzip > smip-$(date +%F).sql.gz` |

Mengosongkan data demo sebelum presentasi: hapus/arsipkan topik lama dari menu Topik lalu buat topik baru (scrape awal otomatis).

## 12. Menuju produksi

Mode demo **bukan produksi**: Vault dev mode, role DB owner, tanpa backup otomatis, satu mesin. Sebelum data klien:
- Profil single-node produksi: `docs/DEPLOYMENT.md` §3a; Kubernetes: §4.
- KMS sungguhan (Vault non-dev / cloud KMS), secret dari secret manager, `CREDENTIAL_PEPPER_B64` baru (jangan pakai nilai `.env.dev`).
- Backup Postgres (PITR) & ClickHouse harian ke object storage di luar server (`docs/DEPLOYMENT.md` §7).
- LLM & Apify berbayar; tinjau `docs/COST_MODEL.md`.
- Memo persetujuan legal (S-15/S-23) diarsipkan di `docs/legal/`.

## 13. Masalah umum

| Gejala | Penyebab & solusi |
|---|---|
| Dashboard kosong setelah buat topik | scrape awal masih antre (maks. 4 run Apify bersamaan) — tunggu 5–15 menit; cek Pengaturan → Sumber data |
| Satu platform selalu 0 | sumbernya kena kuota bulanan / gangguan → lihat status di Sumber data; aktifkan sumber cadangan; cek saldo Apify |
| Semua sumber Apify gagal `FORBIDDEN` / `platform-feature-disabled` | token Apify **di database** milik akun yang kreditnya habis. Mengganti `secrets.env` saja tidak cukup — worker memakai token di DB: `bun $E scripts/connectors.ts rotate apify <label> APIFY_TOKEN` |
| Akun provider "butuh perhatian" | Pengaturan → Sumber data → Akun provider → perbaiki penyebab → **Aktifkan lagi** |
| `NO_ELIGIBLE_ACCOUNT` / run dilewati | kuota biaya bulanan connector habis (disengaja) — naikkan di `live-routing.ts` bila anggaran cukup |
| Login gagal "Kode OTP salah" | jam server/HP tidak sinkron (`timedatectl`), atau reset: `scripts/set-password.ts <email>` |
| Sertifikat HTTPS gagal | port 80/443 tertutup, atau `SITE_HOST` tidak menunjuk ke IP server |
| Server kehabisan RAM | pastikan swap aktif (§2), worker mode satu proses (bawaan), jangan menjalankan test & build bersamaan |
| `docker: permission denied` | user belum masuk grup docker di sesi ini — logout/login atau `sg docker -c "…"` |
