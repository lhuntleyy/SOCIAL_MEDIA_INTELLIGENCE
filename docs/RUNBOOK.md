# RUNBOOK

Setiap bagian: **Gejala → Diagnosis → Tindakan → Verifikasi**.

## 1. Provider circuit open (`ProviderCircuitOpen`)
- **Diagnosis**: Admin → Providers → lihat `last_error_code`; Grafana "Provider Health"; trace attempt terakhir.
- **Tindakan**:
  - `RATE_LIMITED`: normal, tunggu; jika terus-menerus → turunkan rate policy / kurangi weight / tambah account.
  - `AUTH_INVALID`/`FORBIDDEN`: rotasi credential (`PUT /admin/accounts/{id}/credential`).
  - `PARSE_ERROR`: schema drift → disable rule connector, buka issue, update normalizer + fixture baru.
  - `UPSTREAM_5XX`/`TIMEOUT`: cek status page provider; biarkan failover bekerja.
- **Verifikasi**: circuit kembali `closed`; `smip_router_failovers_total` turun.

## 2. Tidak ada provider sehat untuk suatu platform (`PlatformNoHealthyProvider`)
- Pastikan failover tidak diblok oleh quota (`QuotaNearLimit`), capability, atau rule disabled (gunakan **Routing Simulator**).
- Opsi: aktifkan connector standby (weight > 0), naikkan interval sementara (topik prioritas saja), komunikasikan ke tenant (banner status).

## 3. Account `CHALLENGE_REQUIRED` (unofficial)
- Jangan retry otomatis. Tandai `needs_attention` (otomatis).
- Pemilik akun menyelesaikan verifikasi secara manual sesuai prosedur resmi platform, lalu upload session baru / reset status.
- Jika berulang → pertimbangkan menonaktifkan connector tsb.

## 4. Quota hampir/sudah habis
- Admin → Usage: identifikasi tenant/topik terbesar.
- Tindakan: naikkan quota (jika budget disetujui), turunkan interval topik non-prioritas, atau alihkan ke provider lain.

## 5. Backlog queue (`QueueBacklog`)
- Cek queue mana: `fetch.*` (provider lambat), `ai.enrich` (AI worker kurang), `sink.analytics` (ClickHouse).
- Scale KEDA max; cek error rate consumer; aktifkan backpressure lebih agresif (turunkan batas backfill).

## 6. DLQ bertambah
- Admin → DLQ: kelompokkan per error. Perbaiki akar masalah → **redrive**. Poison (schema invalid) → discard + catat.

## 7. ClickHouse insert gagal
- Cek disk, jumlah parts ("too many parts"), koneksi. Sink akan retry (10 attempts). Jika lama → scale down fetch sementara agar tidak menumpuk data di S3 batch.

## 8. DR Drill (kuartalan)
1. Restore Postgres PITR ke instance baru; jalankan smoke.
2. Restore ClickHouse dari backup; bandingkan count agregat sampel.
3. Simulasi kehilangan Redis: flush di staging → scheduler membuat ulang run; verifikasi tidak ada duplikasi (dedupe).
4. Catat RTO/RPO aktual.

## 9. Rotasi kunci
- JWT: tambah `kid` baru → deploy → tunggu masa berlaku token lama habis → hapus kunci lama.
- KEK: buat versi baru di KMS → job `rewrap` → verifikasi → nonaktifkan versi lama.
- DB/Redis password: rotasi via secret manager + rolling restart.

## 10. Kill-switch provider (insiden legal/ToS)
`PATCH /admin/providers/{id} {"enabled": false}` → efektif ≤ 30 s. Opsional: revoke semua account provider tsb. Catat alasan di audit.

## 11. Plan "beku" / run mandek (`STUCK_RUN`)
- **Gejala**: sebuah crawl_plan berhenti menghasilkan data walau `status='active'`; `smip_crawl_coalesced_total` naik tanpa run baru selesai.
- **Diagnosis**: `crawl_plans.inflight_run_id` menunjuk run yang masih non-final jauh melewati `scheduled_for`; cek log worker fetch (mungkin OOM/crash).
- **Tindakan**: job `crawl.reaper` (60 s) otomatis reset. Bila reaper mati: jalankan manual, atau `UPDATE crawl_runs SET status='failed', error_code='STUCK_RUN' WHERE …` lalu `UPDATE crawl_plans SET inflight_run_id=NULL WHERE id=…` (compare-and-set).
- **Verifikasi**: run baru muncul pada tick berikutnya; dedupe mencegah duplikasi window yang tumpang tindih.

