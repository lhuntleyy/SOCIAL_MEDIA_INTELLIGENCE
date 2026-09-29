# DEPLOYMENT

## 1. Environment
| Env | Tujuan | Provider eksternal |
|---|---|---|
| `local` | dev dengan docker compose | connector `fake` + opsional sandbox key |
| `ci` | test otomatis | hanya `fake` + fixture (tidak ada call eksternal) |
| `staging` | pra-produksi, data nyata terbatas | akun provider terpisah, quota kecil |
| `prod` | produksi | pool produksi |

## 2. Image

### 2.1 Bun services (`infra/docker/Dockerfile.bun`)
```dockerfile
# versi dipin — isi dari .bun-version setelah spike
ARG BUN_VERSION=<pinned>
FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY apps ./apps
COPY packages ./packages
RUN bun install --frozen-lockfile --production

FROM oven/bun:${BUN_VERSION}-slim AS runtime
WORKDIR /app
ARG SERVICE
ENV NODE_ENV=production SERVICE=${SERVICE}
COPY --from=deps /app /app
USER bun
EXPOSE 8080
CMD ["sh", "-c", "bun run apps/${SERVICE}/src/main.ts"]
```
Satu image, banyak service (dipilih `SERVICE`), atau image per service jika ukuran jadi masalah. Tag slim/distroless diverifikasi tersedia untuk versi yang dipin.

### 2.2 Python workers (`infra/docker/Dockerfile.py`)
Python 3.12 slim, dependency dipin dengan hash (`uv`/`pip-tools`), user non-root, model AI **tidak** di-bake ke image (di-mount dari S3 saat start ke volume cache).

### 2.3 Web
`bun run build` → static di nginx/CDN, header keamanan (CSP, HSTS) di ingress.

## 3. Local (docker compose)

File nyata: [`infra/compose/docker-compose.yml`](../infra/compose/docker-compose.yml) + env dev [`infra/compose/.env.dev`](../infra/compose/.env.dev) (tanpa secret produksi).

| Service | Image (dipin) | Port host | Catatan |
|---|---|---|---|
| postgres | `postgres:16-alpine` | 55432 | user `smip_owner` = pemilik skema (menjalankan migrasi); role grup `smip_app`/`smip_system`/`smip_py_reader` dibuat migrasi 0001 |
| redis-queue | `redis:7-alpine` | 56379 | `noeviction` + AOF (BullMQ) |
| redis-cache | `redis:7-alpine` | 56380 | `volatile-ttl`, 128 MB — **terpisah** dari queue |
| clickhouse | `clickhouse/clickhouse-server:26.3.34.136` (LTS) | 58123 | test migrasi & golden lulus di 26.3 LTS dan 26.10 |
| s3 | `versity/versitygw:v1.8.0` | 57070 | S3-compatible yang dirawat (bukan MinIO OSS) |
| vault | `hashicorp/vault:2.1.1` (dev mode) | 58200 | token `smip-dev`, kunci transit `smip-kek` dibuat seed — **dev saja** |

`bun run dev:up` → `compose up -d --wait` (healthcheck) → bucket S3 → `db:migrate up` → `ch:migrate up` → `seed` (plan dev, 8 platform (6 aktif), tenant `contoh`, admin `admin@contoh.local` — password dicetak sekali atau `SEED_ADMIN_PASSWORD`, provider nyata tercatat **disabled**, connector `fake.<platform>` + policy global). Idempoten. `bun run dev:down [--volumes]`.
Service aplikasi (api/workers/web) ditambahkan ke compose saat kodenya ada (Fase 2–3). Port dibuat berbeda dari `scripts/spike-infra.sh` agar tidak bentrok.

### 3.1 VPS dev/demo kecil (RAM ~2 GB) — tanpa upgrade
Diukur 2026-09-30 di VPS 2 vCPU / 1,9 GB:

| Langkah | Efek terukur |
|---|---|
| ClickHouse profil hemat memori (`infra/compose/clickhouse/low-memory*.xml`, otomatis di compose dev): batas server 500 MB, cache kecil, log sistem dimatikan, `max_threads` 2 | memori anon ~470 → ~310 MB; tulis disk latar hilang |
| Semua worker Bun dalam **satu proses** (`bun run dev:workers` default → `scripts/workers-all.ts`; `DEV_WORKERS_MODE=multi` = proses terpisah) | 6 proses 454 MB → 1 proses **92 MB** |
| Swap lebih besar (butuh sudo, sekali): lihat perintah di bawah | ruang aman untuk lonjakan (test/build/kind) |

