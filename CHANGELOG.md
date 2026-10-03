# Changelog

Format mengikuti [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) dan [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Chaos suite (H-02)** (2026-10-04): `scripts/chaos/run.sh` (Redis antrean restart, ClickHouse mati, worker mati di tengah pengambilan) + invarian (data dobel, DLQ, outbox, run menggantung) — semua lulus di server demo; tes integrasi baru "ClickHouse mati saat sink" (gagal → ulang → tepat sekali, kirim ulang tidak dobel). Laporan `docs/evidence/H-02/`.
- **Backup terjadwal + salinan Google Drive** (2026-10-04): cron tiap 6 jam; `backup.sh` mengenkripsi (gpg AES-256, passphrase di server) lalu mengunggah ke remote rclone `SMIP_BACKUP_REMOTE` (Google Drive, scope `drive.file`) bila sudah dihubungkan pemilik, menghapus salinan > 30 hari; tanpa remote/passphrase → dilewati dengan peringatan (tidak pernah mengunggah tanpa enkripsi). RUNBOOK §15.
- **Load test + cache analitik (H-01)** (2026-10-04): `scripts/loadtest/dashboard.ts` (13 request/halaman, `--cold` untuk skenario cache meleset). Cache respons analitik & feed di Redis per **versi data topik** (`rt:ver:<kantor>:<topik>` naik saat sink mengabarkan data baru atau koreksi sentimen; TTL 5 menit). Di server demo 2 vCPU: 20 pengguna serentak p95 2,9 → 0,07 dtk; 50 pengguna p95 0,32 dtk; skenario terburuk tetap memenuhi target s.d. 10 pengguna. Laporan `docs/evidence/H-01/`.
- **Dokumentasi final (H-07)** (2026-10-04): `docs/ONBOARDING_CONNECTOR.md` (langkah menambah provider/actor), indeks RUNBOOK, bagian operasional INSTALL (backup terjadwal, monitoring, retensi, paket), README status & navigasi.
- **Monitoring (O-07)** (2026-10-04): scheduler mengekspor metrik state sistem tiap 60 dtk (run 1 jam per platform & status, umur sukses terakhir per platform, skor & circuit connector, status akun provider, capability failed yang masih di routing, alert terbuka, outbox tertunda); API mengekspor `smip_http_requests_total` / `smip_http_request_duration_seconds` (route berpola) + `smip_sse_connections` di port internal 9465. `infra/compose/monitoring/`: Prometheus + 13 aturan alert (ada unit test `promtool`) + Alertmanager → Telegram + 2 dashboard Grafana, tervalidasi `promtool`/`amtool`. OBSERVABILITY §9, RUNBOOK §16.
- **Pemindaian keamanan (H-03)** (2026-10-04): `scripts/secret-scan.ts` (pola token Apify/GitHub/Google/Anthropic/OpenAI/AWS/Slack/Telegram/private key/URL berkredensial; `--history` untuk seluruh riwayat git) — bersih, kini bagian `bun run check` (CI). `bun audit`: 1 moderate dev-only. Laporan `docs/evidence/H-03/`.
- **Backup & restore (H-06)** (2026-10-04): `scripts/backup.sh` (Postgres pg_dump + tabel dasar ClickHouse Native, checksum, rotasi 7, tanpa secret) dan `scripts/restore.sh` (ke database baru, migrasi + rebuild agregat lewat MV, verifikasi jumlah baris, menolak menimpa database aktif). DR drill di server demo: 5 dtk, semua baris & agregat identik (`docs/evidence/H-06/`). RUNBOOK §15.
- **Retensi data & hapus kantor (H-04)** (2026-10-04): job harian di worker-sink menghapus data kantor yang melewati `retention_days` paket (bawaan 365 hari) di semua tabel ClickHouse ber-tenant, post yang tidak cocok topik mana pun setelah 30 hari, post yang tak lagi dipakai setelah 400 hari, serta outbox/ledger dedup lama (semua angka `retention.*` di Pengaturan). `scripts/tenant-purge.ts <slug> --confirm <slug>`: hapus total kantor berstatus `closed` (ClickHouse + crypto-shred credential + cascade Postgres). RUNBOOK §14.
- **Routing (O-01/O-02)** (2026-10-04): Pengaturan → **Routing** — atur urutan (utama/cadangan), bobot, aktif/nonaktif sumber per platform & operasi, tambah/lepas sumber cadangan, saklar "pindah ke cadangan bila gagal" (`PUT /admin/routing-policies/{id}` dengan If-Match). **Simulator**: pilih kantor, platform, jenis pengambilan & jadwal → sumber yang akan dipakai + alasan tiap sumber tersisih dalam bahasa awam (mis. "tidak ada API key yang siap — saldo habis").
- **Update instan / SSE (D-03)** (2026-10-04): dashboard tersambung "● live" — begitu post baru selesai diproses, widget topik dimuat ulang otomatis (tanpa menunggu auto-refresh); alert baru langsung menambah badge menu. worker-sink meneruskan `realtime.notify` & alert ke Redis pub/sub `smip:rt` → tiap replika API → `GET /v1/stream?topic_id` (SSE). Autentikasi: `POST /v1/stream/ticket` (Bearer) → cookie `sse_ticket` HttpOnly/Secure/SameSite=Strict/`Path=/v1/stream`, 15 menit, terikat user+kantor+topik, hanya hash di Redis — token tidak pernah di URL (SEC-10/SEC-11). Heartbeat 25 dtk, idle timeout Bun dimatikan khusus SSE. Antrean `realtime.notify` yang sebelumnya tidak punya consumer kini dikonsumsi.
- **Monitor owner (O-04)** (2026-10-04): Pengaturan → **Monitor** — kesehatan pengambilan per platform (persen berhasil, gagal, sebagian, dilewati, berjalan, post baru, terakhir berhasil), kegagalan terbaru, antrean gagal (DLQ: kirim ulang / buang), pemakaian & perkiraan biaya per kantor, audit log (nama aktor & kantor, filter, sembunyikan akses lihat kantor). `GET /admin/crawl-monitor?hours=`; `/admin/usage?group_by=tenant` kini memuat `tenant_name`; `/admin/audit-logs` memuat `actor_name`/`tenant_name` + `exclude_action`.

- **Galeri (U-04/D-04)** (2026-10-04): tab **Galeri** di Percakapan — kisi foto/video dari post topik (filter Foto/Video, sentimen, urut engagement/terbaru, muat lebih banyak), klik → detail (media, teks, sentimen, engagement, tautan post asli). `GET /analytics/gallery` (filter sama dengan feed + `media_type`; hanya URL https; maks. 4 media/post). Gambar CDN dimuat dengan `referrerPolicy=no-referrer`; URL kedaluwarsa jatuh ke kartu teks.
- **Export Excel/CSV (O-06)** (2026-10-04): tombol **⬇ Unduh data** di bar filter dashboard dan **⬇ Unduh** di popup drill-down — post sesuai filter yang sedang dipakai (rentang, platform, + sentimen/isu/hashtag/akun dari widget yang diklik) sebagai Excel (.xlsx) atau CSV. Kolom: waktu WIB, platform, jenis, akun, nama, pengikut, teks, URL, suka/komentar/bagikan/tayang (snapshot terakhir), engagement, sentimen, emosi, isu, hashtag. Maks. 50.000 post terbaru. Penulis XLSX/ZIP sendiri (tanpa dependency baru), CSV dengan BOM (Excel) dan netralisasi formula (`=`/`+`/`-`/`@`). `GET /exports/posts?topic_id&from&to&…&format=xlsx|csv` (analis+, scope `exports:write`), dicatat di tabel `exports` + audit.
- **Alert (O-05)** (2026-10-04): menu **Alert** — aturan per topik (sentimen negatif ≥ X% dalam N jam, lonjakan percakapan ≥ X× rata-rata 7 hari, isu baru yang belum muncul 7 hari), dicek tiap 5 menit oleh worker-sink (agregat ClickHouse, lock tunggal, cooldown per aturan); riwayat alert (baru → dibaca → selesai) + badge di menu; saluran kantor **Telegram** (token bot disegel KMS, tidak pernah ditampilkan) dan **webhook** (HTTPS publik, guard SSRF, tanda tangan HMAC `X-SMIP-Signature` atas `timestamp.body`), tombol kirim uji, hasil kirim tercatat per event. API `/alert-rules`, `/alert-events` (+ack/resolve), `/notification-channels` (+test). Paket baru `@smip/notify`. Email menyusul (butuh SMTP).
- **Paket per kantor + penghemat otomatis** (2026-10-04): paket Hemat 3j / Standar 1j / Plus 30m / Cepat 15m / Real-time 5m disimpan di `plans` (migrasi 0029, `limits.platform_intervals`) dan **dipilih per kantor** di menu Kantor (`GET /admin/plans`, `PATCH /admin/tenants/{id}` `plan_code` → jadwal semua topik kantor ikut seketika). Urutan jadwal: interval eksplisit topik (API) → paket kantor → jadwal bawaan owner → bawaan topik. **Jadwal adaptif**: 2+ pengambilan berturut-turut tanpa post baru → jeda ×2 tiap run kosong (maks. 3 jam), kembali normal begitu ada post baru (plan & collection stream). **Mode malam**: 00–06 WIB paling cepat tiap 3 jam, pagi langsung normal. Saklar + lantai post per pengambilan di Pengaturan → Batas & jadwal (`schedule.*`). Tombol "Ambil sekarang" dihapus dari dashboard (API tetap ada).
- **Auto-refresh kembali + Off = jeda topik** (2026-10-03, keputusan pemilik setelah perbandingan biaya COST_MODEL §12.6): dropdown ⏱ Auto-refresh (5m/15m/30m/1j) memuat ulang layar (gratis); **Off menjeda topik di server** untuk semua pengguna (tanpa biaya), memilih interval melanjutkannya. Jadwal pengambilan kembali diatur owner untuk semua topik (Pengaturan → Batas & jadwal; paket baru Hemat 3j / Standar 1j / Plus 30m / Cepat 15m / Real-time 5m dengan biaya terhitung ulang). Tetap ada: **Ambil sekarang** (`POST /topics/{id}/fetch-now`, analis+, jeda 5 menit) dan "Terakhir diambil …" (`last_run_at` di daftar topik). Kontrol "Update data" per topik (`PUT /topics/{id}/speed`) dicabut. Diuji integrasi + Playwright (analis vs viewer).
- **Facebook lebih murah + API mahal dimatikan** (2026-10-03 malam): connector `apify.facebook.silentflow` (VERIFIED 20 post; tagihan nyata ± $0,0023/post, −42% vs scraper_one; `recent_posts` → terurut terbaru → maxItems adaptif) jadi satu-satunya sumber FB. Dimatikan: Apify YouTube `streamers`, Threads `scrapersdelight`, X `scraper_one`, FB `scraper_one` & `scrapeforge` (verify gagal). CaptAPI dievaluasi: ± $0,009/request (9× HikerAPI/LamaTok), tanpa pencarian post FB → tidak dipakai (COST_MODEL §12.5).
- **Psikografi (A-08/A-09, D-04, U-06)**: gender & rentang usia **per akun** diperkirakan LLM dari sinyal minimal (nama tampilan, username, tahun akun — AI_SPEC §12.3) → cache global ClickHouse `author_demographics` (tidak ditanya ulang) → ambang τ (gender 0,75, usia 0,65) → `unknown` bila ragu; **below_18 tidak pernah disimpan per akun** (`minor_suppressed`, ADR-007). `GET /analytics/psychography` (proporsi + sentimen per kelompok + coverage, unknown tetap dihitung); halaman Audiens: komposisi gender, rentang usia, sentimen per gender/usia. Hanya agregat, tidak pernah per akun/post (SEC-09). Saklar di Pengaturan (`demographics.enabled`). Probe live 40 akun: gender terdeteksi 27%, usia 0% (nama jarang memberi petunjuk usia — sengaja tidak menebak). Berlaku untuk post baru.
- **Threads lebih murah** (2026-10-03): connector `apify.threads.themineworks` (VERIFIED, terurut terbaru → maxItems adaptif) jadi sumber utama; Real-time semua 5 menit ±Rp 56 jt/kantor (dulu Rp 221 jt). Lantai post per pengambilan diatur di Pengaturan (`fetch.min_items_per_run`). Evaluasi provider per-request Threads (ScrapeCreators, CaptAPI) & Facebook di COST_MODEL §12.4.
- **Batas & jadwal disederhanakan**: penjelasan "kecepatan update vs auto-refresh", 4 paket (Hemat/Standar/Plus/Real-time) dengan perkiraan biaya per kantor, komentar & scrape awal cukup satu angka; detail teknis di "Pengaturan lanjutan".
- **Komentar** (2026-10-03): planner (worker-sink, tiap 15 menit) memilih post **engagement tertinggi** tiap topik/platform → run `comments` (migrasi 0026) milik plan topik → `post_comments` → komentar ditautkan ke topik induk **tanpa cocok keyword** → sentimen/emosi/isu seperti post. Hanya platform dengan connector komentar VERIFIED; run gagal tidak memakan anggaran & tidak menggeser jadwal topik. **YouTube** `commentThreads.list` (VERIFIED live: 100 komentar, gratis, 1 unit kuota; komentar dimatikan → video dilewati) — live: 453 komentar dari 1 run, 193 berlabel dalam menit pertama. TikTok (LamaTok) siap setelah saldo diisi + verify. Kuota harian YouTube 270 → 400 request.
- **Pengaturan → Batas & jadwal** (owner): jadwal pengambilan per platform (5 menit–24 jam; berlaku ke semua topik, migrasi 0025/0028 — interval tak lagi dipilih per topik), maks. post per pengambilan (≤ 10.000), scrape awal topik (hari), komentar (aktif, post teratas/hari, halaman/post, ambil ulang, umur post), batas tiap sumber (semua angka/boolean di config connector: hashtag/keyword/halaman HikerAPI & LamaTok, biaya per run Apify, …), run bersamaan per akun. API `GET/PUT /admin/settings` (tabel `system_settings`), `PATCH /admin/platforms/{code}` + `crawl_interval_sec`, `config_fields` di daftar connector.
- Uji live collection stream (ADR-009): 2 kantor dengan query sama → 1 stream X melayani keduanya; kantor uji dibersihkan.
- COST_MODEL §12 ditulis ulang lengkap: provider aktif per platform (IG HikerAPI, TikTok LamaTok, X/Threads/FB Apify, YouTube resmi), komentar, AI, infra, harga 1–3 kantor.
- **Kelola API key provider dari Pengaturan → Sumber data → Akun provider** (2026-10-03): ganti key (credential lama di-crypto-shred, akun bermasalah aktif lagi), matikan/aktifkan, hapus, **tambah akun** (key kedua dipakai bergiliran) untuk Apify / HikerAPI / LamaTok / YouTube — tanpa terminal. Memakai Admin API I-21 yang sudah ada (`/admin/accounts`, `PUT …/credential`); field secret per provider (`api_token` Apify, `api_key` lainnya). Diuji Playwright (request benar, tanpa error).
- **Menu Akun — pantau akun** (pejabat/media/influencer): topik `kind=account` (migrasi 0024) berisi `@username` per platform →
  operation `user_timeline` (TikTok LamaTok, Instagram HikerAPI, X xquik `from:`; semua VERIFIED live) → semua analitik (sentimen,
  emosi, isu, laporan) berlaku. Parser: `@username` = term penulis (matcher mencocokkan penulis, bukan teks). `GET /platforms` kini
  memuat `operations_available` (policy + connector verified). Backfill akun = 1 run per akun untuk seluruh rentang. Contoh: "Pantau:
  Jokowi" (IG 11, TikTok 6, X 1 post / 7 hari). Dashboard: pemilih topik dikelompokkan Topik / Pantau akun.
- verify: `--op user_timeline` (query = username dipisah koma), bukti per operation `verify-<key>.<op>.json`.
- **TikTok via LamaTok** (`packages/connectors/lamatok`, `lamatok.tiktok`, VERIFIED live: 42 video, semua field 100%, p50 2,7 s) —
  keyword `/v2/search` (±30 video/request), plus `user_timeline` (pantau akun) & `post_comments` (komentar) siap pakai; jadi
  **satu-satunya** sumber TikTok (Apify TikTok dinonaktifkan). Backfill KDMP 1 hari: 37 video / 3 request = $0,003.
- **Instagram via HikerAPI** (`packages/connectors/hikerapi`, `hikerapi.instagram`, VERIFIED live 2026-10-01: 64 post, p50 8,2 s) —
  hashtag terbaru (halaman berhenti di window → tanpa tagihan berulang) + keyword `/gql/topsearch`; jadi **satu-satunya** sumber Instagram
  (Apify IG dinonaktifkan, keputusan pemilik). Backfill JOKOWI 1 hari: 102 post / 6 request = $0,006. Risk `high` (API privat IG).
  verify: cek window hanya untuk connector yang mengklaim `supportsSince` (CONNECTOR_SPEC §9).
- Word cloud isu 3D diganti **tag cloud pill** sederhana (4 ukuran menurut peringkat, angka di pill, klik → post).
- **maxItems adaptif** (COST_MODEL §11.2): manifest `sinceGranularity: "day"` untuk actor yang filter waktunya per hari; untuk yang
  terurut terbaru dulu (TikTok clockworks, FB/X scraper_one, YouTube streamers) run incremental meminta ± 3× post baru yang
  diharapkan (min. 5, naik 4× saat saturasi) — memangkas tagihan berulang tiap poll. Actor tak terurut tidak dipotong.
- COST_MODEL §11: biaya terukur per actor, skenario 10 topik (5m vs paket), usulan harga Standar/Standar+/Plus.
- **Laporan → Unduh PDF langsung** (tanpa dialog cetak; pratinjau tetap): `apps/web/src/pdf.ts` — html-to-image + jspdf (compat `web-pdf`
  COMPATIBLE, ADR-001), A4 berhalaman dipotong di batas section/baris tabel, nomor halaman; diuji di Chromium headless (PDF valid
  4 halaman). Laporan kini juga memuat **sorotan sentimen positif & netral**.
- **Word cloud isu 3D** (bola kata berputar, drag untuk memutar, klik → post) di Dashboard & Percakapan; tanpa paket tambahan.
- **Batas biaya bulanan per provider & per sumber** di Pengaturan (kosong = tanpa batas; pemakaian bulan ini ditampilkan) — memakai
  `quota_policies` (hard, cost_units) lewat `/admin/quotas`; tercapai → sumber dilewati, router pindah ke cadangan.
- **Koreksi sentimen manual (A-05, P-06):** analis/admin klik label sentimen di kartu post → pilih label baru → `PATCH
  /posts/{platform}/{post_id}/sentiment` → pasangan −1/+1 (`model_version=human`) + `sentiment_overrides` (dataset training) + audit;
  semua chart ikut berubah; label manual ditandai ✓ dan **tidak ditimpa** reprocess AI.
- **Percakapan → tab *Isu*** (U-04, meniru Issues/Issue Comparison produk referensi): donut isu teratas, perbandingan isu periode
  terpilih vs periode sebelumnya (perubahan % + penanda *baru*), word cloud isu sentimen positif/negatif; tab *Sentimen* kini juga
  menampilkan word cloud isu per sentimen. Semua bisa diklik → post.
- **Batas post per pengambilan per platform** (Pengaturan → Sumber data; migrasi 0023 `platforms.max_items_per_run`,
  `GET/PATCH /admin/platforms`, dipakai worker-dispatch; kosong = bawaan 300) — mis. membatasi YouTube yang terlalu banyak.
- **Isu (kata/kalimat) seperti panel ISSUES produk referensi** (A-04 jalur LLM): LLM mengekstrak 0–3 frasa isu per post dalam panggilan
  batch yang sama → `GET /analytics/issues` → word cloud *Isu* & *Isu berdasarkan engagement* di Dashboard (klik → post), daftar isu
  di Laporan. Footer Laporan tanpa penyebutan model AI. Auto-refresh otomatis Off & terkunci bila topik dijeda di menu Topik.
- Pagar biaya bulanan Apify **dinonaktifkan** (keputusan pemilik; `MONTHLY_CAP` di `scripts/live-routing.ts`), batas $1/run, 8 run bersamaan.
- **Sesi 2026-09-30 (lanjutan) — owner platform, password, laporan, scrape awal, sumber data IG/TikTok, perbaikan antrean:**
  - **Owner platform** di luar kantor (migrasi 0022: tenant internal `kind='platform'`; login owner masuk ke sana; halaman data meminta *pilih kantor*); `GET/POST/DELETE /admin/owners`, `GET /admin/users` (semua user + kantor), halaman *Kantor & pengguna* bertab Kantor / Semua pengguna / Owner.
  - **Password oleh admin:** isi password saat membuat user (langsung aktif) atau link undangan; **reset password** (`POST /users/{id}/password`, `POST /admin/users/{id}/password`) langsung / link reset sekali pakai; ditolak untuk user yang juga anggota kantor lain; sesi lama dicabut; diaudit.
  - **Scrape awal otomatis:** topik baru (dan platform yang baru dicentang) langsung di-backfill 7 hari (`plans.limits.initial_backfill_days`); "Hitung estimasi" dihapus dari form.
  - **Laporan** (`/report`): ringkasan naratif otomatis, chart, hashtag/akun/lokasi teratas, post teramai & sorotan negatif → Cetak/Simpan PDF (CSS print A4) + unduh CSV post.
  - Filter analitik (topik/rentang/platform) diingat antar halaman (localStorage + URL).
  - Connector **`apify.instagram.hashtag`** (Apify resmi, VERIFIED) — query → hashtag; routing IG hashtag 70% / boolean 30%; TikTok clockworks jadi utama.
  - `docs/INSTALL.md` — panduan instalasi & konfigurasi lengkap dari server kosong.
- **Sesi 2026-09-30 — UI disederhanakan + analitik ala produk referensi (drill-down):**
  - **Klik diagram → post** (drill-down) di semua chart: popup berisi post di balik angka (urut terbaru / engagement tertinggi, "muat lebih banyak", jumlah total) + **"Jadikan filter"** untuk platform/rentang waktu. Feed `/posts` menerima `hashtag`, `issue`, `author_id`, `region`, `content_type` (termasuk kelompok `replies`/`reposts`), `sort`, `count=1` → `meta.total`.
  - Endpoint analitik baru (dari agregat): `emotion/timeline`, `accounts/active`, `accounts/reposted`, `platforms` (post/balasan/repost per platform), `activity` (heatmap hari×jam WIB), `accounts/created-year`; `exposure?mode=engagement`; `accounts/top?by=replies|reposts&sentiment=`.
  - Web: filter global (topik, rentang, **platform**, auto-refresh) terbawa antar halaman; halaman **Percakapan** (Kronologi / Sentimen / Emosi / Engagement), **Kontributor**, **Audiens**; Dashboard ditulis ulang.
  - **Kantor & pengguna** jadi satu halaman (administrator: semua kantor + user-nya, `GET /admin/tenants/{id}/users`; admin kantor: user kantornya); peran disederhanakan jadi Admin kantor / Analis / Pembaca.
  - **Pengaturan** (hanya administrator) = tab *Sumber data* (per platform, saklar aktif, status sehat, run & biaya bulan ini; sumber uji disembunyikan) + tab *AI* (satu pilihan provider+model untuk semua tugas, API key, tes; per-tugas/cadangan di "lanjutan").
  - Topik: riwayat crawling & interval dihapus dari UI; interval crawl ditentukan sistem (`plans.limits.default_interval_sec`, bawaan 1 jam); interval topik lama dipertahankan saat diubah.
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
  - Engagement refresh (I-20): planner → run `engagement_refresh` → `post_detail` → sink koreksi sign −1/+1 (P-08, P-21); migrasi 0020, env `ENGAGEMENT_REFRESH_*`.
  - worker-fetch-py (I-16): SDK connector Python, kripto envelope interop, session lock, worker BullMQ `fetch.py`, contract suite pytest, interop TS↔Python; CI menjalankan pytest.
  - Connector unofficial `instagrapi.instagram` (I-19, standby/disabled) + review keamanan; opt-out provider berisiko tinggi per tenant di router (`TENANT_RISK_OPT_OUT`).
  - Fase 0: S-05 diputuskan (KEDA Prometheus scaler atas `smip_queue_depth`, scheduler `/metrics`; scaler Redis list ditolak — bukti test), S-12 cek Graph API/Content Library, S-14 YouTube streamers 5 sampel.
  - Review 2026-09-30: health override per connector dipakai router, rate limit worker Python → `rl:dyn`, reaper melepas celah & mengalokasikan biaya stream, fingerprint credential seragam & tanpa oracle lintas tenant, refresh tidak mengulang post yang hilang, konsumen `health.probe`/`connector.verify` (+ `verify.ts` bersama). Legal S-15/S-23 dicatat disetujui pimpinan.
  - Sisa risiko review ditutup (Vault Python async, probe connector Python, quota YouTube dev, planner refresh terbatas). Profil VPS kecil: ClickHouse hemat memori + semua worker Bun 1 proses (454 → 92 MB), perintah swap.
  - S-05 demo KEDA di kind (Prometheus scaler atas `smip_queue_depth`: 0 → 4 → 0 replika; scaler Redis list terbukti buta terhadap job ber-priority).
  - Web dashboard awal (`apps/web`: login+MFA, dashboard ingest, topik, admin provider) + profil demo publik HTTPS (`bun run demo:up`, Caddy + Let's Encrypt di sslip.io); `scripts/set-password.ts`; `API_TRUST_PROXY`.
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
- ClickHouse demo menabrak batas memori 500 MB setelah restart karena tabel log sistem lama (± 300 MB) di-merge ulang → dikosongkan; prosedur di RUNBOOK §7.
- **Facebook tidak terambil ±14 jam (2026-10-03 11:31 → 10-04 01:20 UTC):** routing pindah ke `apify.facebook.silentflow` sebelum worker memuat kodenya → worker lama melapor `NOT_SUPPORTED` → capability ditandai `failed` permanen (`NO_CANDIDATE`). Ditemukan lewat Monitor baru. Capability dipulihkan (bukti verify sah), plan FB dijadwalkan ulang (run berhasil lagi). Pencegahan: connector yang belum dimuat worker kini dilaporkan `NETWORK` sementara (retry, capability tidak dimatikan); urutan deploy di RUNBOOK §13.
- Interval di DB hanya boleh 5/15/30/45/60 menit → pilihan jadwal lain di Pengaturan akan gagal; kini 1 menit–24 jam (0028). `system_settings` tanpa GRANT ke `smip_system` (0027).
- YouTube: request yang ditolak tetap memakai kuota tetapi tidak dihitung; 403 `commentsDisabled` dulu akan menandai akun "butuh perhatian".
- Halaman *Pengaturan* (status sumber data, saldo provider, key) kini dijaga **khusus owner platform** juga di sisi web — admin/user kantor (klien) yang membuka `/settings` langsung dialihkan ke dashboard (sebelumnya hanya menu yang disembunyikan). COST_MODEL §12: hitung ulang biaya & harga dengan HikerAPI/LamaTok.
- **Saldo provider habis tidak terlihat** (audit live 2026-10-02): HikerAPI & LamaTok saldo **$0** (HTTP 402) sejak 01-10 ±12:30 UTC → Instagram & TikTok 0 post, 77 percobaan gagal, akun tetap "aktif" di UI (hanya throttle Redis). `QUOTA_EXHAUSTED` ber-scope akun kini juga menulis **jeda sementara + alasan ke DB** (tampil di Pengaturan: "saldo/kuota di provider habis — isi ulang") + alert; sweeper mencoba lagi tiap jam.
- HikerAPI: jumlah hashtag per run tak terbatas (tiap hashtag ≤ 10 halaman berbayar) → maks. 8 (`maxHashtags`) + peringatan; post tanpa `taken_at` membuat paging tak berhenti di window (NaN) → diabaikan.
- UI: label pie terpotong ("Po…"); status topik/akun berbahasa Inggris; "Sorotan netral" di Laporan mengulang "Post paling ramai".
- Panel *Isu* kosong di demo: container API belum di-restart setelah endpoint baru; word cloud kini menampilkan error/memuat, bukan kotak kosong.
- **Query `or/and/not` huruf kecil dibaca sebagai kata biasa** → `jokowi or jkw` = `jokowi AND or AND jkw` → data terambil tapi 0 post
  cocok (topik BPIP & JOKOWI). Operator kini tidak peka huruf (ADR-008 amandemen); `scripts/reparse-queries.ts` mem-parse ulang query lama.
- **Satu HTTP 403 dari satu actor Apify mematikan SEMUA platform Apify** (akun `needs_attention` permanen, tanpa alert, UI tetap
  "sehat" — topik baru mis. BPIP gagal `NO_CANDIDATE` terus). 403 Apify kini ber-scope `connector` → hanya actor itu dijeda 1 jam,
  akun tetap dipakai actor lain; FORBIDDEN tingkat akun kini memicu alert. Pengaturan → Sumber data menampilkan **Akun provider**
  (status + alasan + tombol *Aktifkan lagi*) dan connector ber-akun bermasalah tidak lagi tampil "sehat".
- **Instagram keyword tidak pernah membawa post baru** (routing IG 70% hashtag / 30% keyword; run keyword hampir selalu 0 post).
  Probe live 2026-10-01: pencarian keyword IG (scraping_solutions & crawlerbros) diurutkan relevansi — 0 post ≤ 7 hari — sedangkan
  cabang `#hashtag` (feed recent) membawa post baru. Connector `apify.instagram.boolean` kini menambah hashtag turunan tiap term
  dalam run yang sama (`withHashtags`, ≤ 32 cabang); routing IG = boolean 100%, actor hashtag resmi = cadangan prioritas 2.
  Kuota biaya bulanan per connector disesuaikan ke plan Apify STARTER (Σ ≈ $8,1; `scripts/live-routing.ts`).
- Skrip operator: `scripts/connectors.ts rotate <provider> <label> <ENV>` (ganti token akun, lama di-crypto-shred) dan
  `scripts/backfill.ts "<topik>" [hari] [platform,…]`. Penyebab insiden: token Apify di DB masih milik akun lama (kredit habis).
- **Auto-refresh dashboard kini per topik** (sebelumnya satu nilai global: "Off" di satu topik ikut ke semua topik).
- **Keamanan:** port Postgres/Redis/ClickHouse/S3/Vault compose ter-publish ke `0.0.0.0` (Docker melewati ufw) → diikat `127.0.0.1`; secret tersegel dipindah ke Vault baru tanpa kehilangan (DEK dibungkus ulang).
- **Deadlock dispatch:** router memuat snapshot/seed quota lewat pool DB yang sama dengan transaksi dispatch → semua koneksi habis → job mati "timeout 10000 ms" (45 run backfill hilang). Router kini punya pool sendiri.
- **Reaper** menggagalkan run `queued` yang job-nya hilang tanpa pernah mencoba → kini diantrekan ulang (maks. 4×) sebelum STUCK_RUN.
- Semaphore concurrency penuh → tunggu sampai lease habis (±10 menit) → kini cek ulang ≤ 20 s + jitter (backfill 45 run: ±2 jam → ±4 menit).
- Actor tanpa filter tanggal: post di luar potongan window run dibuang padahal sudah dibayar (IG hashtag 70 → 14, Threads 65 → 4) → disimpan bila ≤ 30 hari.
- Matcher: frasa kini cocok dengan hashtag gabungannya (`"koperasi merah putih"` ↔ `#KoperasiMerahPutih`); teks < 3 kata tidak ditolak karena deteksi bahasa (TikTok "Kopdes" → `da`).
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
