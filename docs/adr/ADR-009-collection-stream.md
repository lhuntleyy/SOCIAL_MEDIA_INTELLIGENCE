# ADR-009: Collection stream (dedup fetch antar topic) — optimasi biaya near-term

- Status: Accepted (near-term, additive)
- Tanggal: 2026-09-28

## Konteks
Model crawl saat ini membuat `crawl_plans` per (`topic_query` × platform × operation). Dua topic dengan keyword beririsan **fetch terpisah dan membayar dua kali** ke provider. Analisis biaya (COST_MODEL §6) menunjukkan tumpang tindih topic publik Indonesia berat: ~1,8× @30 topic, ~4,0× @108 topic → biaya data membengkak s/d **2,45×**. `posts` sudah global (ADR-005) sehingga *storage* & *AI* tidak dobel lintas tenant, tapi *fetch* masih dobel. Dokumen kita sebelumnya menaruh "share crawl" sebagai fase lanjut (via `ast_hash`); dokumen pembanding memakainya sejak awal.

## Keputusan
Promote menjadi **optimasi near-term yang additive** (tidak merombak model crawl):
- **Dedup planner** menggabung `topic_queries` aktif → himpunan **collection stream** minimal per (platform, operation), kunci `ast_hash`/`stream_key`.
- Fetch dilakukan **per stream sekali**; **local matcher** (dengan inverted-index term→kandidat, CONNECTOR_SPEC §5) memetakan tiap post ke **semua** topic_query yang cocok — lintas tenant.
- Recall dari stream, **presisi tetap dari AST asli** (ADR-006).
- Post yang tak match topic mana pun **tetap disimpan** untuk backfill topic baru tanpa fetch ulang berbayar; hanya post match yang di-enrich (match-before-enrich).
- Tabel additive `collection_streams` + `stream_topic_links` (DATA_MODEL §3.11). Kalau planner dimatikan → fallback ke crawl per-query.

## Alternatif ditolak
- **Tetap fase lanjut**: kehilangan penghematan s/d 2,45× dan mahal di-retrofit setelah skema data terlanjur per-topic.
- **Rombak total model crawl sekarang**: risiko tinggi; keputusan produk = additive/near-term dulu.
- **Percolator (OpenSearch)** seperti dokumen pembanding: kita ClickHouse, bukan OpenSearch → pakai inverted-index in-memory sebagai gantinya.

## Amandemen 2026-09-28 (review v0.4)
Tiga lubang di keputusan awal, ditutup:
1. **Interval.** "Interval stream = min interval anggota" membuat term yang dipakai topic 1 jam ikut ditarik tiap 5 menit bila ada satu topic 5m yang berbagi term → biaya naik. Stream kini per `interval_class`.
2. **Kepemilikan & biaya.** Run stream lintas tenant tidak bisa dimiliki satu tenant. Run stream = system-owned; biaya dialokasikan proporsional match ke `quota_usage` tenant (`cost_allocations`), sehingga quota & cost guard per tenant tetap berlaku.
3. **BYO credential.** Akun BYO tenant tidak boleh melayani tenant lain (R-13) → stream lintas tenant hanya memakai shared pool; tenant BYO mendapat stream `private:{tenant_id}`.

## Konsekuensi
- Menambah dedup planner + tabel stream + matcher inverted-index; interaksi dengan coalescing/high-watermark per stream (bukan per plan).
- Interval efektif stream = `interval_class` (clamp capability) — lihat amandemen.
- Retensi post global harus mempertahankan post tak-match untuk backfill (DATA_MODEL §9).
- Fondasi juga menyelesaikan skalabilitas matcher untuk 108+ topic.

## Implementasi (I-22, 2026-09-29)
- **Planner** (`apps/scheduler/src/streams.ts`, tiap `SCHEDULER_STREAM_PLAN_MS`, aktif bila `SCHEDULER_STREAMS_ENABLED=true` — default **false** di produksi, true di `.env.dev`): set penutup (`coverSet`) tiap query → per (platform, operation, visibility) → kelas interval cepat→lambat; query lambat yang term-nya ⊆ stream lebih cepat **menumpang**; sisanya komponen terhubung via term bersama, **hanya komponen ≥ 2 query** jadi stream (tanpa irisan = tanpa penghematan → tetap plan). Tenant ber-akun BYO aktif → stream privat.
- **Rekonsiliasi idempoten** (`stream_key` = sha256(platform|operation|kelas|visibility|term)): stream yang tak diinginkan lagi dinonaktifkan dan **plan anggota mewarisi watermark stream**; stream baru mulai dari watermark **terendah** anggota → tidak ada celah maupun fetch ulang dari awal.
- **Scheduler**: plan yang dilayani stream aktif dilewati; stream dijadwalkan seperti plan (coalescing, window watermark−overlap, celah, backoff — migrasi 0017).
- **Dispatch**: pemilik run = plan **atau** stream; stream shared → `sharedPoolOnly` (R-15), privat → konteks tenant-nya. AST fetch = OR term stream.
- **Pipeline**: `QueryIndex` (inverted index atas set penutup; diuji identik dengan brute force) memetakan item ke semua query anggota → batch `ai.enrich` per (tenant, topik); `seenm` per topik.
- **Belum (I-25):** atribusi biaya run stream ke `quota_usage` tenant + `cost_allocations`; riwayat run stream belum tampil di `GET /topics/{id}/runs` (run stream `tenant_id` NULL tidak lolos RLS tenant).
