# SECURITY

## 1. Threat Model (ringkas, STRIDE)

| Aset | Ancaman | Kontrol |
|---|---|---|
| Credential provider (API key, session) | Bocor via DB dump, log, queue, response API | Envelope encryption, redaction, write-only API, payload queue tanpa secret |
| Data tenant | Akses lintas tenant | RLS Postgres, tenant_id wajib di query ClickHouse, test isolasi otomatis |
| Akun user | Credential stuffing, session hijack | argon2id, MFA TOTP, rate limit login, refresh token rotation + reuse detection |
| Worker unofficial | Kompromi library pihak ketiga, egress liar | Container terisolasi, egress allowlist, non-root, read-only FS, least-privilege DB role |
| Konfigurasi router | Perubahan jahat/keliru | RBAC operator, audit log, optimistic locking, diff-confirm UI |
| Infrastruktur | SSRF via config connector (base URL) | Allowlist host per connector di `config_schema`; HttpClient menolak IP privat/link-local |
| Supply chain | Dependency berbahaya | Lockfile (`bun.lock`), pin versi, audit dependency di CI, SBOM, review dependency baru |

## 2. Autentikasi
- Password: `Bun.password.hash` (argon2id) — parameter memori/iterasi ditetapkan dan diuji benchmark di server target.
- Access JWT (15 menit), ditandatangani EdDSA/ES256 (`jose`), `kid` untuk rotasi kunci. Claims: `sub`, `tid`, `role`, `op` (operator), `iat`, `exp`, `jti`.
- Refresh token opaque 256-bit, disimpan hash SHA-256, rotasi setiap pakai; reuse → revoke family + alert.
- MFA TOTP (RFC 6238, implementasi Web Crypto) wajib untuk `owner`, `admin`, dan `platform_operator`; secret disimpan terenkripsi envelope (AAD `mfa:{user_id}`), setup tertunda 10 menit di Redis (terenkripsi) sampai kode diverifikasi.
- Login rate limit per IP + per akun; lockout bertahap.
- SSO (OIDC) opsional fase lanjut.

## 3. Otorisasi
- RBAC (lihat PRD FR-M02) + scope API key.
- Middleware urutan: `requestId → authn → tenantContext → rbac → validate → handler`.
- Role DB: login user service API = `NOINHERIT`, anggota `smip_app` & `smip_auth`; tanpa `SET LOCAL ROLE` ia tidak punya hak apa pun. `smip_auth` (migrasi 0008) satu-satunya yang boleh membaca `users.password_hash`/`mfa_secret_enc` dan menulis `refresh_tokens` — `withAuthRole()`; query tenant lewat `withTenant()` (`smip_app`).
- Postgres: setiap transaksi API `SELECT set_config('app.tenant_id', $tid, true)` (= `SET LOCAL`, tapi bisa diparameterisasi); RLS `USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)` — tanpa konteks tenant = 0 baris (deny), bukan error; `FORCE ROW LEVEL SECURITY`; role aplikasi tanpa `BYPASSRLS`. (S-08)
- ClickHouse: repository wajib parameter `tenantId` (tipe branded `TenantId`); lint rule melarang query string mentah di `apps/api`. Opsional row policy per user DB.
- Impersonasi operator (`X-Tenant-Id`) hanya untuk `op=true` (JWT, bukan API key), wajib header `X-Impersonation-Reason` ≥ 10 karakter, **setiap request** diaudit dengan alasan (F-10).
- `users` global ber-RLS untuk `smip_app` (migrasi 0009): tenant hanya melihat user yang punya membership di tenant konteks. Sebelumnya email/nama seluruh user platform terbaca lintas tenant (REVIEW F13).
- API key: SHA-256 di DB, dibandingkan waktu-konstan, prefix untuk lookup; tidak boleh mengelola akses (user/API key/tenant).

## 4. Manajemen Credential (Envelope Encryption)

```
KEK (di KMS/Vault, tidak pernah keluar)  ──wrap──►  DEK (acak 256-bit per credential)
DEK ──AES-256-GCM(iv 96-bit, AAD="credential:{id}:{tenant_id}")──► ciphertext
DB menyimpan: ciphertext, iv, wrapped_dek, kek_id, aad
```
- Adapter KMS: `vault-transit`, `aws-kms`, `gcp-kms`, dan `local-dev` (hanya untuk dev; startup gagal jika `NODE_ENV=production` & adapter `local-dev`).
- Dekripsi hanya di worker fetch (bun/py) tepat sebelum call; objek credential di memori tidak di-serialize; dibuang setelah job.
- DEK plaintext di-cache maksimal 5 menit di memori worker (opsional, config) untuk mengurangi call KMS.
- Rotasi KEK: job `rewrap` mengganti `wrapped_dek` tanpa menyentuh ciphertext.
- Revoke = hapus `wrapped_dek` (crypto-shredding) + status `revoked`.
- API: secret **write-only**; response hanya `display_hint`.
- Session library unofficial (cookie/settings) diperlakukan sebagai credential kind `session` (terenkripsi sama).

## 5. Redaction
- Logger (bun & python) memakai daftar key sensitif (`authorization`, `cookie`, `set-cookie`, `password`, `token`, `secret`, `api_key`, `sessionid`, `x-api-key`) + regex pola token → diganti `[REDACTED]`.
- `HttpClient` connector otomatis me-redact header & query param sensitif pada log/trace.
- Parameter query ORM/driver di pesan error (`params: …`) di-redact — drizzle menyertakan nilai parameter (mis. email) di pesan error (ditemukan smoke test F-09).
- Error message dari provider di-sanitize sebelum masuk `crawl_runs.error_message`.
- Test otomatis: injeksi secret palsu → assert tidak muncul di log, trace export, queue payload, DB kolom non-credential.

