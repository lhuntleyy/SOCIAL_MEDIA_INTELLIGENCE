# H-03 pemindaian keamanan — 2026-10-04

| Pemeriksaan | Alat | Hasil |
|---|---|---|
| Secret di file yang dilacak git | `bun scripts/secret-scan.ts` (kini bagian `bun run check` → CI) | **bersih** (1 nilai palsu tes redaksi di-allowlist via hash) |
| Secret di **seluruh riwayat git** | `bun scripts/secret-scan.ts --history` | **bersih** |
| Kerentanan dependency | `bun audit` | 1 *moderate* — `esbuild ≤ 0.24.2` (GHSA-67mh-4wv8-2f99, dev server esbuild) transitif dari `drizzle-kit` & `vite > tsx`; **hanya tool development**, tidak ikut runtime produksi (API/worker tidak menjalankan dev server esbuild). Diterima; naikkan saat drizzle-kit/tsx rilis versi baru. |
| SAST / lint | Biome (lint + a11y), TypeScript strict, aturan dependensi (`scripts/check-deps.ts`) | 0 error (CI) |
| Tes keamanan aplikasi | SEC-01 (isolasi tenant ClickHouse), SEC-02 (secret tak muncul di respons/audit/outbox), SEC-07 (SSRF), SEC-09 (tanpa demografi per akun), SEC-10/SEC-11 (tiket SSE), webhook SSRF + HMAC, CSV formula injection | lulus (bagian dari 520+ tes) |
| DAST (OWASP ZAP) & pentest eksternal | — | **belum** — butuh vendor / jadwal dari pemilik (target: temuan high = 0 sebelum klien produksi) |

**Temuan operasional (bukan di repo):**
- Token GitHub tersimpan di URL remote `.git/config` server (tidak masuk repo/riwayat — dipastikan oleh pemindaian riwayat).
  Rekomendasi: cabut token itu di GitHub dan ganti dengan credential helper / deploy key baca-tulis khusus repo.
- Kunci provider (Apify/YouTube/Gemini) hanya di `~/.config/smip/secrets.env` (chmod 600) dan DB tersegel KMS.
