# TESTING

## 1. Prinsip
- **Tidak ada task `done` tanpa test yang lulus** + bukti di PROGRESS.md. Sebelum CI ada (Fase 0, sebelum F-12): bukti = laporan tercommit di `docs/evidence/<task-id>/` berisi perintah reproduksi + output mentah + versi tool. Setelah F-12: link CI run wajib.
- CI **tidak pernah** memanggil provider eksternal. Provider nyata hanya dites di job terjadwal `provider-canary` (staging) dengan quota terpisah.
- Test runner Bun: `bun test` (unit/integration TS). Python: `pytest`. E2E: Playwright (runner dijalankan dengan Node jika Bun belum kompatibel — hasil spike S-08).

## 2. Piramida

| Level | Tool | Cakupan | Kapan |
|---|---|---|---|
| Unit | `bun test`, `pytest` | parser query, matcher, compiler, router algorithm, token bucket Lua (via Redis test), normalizer connector, redaction, crypto | setiap commit |
| Contract | contract suite `packages/connector-sdk/contract` + `pytest -m contract` | setiap connector memenuhi interface & canonical schema dengan fixture | setiap commit |
| Integration | docker compose (Postgres, Redis, ClickHouse, server S3-compatible) | alur scheduler→sink dengan connector `fake`, RLS, MV ClickHouse, outbox | setiap PR |
| E2E | Playwright | login, buat topik, dashboard tampil data fake, override sentiment, admin toggle provider | setiap PR (smoke) + nightly (full) |
| Chaos/failover | connector `fake` mode fault | failover, circuit breaker, rate/quota | setiap PR (subset) + nightly |
| Load | k6 (API) + generator job (ingest) | throughput & latency | pra-rilis mayor |
| AI eval | `pytest -m eval` | macro-F1 ≥ threshold di test set beku | setiap perubahan model/preprocessing |
| Security | SAST, secret scan, dep audit, ZAP baseline | — | setiap PR / nightly |
| Provider canary | staging, provider nyata | schema drift & capability | harian |

Target coverage (line) awal: `packages/core`, `packages/router`, `packages/query` ≥ 90%; lainnya ≥ 70%. Coverage bukan pengganti skenario di bawah.

## 3. Connector `fake`
Connector deterministik yang dapat diprogram per test:
```ts
fake.script([
  { op: "search_keyword", respond: { items: fixtures.x.basic, nextCursor: null } },
  { op: "search_keyword", fail: { code: "RATE_LIMITED", retryAfterMs: 30000 } },
  { op: "search_keyword", delayMs: 5000 },                          // untuk timeout
  { op: "search_keyword", respond: { items: fixtures.malformed } },  // PARSE_ERROR
]);
```
Dua instance `fake` (`fake-a`, `fake-b`) mensimulasikan dua provider untuk skenario failover.

## 4. Skenario Wajib

### 4.1 Router & failover
| ID | Skenario | Ekspektasi |
|---|---|---|
| R-01 | Priority 1 sehat | selalu dipilih |
| R-02 | Dua rule weight 70/30 dalam 1 grup, 10.000 simulasi | distribusi dalam ±3% |
| R-03 | Rule disabled / connector disabled / provider disabled / account disabled | tidak pernah dipilih (4 sub-case) |
| R-04 | Capability `declared` & `allow_unverified=false` | dieliminasi `CAPABILITY_NOT_VERIFIED` |
| R-05 | interval < `min_interval_sec` | dieliminasi |
| R-06 | `fake-a` RATE_LIMITED | attempt ke `fake-b` dalam run yang sama; `rl:dyn` fake-a terset |
| R-07 | `fake-a` AUTH_INVALID | account `needs_attention`, failover, alert event |
| R-08 | Semua connector gagal | run `failed`, `consecutive_failures++`, backoff next_run_at |
| R-09 | Circuit: 5 failure → open → cooldown → half_open → 2 sukses → closed | transisi tercatat |
| R-10 | Hard quota habis | `none_available(QUOTA_EXHAUSTED)`, run `skipped`, tidak ada call |
| R-11 | Reservasi quota & rate atomic di bawah konkurensi 100 | tidak pernah melebihi limit |
| R-12 | Ubah weight via API | berlaku ≤ 30 s di worker tanpa restart |
| R-13 | Tenant BYO account | tidak pernah dipakai untuk tenant lain |
| R-14 | Ganti provider utama (swap priority) | tidak ada perubahan kode/test di `packages/core` (dicek dengan diff guard CI) |
| R-15 | Collection stream lintas tenant | tidak pernah memakai akun BYO; tenant BYO mendapat stream `private:` |

