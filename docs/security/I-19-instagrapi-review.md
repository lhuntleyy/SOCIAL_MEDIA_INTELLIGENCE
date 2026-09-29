# Review keamanan I-19 — connector unofficial `instagrapi.instagram`

Tanggal: 2026-09-29 · Status: **siap standby (disabled, weight 0)** · Reviewer ke-2: _belum_ (wajib sebelum `enabled=true` di produksi)

## Dasar & gate
- **S-15 (legal):** pemilik produk menyatakan persetujuan legal dari pimpinan pada 2026-09-29. SECURITY §7 mensyaratkan
  persetujuan **tertulis** sebelum provider `risk_level=high` di-`enabled`: memo harus dilampirkan (`docs/legal/`) dan
  pengaktifan dicatat di audit (PATCH `/admin/providers/{id}` → `audit_logs`).
- Posisi di ladder (PROVIDER_MATRIX §3): IG = Apify terverifikasi → vendor cadangan → **instagrapi standby `weight = 0`**.

## Ancaman → kontrol

| Ancaman | Kontrol | Bukti |
|---|---|---|
| Ban/challenge akun karena login berulang (pola bot) | Hanya sesi yang sudah ada (`settings` dump / `sessionid`); **login username/password otomatis tidak didukung**; challenge → `CHALLENGE_REQUIRED` (akun `needs_attention`, manual), tidak pernah di-resolve otomatis | `test_session_only_no_password_login`, skenario `challenge` |
| Dua worker memakai sesi yang sama | `exclusive_session` → session lock Redis per akun (I-16); kontensi → `RATE_LIMITED` (router pilih akun lain) | `test_session_lock_exclusive` |
| Throttle IG | `RATE_LIMITED` + backoff 15 menit per akun (kebijakan keamanan internal, bukan angka provider) + `delay_range` dari config | skenario `throttle` |
| Egress liar (library pihak ketiga dikompromikan / redirect) | Allowlist host di level `requests.Session` (hanya `*.instagram.com`), redirect dimatikan; manifest `allowed_hosts`; deploy: container terisolasi, egress allowlist jaringan, non-root, read-only FS (SECURITY §6) | `test_egress_guard_blocks_foreign_hosts` |
| Bocor secret (sessionid/cookie) ke log/queue/error | Credential envelope-encrypted (kind `session`), didekripsi di memori saat fetch; pesan error instagrapi TIDAK disalin (hanya nama exception); redaksi nilai secret di `execute_fetch`; `Credential.__repr__` tanpa isi | `test_challenge_message_has_no_secret`, contract `check_no_secret_leak`, `test_error_midway_keeps_items_and_redacts_secret` |
| Pengumpulan data berlebih (UU PDP) | Hanya field CanonicalItem; tidak mengambil follower/following, DM, profil privat; `followers` author = null (tanpa request profil) | `normalize` + contract |
| Tenant tidak mau data dari sumber unofficial | `tenants.settings.deny_high_risk_providers` (PATCH `/admin/tenants/{id}`, operator) → router `TENANT_RISK_OPT_OUT`; run shared (stream/refresh) yang melayani tenant opt-out → `denyHighRisk` | router test I-19, admin test I-19 |
| Aktif tanpa sengaja | Provider terdaftar `enabled=false`, connector `enabled=false`, tidak ada routing rule otomatis; saat ditambahkan: `weight 0` (standby) | `connectors.ts register` (dev DB) |
| Supply chain library | Versi dipin (`instagrapi==3.0.14`), hanya di image worker-fetch-py; API server tidak pernah memuat library ini (ADR-003) | `workers-py/requirements.txt` |

## Belum dilakukan (sengaja)
- **Verifikasi live** (`connector.verify`): butuh akun IG khusus organisasi (bukan akun pribadi pegawai, SECURITY §6) + sesi
  yang sudah login manual. Capability tetap `declared` sampai itu → router tidak memakainya kecuali policy `allow_unverified`.
- Persistensi cookie yang diperbarui (`sess:py:{account_id}`, CONNECTOR_SPEC §8) — sesi dibaca dari credential setiap fetch.
- Resume async tidak relevan (library sinkron, dijalankan di thread dengan deadline).

## Langkah operator untuk standby
1. Lampirkan memo legal tertulis; minta reviewer ke-2 menandatangani dokumen ini.
2. `POST /admin/accounts` provider `instagrapi`, `credential.kind = "session"`, `secret = { "settings": "<json dump instagrapi>" }`.
3. Tambah rule ke policy `instagram/search_hashtag` dgn **weight 0**, prioritas terakhir; `PATCH` connector+provider `enabled=true` (diaudit).
4. Jalankan verify 5 sampel dari akun khusus; pantau `needs_attention`.