## 6. Isolasi Worker Unofficial & Egress
- `worker-fetch-py` di namespace/network terpisah; NetworkPolicy: egress hanya ke Redis, Postgres (role `py_reader`: SELECT pada `provider_accounts`, `credentials`, `connectors`), S3, KMS, dan **egress proxy** dengan allowlist domain per connector.
- Container: non-root, read-only root FS, drop all capabilities, seccomp default, resource limit.
- Akun platform untuk unofficial connector = akun khusus organisasi, bukan akun pribadi pegawai.
- Kill-switch: `providers.enabled=false` berlaku ≤ 30 s ke semua worker.

## 7. Keamanan API & Web
- TLS di ingress (HSTS). Internal mTLS opsional (service mesh).
- CORS allowlist origin web app.
- Cookie refresh `HttpOnly; Secure; SameSite=Strict; Path=/v1/auth`. Access token disimpan di memori SPA (bukan localStorage).
- **SSE**: `EventSource` tidak bisa mengirim header dan cookie refresh tidak terkirim ke `/v1/stream` (path berbeda). Karena itu SPA memanggil `POST /v1/stream/ticket` (Bearer) → server menerbitkan cookie `sse_ticket` (`HttpOnly; Secure; SameSite=Strict; Path=/v1/stream`, TTL 15 menit, terikat `sub`+`tid`+`topic_id`, disimpan hash-nya di Redis). Token **tidak pernah** di query string. Test SEC-10/SEC-11.
- CSP ketat (`default-src 'self'`; `img-src` mengizinkan domain CDN media platform yang dikonfigurasi atau proxy gambar internal).
- Validasi input Zod di semua endpoint; body limit (1 MB default).
- Parser query boolean: batas panjang & kedalaman AST (anti-DoS).
- Media dari platform ditampilkan via **image proxy** internal (menyembunyikan IP analis & mencegah mixed content), dengan batas ukuran & tipe.

## 8. Audit
- Semua mutasi config/credential/role/override sentiment → `audit_logs` (before/after ter-redact).
- Tabel append-only (REVOKE UPDATE/DELETE), partisi bulanan, ekspor berkala ke storage WORM (opsional).

## 9. Privasi, Compliance & Etika
- **UU No. 27 Tahun 2022 tentang Pelindungan Data Pribadi (UU PDP)**: data author (handle, nama, lokasi profil) adalah data pribadi walaupun publik. Wajib: dasar pemrosesan terdokumentasi, minimisasi, retensi terbatas (DATA_MODEL §9), prosedur permintaan penghapusan, pencatatan aktivitas pemrosesan. Review oleh konsultan hukum/DPO **sebelum go-live**.
- **ToS platform & provider**: setiap provider punya `tos_url` dan `risk_level`. Unofficial provider (`risk_level=high`) harus disetujui tertulis oleh pemilik produk + legal sebelum `enabled=true`; persetujuan dicatat di audit.
- Tidak mengumpulkan konten privat, tidak melakukan teknik bypass anti-bot/captcha.
- Minimisasi ke LLM: kirim teks + topik saja (AI_SPEC §4.5).
- **Transfer lintas negara (UU PDP Pasal 56).** LLM API & sebagian provider data (Apify, twitterapi.io) memproses data di luar Indonesia. Dasar transfer, perjanjian pemrosesan (DPA), dan daftar sub-prosesor dicatat di memo S-15 sebelum go-live; self-host NLP (AI_SPEC §14) mengurangi transfer untuk jalur AI.
- **Data anak.** Tidak ada label umur `below_18` per akun (AI_SPEC §12.2, ADR-007); bucket agregat hanya bila DPO mengizinkan (S-23).
- **Inferensi demografi (gender & age range) — diimplementasikan dengan kontrol** (AI_SPEC §12, ADR-007): diperlakukan sebagai data pribadi (UU PDP), **hanya ditampilkan agregat** (tak pernah label individu di feed), selalu dengan `coverage_pct` + confidence, metode & model versioned, perubahan model demografi masuk audit, review DPO sebelum go-live. Prioritaskan data self-declared/platform di atas inferensi.
- **Batas keras**: TIDAK ada inferensi atribut sensitif individu lain (agama, etnis, orientasi politik/seksual, kesehatan).
- Akses ke profil individu (feed) dicatat di audit (`post.view` sampling atau penuh — kebijakan tenant). Media ditampilkan via image proxy (§7).

## 10. Secrets Infrastruktur
- Env var sensitif (DB password, Redis password, KMS creds) dari secret manager (K8s Secret + External Secrets / Vault Agent). Tidak di-commit; `.env.example` tanpa nilai.
- Rotasi berkala terdokumentasi di RUNBOOK.

## 11. Security Testing
- SAST + secret scanning di CI (tool dipilih & diverifikasi berjalan di pipeline).
- Dependency audit & lisensi.
- Test isolasi tenant otomatis (TESTING §4.4, SEC-01..SEC-12).
- DAST ringan (OWASP ZAP baseline) di staging.
- Pentest eksternal sebelum produksi.