```bash
sudo swapoff /swap.img && sudo fallocate -l 4G /swap.img && sudo chmod 600 /swap.img && sudo mkswap /swap.img && sudo swapon /swap.img
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-smip.conf && sudo sysctl -p /etc/sysctl.d/99-smip.conf
```
Tambahan bila masih sesak: matikan service yang tidak dipakai saat itu (`docker compose stop vault` bila KMS local-dev; ClickHouse saat
hanya mengerjakan API/router), dan jangan menjalankan model NLP lokal di VPS ini (Fase 3: inference encoder di mesin lain / LLM API).

### 3.2 Demo publik (VPS dev) — `bun run demo:up`
Stack dev + `infra/compose/docker-compose.demo.yml`: **api** & **workers** (semua worker Bun 1 proses) sebagai container `oven/bun`
(repo di-mount read-only), **web** = Caddy: file statis `apps/web/dist` + reverse proxy `/v1/*` → api, **HTTPS otomatis** Let's Encrypt
untuk `SITE_HOST` (`infra/compose/.env.demo`: `43-156-61-233.sslip.io` — layanan DNS wildcard yang menunjuk ke IP, tanpa beli domain).
HTTPS wajib: cookie refresh `Secure`. Akses via IP langsung dialihkan ke hostname HTTPS. Port 80/443 di-publish Docker (tidak lewat ufw).
**Port infra (Postgres/Redis/ClickHouse/S3/Vault) diikat ke `127.0.0.1`** (perbaikan 2026-09-30: sebelumnya `0.0.0.0` → karena Docker
melewati ufw, database dev dengan password di repo bisa dijangkau dari internet). Container aplikasi memakai jaringan internal Docker.
Vault dev menyimpan KEK di memori — **membuat ulang container vault menghilangkan semua secret tersegel** kecuali DEK dibungkus ulang
(lihat RUNBOOK §9 rotasi KEK; dilakukan sekali 2026-09-30 saat memindah port). Panduan lengkap dari nol: `docs/INSTALL.md`.
- Secret di luar repo: `~/.config/smip/jwt-demo.pem` (kunci JWT EdDSA, chmod 600).
- `demo:up` = build web → migrasi PG + CH → compose up. `demo:down` menghentikan api/workers/web.
- Akun: `bun --env-file=infra/compose/.env.dev scripts/set-password.ts <email> [--operator]` (password dicetak sekali; MFA daftar ulang).
- User baru: `bun --env-file=infra/compose/.env.dev scripts/create-user.ts <email> "<nama>" <viewer|analyst|admin|owner> <tenant-slug>` (viewer/analyst tanpa MFA — cocok untuk demo klien hanya-baca).
- LLM: panel *Pengaturan AI* atau `scripts/llm-provider.ts`; label ulang data lama: `scripts/reprocess-ai.ts`.
- API di belakang proxy: `API_TRUST_PROXY=true` → IP klien dari X-Forwarded-For bila peer jaringan privat (rate limit login tetap per klien).
- Bukan produksi: Vault dev mode, DB owner role, tanpa backup.

## 3a. Profil MVP single-node (produksi awal ≤ ~30 topic)

Arsitektur (port, queue, kontrak) **tidak berubah**; hanya cara menjalankannya. Profil ini yang cocok dengan angka infra COST_MODEL ($30–85/bln); profil Kubernetes §4 adalah skala lanjut dengan biaya jauh lebih tinggi.

| Komponen | Profil MVP |
|---|---|
| Host | 1 VM 4–8 vCPU / 16 GB, disk SSD, docker compose + systemd restart |
| Worker Bun | **satu proses** `SERVICE=workers` yang menjalankan consumer dispatch/fetch-bun/pipeline/sink/health/ops sekaligus (masing-masing tetap modul terpisah; pemisahan = ubah compose, bukan kode) |
| Scheduler | di dalam `SERVICE=workers` (leader lock tetap dipakai agar aman saat diskalakan) |
| worker-ai | 1 container Python (CPU); worker-fetch-py hanya jika S-15 menyetujui unofficial |
| Redis | **2 instance** tetap (queue `noeviction` + cache) — murah, dan menyatukannya adalah bug yang sudah dianalisis (DATA_MODEL §7) |
| Postgres, ClickHouse, object storage | container di VM yang sama, volume terpisah; object storage = S3 terkelola (disarankan) atau server S3-compatible yang masih dirawat; backup harian ke object storage eksternal |
| KMS | Vault single-node (atau KMS cloud) — `local-dev` **dilarang** di produksi |
| Pindah ke §4 bila | CPU > 70% berkelanjutan, freshness SLO terlewati, atau > ~30 topic aktif |

