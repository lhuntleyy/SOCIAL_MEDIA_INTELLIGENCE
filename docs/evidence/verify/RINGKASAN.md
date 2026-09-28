# Ringkasan connector verify (live, Apify)

- apify.facebook.scraperone: verified · sampel 5 · item valid 6 · p50 2932 ms · p95 10897 ms · biaya $5e-05
- apify.instagram.boolean: verified · sampel 5 · item valid 5 · p50 7095 ms · p95 10969 ms · biaya $0.00155
- apify.threads.scrapersdelight: verified · sampel 5 · item valid 25 · p50 7139 ms · p95 8035 ms · biaya $0
- apify.tiktok.apidojo: verified · sampel 5 · item valid 9 · p50 9432 ms · p95 18703 ms · biaya $0
- apify.x.apidojo: failed · sampel 5 · item valid 0 · p50 12823 ms · p95 22039 ms · biaya $0.004
- apify.x.xquik: verified · sampel 5 · item valid 50 · p50 5545 ms · p95 5883 ms · biaya $0.000539
- apify.youtube.streamers: verified · sampel 1 · item valid 4 · p50 18341 ms · p95 18341 ms · biaya $0.016

Catatan: `apify.x.apidojo` gagal karena batas run bulanan plan FREE per pengguna (log actor: "Monthly run limit exceeded per user") — bukan kesalahan normalizer.

**Biaya nyata** (selisih pemakaian akun Apify, lebih akurat dari `cost_usd` per run yang bisa tertinggal): seluruh probe bentuk + verify I-17/I-18 ≈ $0,47 (akun $1,67 → $2,14 dari kuota FREE $5/bln, 2026-09-29). YouTube paling mahal (~$0,04/run).