### 4.2 Pipeline
| ID | Skenario | Ekspektasi |
|---|---|---|
| P-01 | Item sama dari 2 provider | 1 row `posts`, 1 match |
| P-02 | Overlap window | tidak ada duplikat di agregat |
| P-03 | Pesan `sink.analytics` terkirim 2× | agregat tidak double |
| P-04 | Query `A AND NOT B` di connector yang hanya dukung term | item berisi B tidak match |
| P-05 | Metrics null dari provider | tersimpan null, UI "tidak tersedia", bukan 0 |
| P-06 | Override sentiment/emotion | proporsi berubah benar (sign -1/+1) |
| P-07 | Coalescing: run lama belum selesai | run baru `coalesced`, bukan antre |
| P-08 | Engagement refresh | agregat engagement ter-update tanpa double count |
| P-09 | Key Redis `seenm` hilang (di-flush) + item sama datang lagi | guard ClickHouse (§6.2) mencegah double-count di agregat |
| P-10 | Worker fetch mati saat run non-final | `crawl.reaper` reset `inflight_run_id`, plan jalan lagi (tidak beku) |
| P-11 | Repost dengan penulis asli | `agg_reposted_author_1d` menghitung penulis asli, bukan pe-repost |
| P-12 | Query `keywords`+`languages`+`media_tags`/`not_media_tags` | local matcher menerapkan semua filter dengan benar |
| P-13 | Emotion low-confidence | `emotion='unknown'`, tidak menebak |
| P-14 | 2 topic keyword beririsan | fetch **1×** via collection stream; matcher map ke kedua topic; biaya tidak dobel |
| P-15 | Provider kembalikan 25, tersimpan 2 | `usage.results=25` (dikembalikan), bukan 2 (tersimpan) |
| P-16 | Soft cap biaya tercapai | interval throttle ke maks (1h), ingestion **tidak berhenti**; hard quota → `skipped` |
| P-17 | Post tak match topic mana pun | tetap disimpan via `sink.analytics` (`matches=[]`), tidak dikirim ke `ai.enrich`; terhapus setelah `unmatched_posts_retention_days` |
| P-18 | Halaman 1–2 sukses, halaman 3 gagal (hasil desc) | run `partial`; `high_watermark` **tidak** maju; `gap_window = [since, min(published_at diterima)]`; run berikutnya mengambil celah; tidak ada post hilang |
| P-19 | Provider menagih minimum per request, respons kosong | `usage.costUnits` = minimum per request (bukan 0); quota ter-commit |
| P-20 | Stream lintas 2 tenant, 30 match tenant A, 10 match tenant B | biaya run teralokasi 75/25 ke `quota_usage` tenant; total = biaya run |
| P-21 | Engagement refresh mengubah followers akun | `agg_author_1d.author_followers` = nilai terakhir, **bukan** jumlah (regresi bug SummingMergeTree) |

### 4.3 Queue
Graceful shutdown mengembalikan job; poison message → DLQ; redrive dari DLQ berhasil; idempotency jobId.