## 4. Production skala (Kubernetes + Helm `infra/helm/smip`)

| Workload | Kind | Replika awal | Autoscale | Catatan |
|---|---|---|---|---|
| api | Deployment | 2 | HPA CPU 60% | PDB minAvailable 1 |
| scheduler | Deployment | 2 | — | leader election Redis |
| worker-dispatch | Deployment | 2 | KEDA (Redis list length `crawl.dispatch`, `fetch.result`) | |
| worker-fetch-bun | Deployment | 2 | KEDA `fetch.bun` | |
| worker-fetch-py | Deployment | 1 | KEDA `fetch.py`, max kecil | namespace terisolasi + NetworkPolicy + egress proxy |
| worker-pipeline | Deployment | 2 | KEDA | |
| worker-ai | Deployment | 1 | KEDA `ai.enrich` | node pool GPU opsional |
| worker-sink | Deployment | 2 | KEDA | |
| worker-health, worker-ops | Deployment | 1 | — | |
| migrate | Job (Helm pre-upgrade hook) | — | — | Postgres + ClickHouse migrations |

Angka replika = titik awal; kalibrasi dari load test. **Keputusan S-05 (2026-09-29): KEDA Prometheus scaler** atas `smip_queue_depth{queue,state="backlog"}` (diekspor scheduler di `GET /metrics`, port `SCHEDULER_METRICS_PORT` default 9464, semua replika). Scaler `redis` listLength **ditolak**: LLEN `<prefix>:<queue>:wait` tidak menghitung job ber-priority (sorted set `prioritized`) maupun `active` — dibuktikan `packages/queue/test/keda-s05.test.ts`. Template: `infra/k8s/keda/scaledobjects.yaml`. Kolom "KEDA …" di tabel atas berarti trigger Prometheus pada queue tsb. Demo di kind belum dijalankan (host dev tanpa akses Docker + RAM 2 GB) — diverifikasi saat H-05.

### 4.1 Data services
| Service | Opsi | Catatan wajib |
|---|---|---|
| PostgreSQL 16 | managed (RDS/Cloud SQL) atau CloudNativePG | PITR, backup harian, pgBouncer (mode transaction — cek kompat `SET LOCAL` → pakai per-transaksi) |
| Redis 7 (dua peran) | managed atau Sentinel/cluster | **Redis-queue** (BullMQ): `noeviction` + AOF everysec + replika; Redis Cluster butuh hash tag `{bull}`. **Redis-cache/dedupe** (instance/DB terpisah): boleh `volatile-ttl`, TAPI `seen*`/`seenm*` tak boleh evict sebelum TTL (dedupe) — beri memori cukup atau andalkan guard ClickHouse (DATA_MODEL §6.2). Jangan satukan dua policy ini. |
| ClickHouse | ClickHouse Cloud atau self-hosted (Altinity operator) | Replicated tables + Keeper untuk HA; backup (`clickhouse-backup` atau BACKUP SQL) |
| Object storage | S3 / GCS (S3 API) / R2, atau self-host S3-compatible yang **masih dirawat** (Garage, SeaweedFS, versitygw — evaluasi di F-11) | lifecycle raw 30 hari, SSE. **Jangan MinIO OSS**: repo diarsipkan, binary komunitas tidak lagi didistribusikan (dl.min.io → HTTP 410, dicek 2026-09-28), tanpa update keamanan. Fitur lifecycle wajib diverifikasi di server pilihan. |
| KMS | Vault Transit / cloud KMS | policy per service account |

## 5. Environment Variables (ringkas)

