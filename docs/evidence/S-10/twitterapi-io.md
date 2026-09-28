# S-10 — Verifikasi dokumen twitterapi.io (X utama)

- Tanggal akses: 2026-09-28
- Pelaksana: claude (agent). **Status task: `review`** — AC S-10 butuh review 2 orang; reviewer manusia wajib membuka ulang URL di bawah.
- Metode: baca halaman resmi provider (bukan blog pihak ketiga). Tidak ada API key → tidak ada panggilan API nyata (itu S-14).
- Hasil terstruktur: [PROVIDER_MATRIX §6.1](../../PROVIDER_MATRIX.md#61-twitterapi_iox--hasil-s-10-status-review-butuh-reviewer-ke-2)

## Sumber & kutipan

| URL | Fakta (kutipan) |
|---|---|
| https://twitterapi.io/pricing | "$0.15 per 1K tweets"; "$0.18 per 1K users"; "1 USD = 100,000 Credits"; "Minimum $0.00015 (15 Credits) per API call"; List function "$0.0015 (150 Credits) per API call (effective October 1st)"; "Pay as you go, no minimum spend required"; bonus credits "valid for 30 days" |
| https://docs.twitterapi.io/introduction | "Supports up to 200 QPS per client"; "Single `x-api-key` header, no OAuth."; "Minimum charge: $0.00015 per request (even if no data returned)" |
| https://docs.twitterapi.io/api-reference/endpoint/tweet_advanced_search | `GET https://api.twitterapi.io/twitter/tweet/advanced_search`; header `X-API-Key`; `query` (wajib), `queryType` `Latest`/`Top` (wajib), `cursor` ("" = halaman pertama); "up to 20 … (Sometimes less than 20, because we will filter out ads or other not tweets)"; respons `tweets`, `has_next_page`, `next_cursor`; `createdAt` contoh "Tue Dec 10 07:00:30 +0000 2024"; contoh query memakai `since_time:<unix>`; "please don't use since:2021-12-31_23:59:59_UTC and until:… it's not supported now!!!" |
| https://twitterapi.io/qps-limits | Free tier: "one API request every 5 seconds"; berdasarkan saldo: ≥1.000 credits → 3 rps, ≥5.000 → 6, ≥10.000 → 10, ≥50.000 → 20; status HTTP saat melebihi: tidak disebutkan |
| https://twitterapi.io/readme | "independent third-party service. Not affiliated with X Corp."; "1000+ QPS" default; ToS `/terms`, AUP `/acceptable-use` |

## Temuan

1. **Konflik angka QPS** (200 vs 1000+ vs 3–20 per saldo) → tidak ada angka yang boleh dipakai routing produksi (Golden Rule 1). Awal: `internal_safety` 3 rps/akun.
2. **`since_id` tidak terdokumentasi** di halaman endpoint; yang terdokumentasi `since_time`/`until_time`. Dokumen pembanding membangun adapter di atas `since_id:` — belum terbukti. Uji di S-14.
3. **Minimum charge per request, termasuk respons kosong.** Klaim "run kedua biaya nol" (dokumen pembanding) salah untuk provider ini. Model biaya diperbarui (COST_MODEL §3).
4. **`createdAt` bukan ISO-8601** → normalizer wajib parse eksplisit.
5. 15 credit/tweet ⇒ $0,15/1K konsisten dengan minimum 15 credit/request (= biaya 1 tweet).

## Sisa AC
- Reviewer manusia ke-2.
- S-14: ukur latency p50/p95, uji `since_id:`, status HTTP saat rate-limit, biaya poll kosong nyata (butuh API key).
- S-15: review ToS/AUP twitterapi.io (pihak ketiga tanpa afiliasi X Corp).
