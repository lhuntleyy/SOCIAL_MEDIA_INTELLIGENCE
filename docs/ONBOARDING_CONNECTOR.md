# Onboarding sumber data (connector) baru — H-07

Panduan menambah provider/actor baru **tanpa mengubah core** (PRD G6, AGENTS Golden Rule 2). Contoh nyata di repo:
Apify `silentflow` (FB, 2026-10-03), `themineworks` (Threads), paket HTTP `hikerapi` (IG) & `lamatok` (TikTok).

## 0. Putuskan dulu: layak secara biaya & legal?
1. **Biaya** — hitung dengan rumus COST_MODEL §11.3/§12.6: tarif per hasil vs per request vs per run, dan apakah hasilnya
   **terurut terbaru** (bisa maxItems adaptif) atau filter waktu **per hari** (tagihan berulang tiap jadwal). Bandingkan dengan
   sumber aktif; catat di PROVIDER_MATRIX (tabel platform) + COST_MODEL.
2. **Risiko** — resmi / pihak ketiga / unofficial (login). Unofficial = `risk_level: high`, kantor bisa menolak (TENANT_RISK_OPT_OUT).
3. **Hindari** actor/provider yang sudah ditolak pemilik (mis. `apidojo` — batas run paket gratis).

## 1. Probe bentuk data (tanpa mengarang field — Golden Rule 1)
- Apify: `set -a; . ~/.config/smip/secrets.env; set +a; bun scripts/provider-probe/shape.ts <actor> '<input-json>' <maxUsd>`
  → `docs/evidence/shapes/shape-<actor>.json` (skema input + tipe tiap path output + biaya run; **tanpa nilai/identitas**).
- Provider HTTP: panggil 1–2 endpoint dengan key uji, simpan bentuk respons (bukan isinya) di `docs/evidence/shapes/`.

## 2. Kode connector
**Actor Apify** → file di `packages/connectors/apify/src/<platform>-<nama>.ts`:
- `normalize<…>(raw, meta)` → `CanonicalItem` (id post, waktu UTC via `toUtcIso`, author, metrics, media https saja, hashtag,
  `provenance(meta)`). Field yang tidak ada → `null` (jangan menebak).
- `ActorSpec`: `key` (`apify.<platform>.<nama>`), `actorId`, `operations.<op>` (`queryFeatures`, `supportsSince/Until`,
  `resultOrder: "desc"` bila terbukti terbaru-dulu, `sinceGranularity: "day"` bila filter tanggal per hari), `buildInput`.
- Daftarkan di `packages/connectors/apify/src/index.ts` (`APIFY_SPECS`).

**Provider HTTP baru** → paket `packages/connectors/<provider>/` meniru `hikerapi`/`lamatok`: kelas `Connector` dengan `manifest`
(providerKey, operations, `allowedHosts` untuk guard SSRF, `credentialFields`), semua HTTP lewat `ctx.http` (HttpClient), error
dilempar sebagai `ConnectorError` sesuai taksonomi (402 → `QUOTA_EXHAUSTED`, 429 → `RATE_LIMITED`, …). Daftarkan di
`apps/worker-fetch-bun/src/registry.ts`.

## 3. Tes (wajib sebelum live)
- Fixture tanpa data asli di `packages/connectors/<…>/test/` (`platforms.test.ts` untuk Apify): normalisasi, item rusak dibuang,
  body request yang dikirim (`expect(bodies[...])`), urutan/operasi yang diklaim manifest.
- Contract suite connector-sdk berjalan otomatis untuk spec terdaftar. `bun run check && bun test` hijau.

## 4. Urutan deploy (PENTING — insiden 2026-10-03, RUNBOOK §13)
1. Commit + deploy kode, **restart `workers`** (worker memuat connector baru).
2. `bun --env-file=infra/compose/.env.dev scripts/connectors.ts register` (connector baru masuk DB, nonaktif).
3. Akun/API key: Pengaturan → Sumber data → **Akun provider** (atau `connectors.ts account <provider> <label> <ENV_VAR>`).
4. `connectors.ts verify <key> "<query>" --apply` → panggil provider sungguhan (berbayar kecil), bukti
   `docs/evidence/verify/verify-<key>.json`, capability `verified`. Gagal → jangan dirouting.
5. Routing: Pengaturan → **Routing** (urutan/bobot/aktif, simulator) atau `scripts/live-routing.ts`. Baru di langkah ini traffic berpindah.
6. Pantau 1–2 jam di Pengaturan → **Monitor** (berhasil %, kegagalan, biaya per kantor) + tagihan di dashboard provider; bandingkan
   dengan perkiraan COST_MODEL.

## 5. Dokumentasi
PROVIDER_MATRIX (baris + status VERIFIED + tarif terukur), COST_MODEL (dampak paket), CHANGELOG, PROGRESS. Matikan sumber lama
yang lebih mahal (jangan dihapus — tetap sebagai cadangan nonaktif di Routing).