| Var | Service | Keterangan |
|---|---|---|
| `DATABASE_URL` | semua bun, py(reader) | role berbeda per service |
| `REDIS_URL` | semua | Redis-queue (BullMQ, noeviction) |
| `REDIS_CACHE_URL` | semua | Redis-cache/dedupe/rate/quota — **wajib berbeda** dari `REDIS_URL` (divalidasi) |
| `CLICKHOUSE_URL`, `CLICKHOUSE_DB` (default `smip`), `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD` | api, sink, ops | migrasi: `bun run ch:migrate up` |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET_RAW`, `S3_BUCKET_EXPORTS`, `S3_BUCKET_TRAINING`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | fetch, pipeline, sink, ops | `S3_BUCKET_TRAINING` = teks korpus `nlp_labels` |
| `KMS_ADAPTER` (`vault-transit`/`aws-kms`/`gcp-kms`/`local-dev`), `KMS_KEY_ID`, `VAULT_ADDR`, `VAULT_TOKEN`, `KMS_LOCAL_DEV_KEK_B64` | fetch, api, health | `local-dev` ditolak saat `NODE_ENV=production` |
| `API_PORT` (default 8080), `JWT_PRIVATE_KEY_PATH`, `JWT_KID`, `CREDENTIAL_PEPPER_B64` (secret, base64 ≥ 32 byte — HMAC fingerprint credential) | api | |
| `CORS_ORIGINS` | api | |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME` | semua | |
| `LOG_LEVEL` | semua | |
| `ANTHROPIC_API_KEY` | worker-ai | hanya jika LLM fallback aktif; dari secret manager |
| `SCHEDULER_TICK_MS` | scheduler | default 15000 |
| `SCHEDULER_METRICS_PORT` | scheduler | default 9464 (0 = mati) — `GET /metrics` internal (smip_queue_depth, S-05) |
| `ENGAGEMENT_REFRESH_ENABLED` (true), `ENGAGEMENT_REFRESH_PLAN_MS` (900000), `ENGAGEMENT_REFRESH_MAX_AGE_HOURS` (24), `ENGAGEMENT_REFRESH_MIN_GAP_SEC` (7200), `ENGAGEMENT_REFRESH_MAX_POSTS` (500/platform/siklus) | worker-sink | I-20 planner engagement refresh |
| `SCHEDULER_COST_GUARD_INTERVAL_SEC` | scheduler | default 3600 — interval efektif plan/stream saat soft cap biaya tercapai (I-23) |
| `EGRESS_PROXY_URL` | worker-fetch-py | |

Semua divalidasi saat boot oleh `packages/config` (`loadConfig(service)`, Zod); service gagal start jika tidak valid, pesan error hanya menyebut nama variabel (tanpa nilai). Service `workers` = profil MVP single-node (gabungan kebutuhan semua worker Bun). Umum: `NODE_ENV`, `LOG_LEVEL`, `SERVICE_VERSION`.

## 6. Rilis
1. CI: lint → typecheck → unit → contract → integration (compose) → build image → SBOM + scan → push (tag = git sha).
2. Staging deploy otomatis + smoke test (`bun run smoke`) + e2e.
3. Prod: manual approval → Helm upgrade (migrate hook) → rolling update → verifikasi SLO 30 menit → selesai / rollback `helm rollback`.
4. Migrasi DB harus **expand/contract** (backward compatible 1 versi).
5. Perubahan connector berisiko: deploy dengan routing rule `enabled=false` → verify → aktifkan bertahap (weight kecil dulu).

## 7. Backup & DR
| Data | RPO | RTO | Mekanisme |
|---|---|---|---|
| Postgres | 5 menit | 1 jam | PITR |
| ClickHouse | 24 jam | 4 jam | backup harian ke S3; data bisa sebagian di-rebuild dari raw archive (≤ retensi raw) |
| Redis | best effort | 15 menit | AOF + replika; kehilangan state queue ditoleransi (scheduler membuat ulang run jatuh tempo; dedupe mencegah duplikat) |
| S3 raw | — | — | versioning opsional |
DR drill tiap kuartal (RUNBOOK §8).

## 8. Sizing awal (untuk diuji, bukan janji)
Profil MVP: §3a. Profil Kubernetes — mulai: 3 node × 4 vCPU/16 GB untuk aplikasi; ClickHouse 1 node 8 vCPU/32 GB + disk SSD; Postgres 2 vCPU/8 GB; Redis 2 GB. Revisi setelah load test TESTING §6. **Catatan biaya:** profil Kubernetes ini berbiaya ratusan–ribuan USD/bln (tergantung cloud) — tidak tercakup angka infra COST_MODEL §5; hitung ulang sebelum migrasi.