## 12a. Celah data dari run partial (`smip_crawl_gap_windows` naik)
- **Diagnosis**: run `partial` beruntun pada satu connector (lihat `error_code` halaman gagal); celah menumpuk di `crawl_plans.gap_windows`.
- **Tindakan**: perbaiki penyebab (rate limit → turunkan halaman/run; PARSE_ERROR → schema drift); celah diambil ulang otomatis. Celah yang melewati `max_gap_age` tercatat `smip_crawl_gap_abandoned_total` — laporkan ke tenant bila signifikan (data tidak lengkap untuk rentang itu).
- **Jangan** memajukan `high_watermark` manual untuk "membersihkan" celah.

## 12. Coverage psychography/emotion turun drastis
- **Gejala**: `coverage_pct` gender/age/emotion anjlok.
- **Diagnosis**: provider berhenti mengirim sinyal (mis. `author.created_at`/nama profil null), model demografi gagal load, atau τ terlalu tinggi.
- **Tindakan**: cek `smip_ai_low_confidence_ratio` & health model; jangan menurunkan τ demi coverage tanpa eval (bias). Tampilkan coverage apa adanya (SECURITY §9).

## 13. Connector baru: urutan deploy & capability "failed" palsu (insiden 2026-10-03)
**Gejala:** platform tidak terambil, Pengaturan → Monitor menunjukkan `NO_CANDIDATE` "tidak ada connector yang layak"; router
trace `CAPABILITY_FAILED` untuk connector yang baru diverifikasi.
**Penyebab (insiden FB ±14 jam):** routing dipindah ke connector baru (`scripts/live-routing.ts`) SEBELUM worker di-restart memuat
kodenya → worker lama melapor `NOT_SUPPORTED` → `markCapabilityFailed` permanen. Sejak 2026-10-04 worker melapor connector yang
belum dimuat sebagai `NETWORK` sementara (tidak mematikan capability).
**Urutan benar:** (1) deploy kode + restart `workers`, (2) `connectors.ts register/verify`, (3) baru `live-routing.ts`.
**Pemulihan:** cek bukti `docs/evidence/verify/verify-<key>.json` masih `verified` → set `connector_capabilities.status = 'verified'`
+ outbox `capability.verified` + audit `capability.restore`, lalu jadwalkan ulang plan platform itu (`next_run_at = now()`); atau
jalankan ulang verify bila ragu.

## 14. Retensi data & hapus total kantor (H-04)
- **Otomatis** (worker-sink, maks. 1×/24 jam, lock Redis `lock:retention`, penanda `retention:last`): data kantor lebih tua dari
  `retention_days` paket (bawaan `retention.default_tenant_days` = 365, min 30) di semua tabel ClickHouse ber-tenant; post global
  tak-match > `retention.unmatched_posts_days` (30); post global yang tak lagi dipakai topik mana pun > `retention.global_posts_days`
  (400); outbox terkirim & ledger dedup > `retention.ops_days` (30). Log: `retensi dijalankan`. Penghapusan ClickHouse = mutation
  asinkron (`system.mutations`).
- **Hapus total kantor** (akhir kontrak / permintaan UU PDP): tutup kantor dulu (status `closed`), lalu
  `bun --env-file=infra/compose/.env.dev scripts/tenant-purge.ts <slug> --confirm <slug>` → semua data ClickHouse kantor itu
  dihapus (sinkron), credential di-crypto-shred, baris kantor dihapus (cascade Postgres). **Tidak bisa dibatalkan** — pastikan
  ekspor/backup yang diminta klien sudah diserahkan. Audit log tetap disimpan (tanpa isi data).

## 15. Backup & restore (H-06)
- **Backup:** `scripts/backup.sh [--env infra/compose/.env.dev] [--keep 7]` → `$SMIP_BACKUP_DIR` (bawaan `~/smip-backups/<UTC>/`, chmod 700):
  `postgres.dump` (pg_dump -Fc), `postgres-globals.sql` (role tanpa password), `ch-<tabel>.native.gz` (tabel dasar ClickHouse),
  `manifest.json` (jumlah baris, versi skema), `SHA256SUMS`. Menyimpan 7 terbaru. Secret/KEK **tidak** ikut — backup terpisah.
- **Restore (ke database baru):** `scripts/restore.sh <dir> --pg-db <baru> --ch-db <baru>` → cek checksum, pg_restore, migrasi
  ClickHouse, insert tabel dasar (MV membangun ulang agregat), bandingkan jumlah baris (exit 1 bila selisih). Lalu arahkan
  `DATABASE_URL` & `CLICKHOUSE_DB` ke database baru, restart `api workers`. Skrip menolak menimpa database aktif.
- **Drill:** kuartalan (§8) — laporan terakhir `docs/evidence/H-06/drill-2026-10-04.md` (RTO data ± 5 dtk, baris & agregat identik).