### 4.4 Security (prefix `SEC-` — berbeda dari task Fase 0 `S-xx`)
| ID | Skenario |
|---|---|
| SEC-01 | User tenant A tidak bisa membaca topik/analytics/post-match tenant B (semua endpoint, di-generate dari OpenAPI) |
| SEC-02 | Secret credential tidak muncul di: response API, log, queue payload, trace, `crawl_runs.error_message` |
| SEC-03 | Ciphertext diubah 1 byte → dekripsi gagal (GCM auth) |
| SEC-04 | AAD beda tenant → dekripsi gagal |
| SEC-05 | Refresh token reuse → family revoked |
| SEC-06 | Viewer tidak bisa PATCH apa pun |
| SEC-07 | Config connector base URL ke IP privat ditolak (SSRF) |
| SEC-08 | Query boolean super dalam/panjang ditolak (DoS guard) |
| SEC-09 | Endpoint feed/post **tidak pernah** mengembalikan gender/age individu (hanya agregat di psychography) |
| SEC-10 | SSE tidak menerima token via query string (hanya cookie `sse_ticket`/Bearer header) |
| SEC-11 | `sse_ticket`: kedaluwarsa → 401; tiket tenant A tidak bisa membuka stream topic tenant B; cookie refresh tidak diterima di `/v1/stream` |
| SEC-12 | Export CSV/XLSX & feed tidak pernah memuat gender/age individu; tidak ada baris `author_demographics` ber-`below_18` |

### 4.5 Analytics
Hasil endpoint analytics dibandingkan dengan query referensi langsung ke `topic_match_events` pada dataset seed (golden test) — agregat harus identik. Cakupan golden **wajib** termasuk: kolom `engagement_known_posts`, bucket geo `''`/unknown, exposure, sentiment (count & engagement), **emotion** (stream/radar/proportion), issues, **hashtags** (count & engagement), locations, **psychography gender & age** (termasuk `coverage_pct` & bucket `unknown`), most-reposted, totals comparison, contributors.

## 5. Bun Compatibility Tests (fase 0)
`scripts/compat-check.ts` menjalankan smoke test tiap dependency kritis di Bun versi pin:
- hono: routing + middleware + streaming SSE.
- bullmq: enqueue/consume/delay/retry/stalled + interop dengan worker Python (`bullmq` PyPI) pada queue yang sama.
- ioredis: Lua EVALSHA.
- drizzle + Bun.sql/postgres: transaksi, `SET LOCAL`, RLS.
- @clickhouse/client: insert JSONEachRow, query stream.
- Bun.s3: put/get/presign ke server S3-compatible (spike: versitygw; MinIO OSS diarsipkan).
- jose: sign/verify EdDSA.
- OpenTelemetry: span export OTLP.
- Web Crypto AES-GCM encrypt/decrypt interop dengan Python `cryptography`.
Hasil → tabel di ADR-001, status per library `COMPATIBLE | WORKAROUND | INCOMPATIBLE | UNTESTED`. Implementasi: `scripts/compat-check.ts` + `scripts/compat/*`, infra lokal tanpa Docker: `scripts/spike-infra.sh`. Laporan: `docs/evidence/compat/results.md`.

## 6. Load Test
- Ingest: generator memasukkan N item/menit via connector `fake` untuk M topik × platform; ukur lag tiap queue, freshness, CPU.
- API: k6 skenario dashboard (7 widget paralel per user) dengan dataset sintetis 50 juta match; target NFR-04.
- Hasil & konfigurasi dicatat di `docs/perf/<tanggal>.md`.

## 7. Definition of Done (per task)
- [ ] Kode + test (unit/contract/integration sesuai jenis) lulus di CI.
- [ ] Tidak ada penurunan coverage di paket inti.
- [ ] Lint, typecheck, dependency-rule check lulus.
- [ ] Dokumen terkait diperbarui (spec/ADR/RUNBOOK).
- [ ] Untuk connector: contract suite + fixture + verify di staging (evidence_ref).
- [ ] Untuk model AI: eval report dilampirkan.
- [ ] Entri CHANGELOG di `Unreleased`.
- [ ] PROGRESS.md diperbarui dengan link bukti.
