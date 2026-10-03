# API SPEC (v1)

- Base URL: `https://{host}/v1`
- Format: JSON UTF-8; waktu ISO-8601 UTC.
- Auth: `Authorization: Bearer <access_jwt>` (user) atau `X-API-Key: <key>` (integrasi).
- Tenant: dari token (`tid` claim). Operator bisa `X-Tenant-Id` untuk impersonasi (diaudit).
- Kontrak di-generate dari Zod → OpenAPI 3.1 di `GET /v1/openapi.json`.

## 1. Konvensi

### 1.1 Envelope sukses
```json
{ "data": { }, "meta": { "request_id": "req_0192…" } }
```
List:
```json
{
  "data": [ ],
  "meta": { "request_id": "req_…", "page": { "next_cursor": "eyJ…", "limit": 20, "total": 108 } }
}
```
`total` hanya disertakan bila murah dihitung (Postgres list); feed ClickHouse memakai cursor tanpa total.

### 1.2 Envelope error
```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Query tidak valid",
    "details": [{ "path": "queries[0].query_text", "issue": "Tanda kutip tidak ditutup pada posisi 14" }],
    "request_id": "req_0192…"
  }
}
```
| HTTP | code |
|---|---|
| 400 | `VALIDATION_FAILED`, `INVALID_QUERY` |
| 401 | `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `MFA_REQUIRED` (OTP wajib/salah saat login) |
| 403 | `FORBIDDEN`, `PLAN_LIMIT`, `MFA_SETUP_REQUIRED` (token owner/admin/operator tanpa MFA hanya boleh `/me`, `/me/mfa/*`, `/auth/logout`) |
| 404 | `NOT_FOUND` |
| 409 | `CONFLICT`, `VERSION_MISMATCH` |
| 422 | `QUOTA_WOULD_EXCEED` |
| 429 | `RATE_LIMITED` (+ header `Retry-After`) |
| 500 | `INTERNAL` |
| 503 | `UNAVAILABLE` |

### 1.3 Pagination, filter, idempotency
- Cursor: `?limit=20&cursor=…` (opaque base64url).
- Write endpoint menerima `Idempotency-Key` header (disimpan 24 jam di Redis).
- Optimistic locking pada resource config: field `version`; kirim `If-Match: "<version>"`.

### 1.4 Parameter analytics umum
| Param | Tipe | Keterangan |
|---|---|---|
| `topic_id` | uuid | wajib |
| `from`, `to` | datetime | wajib; maks range per plan |
| `granularity` | `auto|5m|1h|1d` | default `auto` (PRD FR-D01) |
| `platforms` | csv | default semua platform topik |
| `tz` | IANA tz | default timezone tenant (untuk bucket harian) |

---

## 2. Auth

| Method | Path | Role | Keterangan |
|---|---|---|---|
| POST | `/auth/login` | public | email+password (+ `otp` jika MFA) |
| POST | `/auth/refresh` | public (cookie) | rotasi refresh token |
| POST | `/auth/logout` | user | revoke family |
| GET | `/me` | user | profil + memberships |
| POST | `/me/mfa/setup`, `/me/mfa/verify` | user | TOTP |

`POST /auth/login`
```json
// request
{ "email": "analyst@contoh.id", "password": "••••••••", "otp": "123456", "tenant_id": "0192…(opsional; default tenant pertama)" }
// 200
{ "data": { "access_token": "eyJ…", "expires_in": 900, "token_type": "Bearer", "mfa": "ok|setup_required",
            "user": { "id": "0192…", "name": "Analyst", "email": "analyst@contoh.id" },
            "tenants": [{ "id": "0192…", "name": "Contoh Org", "role": "analyst" }] },
  "meta": { "request_id": "req_…" } }
```
Refresh token dikirim **hanya** sebagai cookie `smip_rt` (`HttpOnly; Secure; SameSite=Strict; Path=/v1/auth`, 14 hari, dirotasi tiap `/auth/refresh`; token lama dipakai ulang → seluruh family dicabut). Access JWT EdDSA 15 menit, klaim `sub, tid, role, op, mfa, jti`. Email salah & password salah memberi pesan identik (anti enumerasi); lockout bertahap per akun (5 gagal → 60 s, berlipat, maks 1 jam) + 50 percobaan/15 menit per IP → `429` + `Retry-After`. Implementasi: `apps/api/src/{auth,routes/auth.ts}` (F-09).

---

## 3. Platforms & Taxonomy

`GET /platforms` → daftar dari tabel `platforms` (UI tidak hardcode):
```json
{ "data": [
  { "code": "x", "name": "Twitter / X", "icon": "twitter", "enabled": true,
    "operations_available": ["search_keyword", "user_timeline"], "min_interval_sec": 300 },
  { "code": "instagram", "name": "Instagram", "icon": "instagram", "enabled": true,
    "operations_available": ["search_hashtag", "search_keyword"], "min_interval_sec": 900 }
] }
```
`operations_available` & `min_interval_sec` dihitung dari routing policy + capability **verified** untuk tenant ini (implementasi 2026-10-01: `user_timeline` = platform yang bisa dipakai menu Akun).

**Pantau akun (menu Akun, 2026-10-01):** `POST /topics` dengan `kind: "account"` — tiap query `{"query_text": "@username", "platforms": ["tiktok"]}` (tepat satu platform); server memaksa operation `user_timeline`; `GET /topics?kind=topic|account`; `kind` tidak bisa diubah lewat PATCH.

`GET /taxonomies?type=interest` · `POST /taxonomies` · `DELETE /taxonomies/{id}`

---

## 4. Topics

| Method | Path | Role |
|---|---|---|
| GET | `/topics?search=&status=&sort=name:asc&type=&limit=&cursor=` | viewer+ |
| POST | `/topics` | analyst+ |
| GET | `/topics/{id}` | viewer+ |
| PATCH | `/topics/{id}` | analyst+ |
| DELETE | `/topics/{id}` (archive) | admin+ |
| POST | `/topics/{id}/pause` · `/resume` | analyst+ |
| PUT | `/topics/{id}/speed` `{interval_sec: 300…86400 \| null}` — kontrol **Update data**: kecepatan pengambilan topik untuk semua platform (dibatasi kecepatan tercepat platform dari Pengaturan owner → warning `INTERVAL_CLAMPED` reason `platform_max_speed`); `null` = jeda; memilih angka melanjutkan topik yang dijeda | analyst+ |
| POST | `/topics/{id}/fetch-now` → 202 `{platforms, cooldown_until}` — **Ambil sekarang**: plan aktif (+ collection stream yang melayani) dijadwalkan segera; plan yang diambil < 5 menit lalu dilewati; topik dijeda → 409 | analyst+ |
| POST | `/topics/validate-query` | analyst+ |
| POST | `/topics/preview` | analyst+ |
| POST | `/topics/cost-estimate` | analyst+ |
| POST | `/topics/{id}/backfill` | admin+ |
| GET | `/topics/{id}/runs?platform=&status=&limit=` | analyst+ |

`POST /topics`
```json
{
  "name": "PERMASALAHAN KDMP",
  "description": "Monitoring isu Koperasi Desa Merah Putih",
  "platforms": [
    { "code": "x", "interval_sec": 900 },
    { "code": "instagram", "interval_sec": 1800 },
    { "code": "threads", "interval_sec": 1800 },
    { "code": "facebook", "interval_sec": 3600 }
  ],
  "taxonomy_type": "interest",
  "taxonomy_ids": ["0192…"],
  "filter_ads": true,
  "language_hints": ["id"],
  "queries": [
    { "kind": "main", "query_text": "\"KDMP\" OR \"koperasi merah putih\" OR \"kopdes merah putih\"",
      "keywords": ["kopdes"], "languages": ["id"], "media_tags": [], "not_media_tags": [] },
    { "kind": "sub", "label": "Kades", "query_text": "\"kades\" AND (\"KDMP\" OR \"koperasi\")",
      "languages": ["id", "ms"], "platforms": ["x", "facebook"] }
  ]
}
```
201:
```json
{
  "data": {
    "id": "0192…",
    "name": "PERMASALAHAN KDMP",
    "status": "active",
    "author": { "id": "0192…", "name": "Analyst" },
    "platforms": [
      { "code": "x", "interval_sec": 900, "effective_interval_sec": 900, "enabled": true },
      { "code": "instagram", "interval_sec": 1800, "effective_interval_sec": 1800, "enabled": true }
    ],
    "queries": [{ "id": "0192…", "kind": "main", "query_text": "…", "ast_version": 1 }],
    "cost_estimate": { "requests_per_day": 1152, "results_per_day": 2100, "usd_per_day": 1.42, "unverified_rates": ["instagram"],
                       "by_platform": { "x": { "requests": 384, "results": 1820, "usd": 0.33 }, "instagram": { "requests": 192, "results": 140, "usd": 0.21 } },
                       "quota_after_pct": { "tenant_monthly": 41.2 } },
    "version": 1,
    "created_at": "2026-09-27T10:00:00Z"
  },
  "meta": { "request_id": "req_…" }
}
```
Jika `effective_interval_sec` > yang diminta (karena plan/capability), response menyertakan `warnings: [{ "code": "INTERVAL_CLAMPED", "platform": "instagram", "reason": "min_interval_of_available_connectors" }]`.

`POST /topics/validate-query`
```json
// req
{ "query_text": "(\"demo\" OR \"unras\") AND NOT \"2025\"", "keywords": ["unjuk rasa"], "languages": ["id"] }
// 200
{ "data": { "valid": true, "ast": { "type": "and", "children": [ … ] },
            "positive_terms": ["demo", "unras", "unjuk rasa"], "languages": ["id"],
            "normalized": "((\"demo\" OR \"unras\" OR \"unjuk rasa\")) AND NOT \"2025\"" } }
```

`POST /topics/preview` — menguji AST terhadap data yang **sudah ada** di ClickHouse (7 hari, tenant scope + konten global publik), tidak memanggil provider:
```json
{ "data": { "sample": [ { "platform": "x", "post_id": "…", "text": "…", "published_at": "…" } ],
            "estimated_matches_per_day": { "x": 1820, "instagram": 140 },
            "note": "Estimasi dari data yang sudah terindeks; volume nyata bisa berbeda." } }
```

`POST /topics/{id}/backfill`
```json
{ "from": "2026-08-20T00:00:00Z", "to": "2026-08-27T00:00:00Z", "platforms": ["x"] }
// 202
{ "data": { "backfill_id": "0192…", "runs_created": 7, "status": "queued" } }
```

`GET /topics/{id}/runs` item:
```json
{ "id": "0192…", "platform": "x", "operation": "search_keyword", "status": "succeeded",
  "scheduled_for": "…", "finished_at": "…", "items_fetched": 142, "items_new": 61,
  "attempts": [{ "no": 1, "connector": "twitterapi_io.x", "outcome": "failover_error", "error_code": "RATE_LIMITED", "duration_ms": 812 },
               { "no": 2, "connector": "apify.x", "outcome": "success", "duration_ms": 41934 }] }
```

---

## 5. Analytics (semua baca tabel `agg_*`)

| Method | Path | Widget |
|---|---|---|
| GET | `/analytics/exposure` | Exposure (per platform per bucket) |
| GET | `/analytics/sentiment/timeline?mode=count\|engagement` | Sentiment / Sentiment by Engagement (timeline) |
| GET | `/analytics/sentiment/proportion?mode=count\|engagement` | Proportion / Proportion by Engagement (pie) |
| GET | `/analytics/emotion/stream?mode=count\|engagement` | Perception Stream (8 emosi stacked area) |
| GET | `/analytics/emotion/radar?mode=count\|engagement` | Perception Radar |
| GET | `/analytics/emotion/proportion?mode=count\|engagement` | Perceptions (pie) |
| GET | `/analytics/issues?mode=count\|engagement&sentiment=&limit=50` | Issues / Issue Engagement / per-sentiment Text Cloud |
| GET | `/analytics/hashtags?mode=count\|engagement&sentiment=&limit=50` | Hashtags treemap / Hashtag Cloud / per-sentiment |
| GET | `/analytics/issues/compare?from_a=&to_a=&from_b=&to_b=` | Issues Comparison |
| GET | `/analytics/engagement/history` | Engagements History |
| GET | `/analytics/totals?kind=posts\|replies` | Total Posts / Replies per platform |
| GET | `/analytics/totals/comparison` | Total Posts Comparison (post vs comment per bucket) |
| GET | `/analytics/locations?level=province` | Topic Location |
| GET | `/analytics/psychography/gender?split=sentiment` | Sentiment by Gender (Male/Female) |
| GET | `/analytics/psychography/age?split=sentiment` | Sentiment by Age Range |
| GET | `/analytics/accounts/top?by=posts\|replies\|reposts\|engagement&sentiment=&limit=10` | Top Accounts (+ per-sentiment di Psychography; dari `agg_author_1d` yang kini punya dimensi sentiment) |
| GET | `/analytics/accounts/most-reposted?limit=10` | Most Reposted Accounts (penulis asli paling banyak di-repost) |
| GET | `/analytics/accounts/active` | Active Accounts per bucket |
| GET | `/analytics/accounts/age` | Histogram tahun pembuatan akun |
| GET | `/analytics/contributors?by=influence\|posts\|engagement&limit=50` | Contributors. `influence` = `engagement_diterima × log10(1 + followers)` dari `agg_author_1d` (followers `null` → dihitung tanpa faktor followers & ditandai) |
| GET | `/analytics/chronology` | Chronology: per bucket, volume (`agg_topic_*`) + top-3 post engagement tertinggi (`topic_matches FINAL`, dibatasi window & LIMIT) |
| GET | `/analytics/gallery?sentiment=&media_type=&limit=&cursor=` | Gallery (grid media) |
| GET | `/analytics/summary` | Resume / ringkasan KPI (total, delta vs periode sebelumnya) |

Semua endpoint: parameter umum §1.4 berlaku; `sentiment=`/`mode=`/`split=` opsional. **Wajib** menyertakan `coverage_pct` pada respons `psychography/*` (banyak akun `unknown`).

`GET /analytics/exposure?topic_id=…&from=2026-08-25T00:00:00+07:00&to=2026-09-01T23:59:59+07:00&granularity=1d`
```json
{
  "data": {
    "granularity": "1d",
    "buckets": ["2026-08-25", "2026-08-26", "2026-08-27"],
    "series": [
      { "platform": "x", "values": [820, 640, 3410] },
      { "platform": "threads", "values": [110, 180, 260] },
      { "platform": "tiktok", "values": [20, 35, 41] }
    ],
    "definition": "Jumlah post yang match topik per bucket (bukan reach)."
  },
  "meta": { "request_id": "req_…", "freshness": { "last_ingested_at": "2026-09-27T09:59:31Z", "lag_sec": 29 } }
}
```

`GET /analytics/sentiment/proportion`
```json
{ "data": { "total": 12763,
  "items": [ { "sentiment": "negative", "count": 10523, "pct": 82.45 },
             { "sentiment": "positive", "count": 1387,  "pct": 10.87 },
             { "sentiment": "neutral",  "count": 853,   "pct": 6.68 } ],
  "model_versions": ["sent-id-v3"], "human_overrides": 14 } }
```

`GET /analytics/issues?mode=count`
```json
{ "data": { "items": [
  { "issue": "gedung dpr", "count": 1840, "score": 0.93, "engagement": 90412 },
  { "issue": "elemen mahasiswa", "count": 1211, "score": 0.81, "engagement": 40211 } ] } }
```

`GET /analytics/locations`
```json
{ "data": { "level": "province", "coverage_pct": 41.3,
  "items": [ { "code": "33", "name": "Jawa Tengah", "count": 5104 },
             { "code": "31", "name": "DKI Jakarta", "count": 5054 } ] } }
```

`GET /analytics/accounts/top?by=replies`
```json
{ "data": { "items": [
  { "platform": "x", "author_id": "…", "handle": "bang_jack_magelang", "value": 3, "profile_url": "https://x.com/bang_jack_magelang" } ] } }
```

`GET /analytics/accounts/age`
```json
{ "data": { "coverage_pct": 63.0, "items": [ { "year": 2009, "authors": 452 }, { "year": 2010, "authors": 531 } ] } }
```

`GET /analytics/emotion/stream?mode=count`
```json
{ "data": {
  "granularity": "1d",
  "buckets": ["2026-08-27", "2026-08-28"],
  "series": [
    { "emotion": "anger",        "values": [3210, 4180] },
    { "emotion": "anticipation", "values": [1650, 1720] },
    { "emotion": "trust",        "values": [90, 110] }
  ],
  "definition": "Jumlah post per emosi dominan per bucket." } }
```

`GET /analytics/psychography/gender?split=sentiment`
```json
{ "data": {
  "coverage_pct": 58.4,
  "groups": [
    { "gender": "male",   "total": 4102, "sentiment": { "negative": 2873, "neutral": 496, "positive": 733 } },
    { "gender": "female", "total": 2210, "sentiment": { "negative": 1837, "neutral": 92,  "positive": 281 } }
  ],
  "unknown_pct": 41.6,
  "method": "name_lexicon+profile", "model_version": "gender-id-v1",
  "note": "Agregat inferensi; akun unknown tidak dihitung ke kelas gender." } }
```

`GET /analytics/hashtags?mode=count&limit=5`
```json
{ "data": { "items": [
  { "hashtag": "Kopdes", "count": 469, "engagement": 30211 },
  { "hashtag": "MiladKetumPAN", "count": 148, "engagement": 8123 } ] } }
```

`GET /analytics/accounts/most-reposted?limit=3`
```json
{ "data": { "items": [
  { "platform": "x", "author_id": "…", "handle": "BBCIndonesia", "reposted_count": 5020 },
  { "platform": "x", "author_id": "…", "handle": "ObiWan_Catnobi", "reposted_count": 2437 } ] } }
```

`GET /analytics/gallery?sentiment=negative&limit=2`
```json
{ "data": {
  "items": [
    { "platform": "x", "post_id": "18300…", "media_type": "image",
      "media_url": "https://media-proxy.internal/…", "thumb_url": "https://media-proxy.internal/…?w=240",
      "published_at": "2026-09-01T02:19:55Z", "sentiment": "negative" }
  ],
  "meta_note": "media_url selalu via image proxy internal (SECURITY §7)." },
  "meta": { "request_id": "req_…", "page": { "next_cursor": "eyJ…", "limit": 2 } } }
```

---

## 6. Posts / Feed

| Method | Path | Role |
|---|---|---|
| GET | `/posts?topic_id=&from=&to=&sentiment=&platforms=&q=&sort=published_at:desc&limit=&cursor=` | viewer+ |
| GET | `/posts/{platform}/{post_id}?topic_id=` | viewer+ |
| PATCH | `/posts/{platform}/{post_id}/sentiment` | analyst+ |

Item feed:
```json
{
  "platform": "x", "post_id": "18300…", "url": "https://x.com/…/status/18300…",
  "content_type": "repost", "text": "RT @regar_op0sisi: 8 dosa …",
  "published_at": "2026-09-01T02:19:55Z",
  "author": { "handle": "flyhigher", "name": "Fly higher", "avatar_url": "https://…" },
  "sentiment": { "label": "negative", "score": 0.94, "source": "model", "model_version": "sent-id-v3" },
  "issues": ["dosa pemerintahan", "tata kelola"],
  "metrics": { "likes": 12, "comments": null, "shares": 3, "views": null },
  "geo": { "code": "31", "name": "DKI Jakarta", "confidence": 0.5 },
  "media": [{ "type": "image", "url": "https://…" }]
}
```
`PATCH …/sentiment`
```json
// req
{ "topic_id": "0192…", "label": "neutral", "reason": "Berita tanpa opini" }
// 200
{ "data": { "label": "neutral", "source": "human", "previous": "negative", "override_id": "0192…" } }
```

---

## 7. Realtime (SSE)

`POST /stream/ticket` `{ "topic_id": "…" }` (Bearer) → 204 + `Set-Cookie: sse_ticket=…; HttpOnly; Secure; SameSite=Strict; Path=/v1/stream; Max-Age=900`.

`GET /stream?topic_id=…` (`Accept: text/event-stream`) — **auth via cookie `sse_ticket` saja** (cookie refresh ber-`Path=/v1/auth` tidak terkirim ke sini — SECURITY §7). `EventSource` browser tidak bisa mengirim header `Authorization`, dan token **dilarang** ditaruh di query string (SECURITY: no PII/secret di URL). Integrasi non-browser boleh pakai `Authorization: Bearer` (bisa set header sendiri).
```
event: aggregates.updated
id: 1727431200000-1
data: {"topic_id":"0192…","platforms":["x"],"buckets":["2026-09-27T09:55:00Z"]}

event: heartbeat
data: {}
```
Client merespons dengan invalidasi query TanStack terkait (tidak mengirim data berat via SSE). Heartbeat 25 s — **server SSE wajib `Bun.serve({ idleTimeout: 0 })`** (atau heartbeat < 10 s): default Bun memutus koneksi yang diam 10 s (terbukti S-02).

---

## 8. Alerts, Notifications, Exports

| Method | Path |
|---|---|
| GET/POST | `/alert-rules` |
| PATCH/DELETE | `/alert-rules/{id}` |
| GET | `/alert-events?status=open` |
| POST | `/alert-events/{id}/ack` · `/resolve` |
| GET/POST | `/notification-channels` (secret write-only) |
| POST | `/exports` → 202 `{ "export_id": "…", "status": "queued" }` |
| GET | `/exports/{id}` → `{ "status": "done", "download_url": "<presigned, 24h>" }` |

Contoh alert rule:
```json
{ "type": "negative_ratio", "topic_id": "0192…",
  "params": { "window": "1h", "threshold_pct": 70, "min_posts": 200 },
  "channels": ["0192…"], "cooldown_sec": 3600, "enabled": true }
```

---

## 9. Admin — Provider Management (`platform_operator`; sebagian tenant `admin` untuk BYO)

| Method | Path | Keterangan |
|---|---|---|
| GET | `/admin/platforms` · PATCH `/admin/platforms/{code}` | pengaturan per platform: `max_items_per_run` (1–1000, `null` = bawaan) — migrasi 0023 |
| GET | `/admin/providers` | list + agregat health |
| PATCH | `/admin/providers/{id}` | `enabled`, `risk_level`, `notes` |
| GET | `/admin/connectors?platform=&provider=` | list + capabilities + health |
| GET | `/admin/connectors/{id}` | detail |
| PATCH | `/admin/connectors/{id}` | `enabled`, `config` (divalidasi `config_schema`), `health` params |
| POST | `/admin/connectors/{id}/health-check` | enqueue `health.probe` → 202 |
| POST | `/admin/connectors/{id}/verify` | enqueue `connector.verify` → 202 |
| GET | `/admin/accounts?provider=&status=` | tanpa secret |
| POST | `/admin/accounts` | buat account + credential (secret write-only) |
| PATCH | `/admin/accounts/{id}` | `enabled/status`, `label`, `allowed_connector_ids` |
| PUT | `/admin/accounts/{id}/credential` | rotasi credential |
| DELETE | `/admin/accounts/{id}` | revoke (hapus kriptografis: DEK dihapus) |
| GET | `/admin/routing-policies?platform=&operation=&tenant_id=` | |
| PUT | `/admin/routing-policies/{id}` | replace rules (atomic, versioned) |
| POST | `/admin/routing-policies/simulate` | dry-run seleksi router |
| GET/POST/PATCH | `/admin/rate-limits` | policy rate limit |
| GET/POST/PATCH | `/admin/quotas` | policy quota |
| GET | `/admin/usage?group_by=connector|account|tenant&from=&to=` | ledger usage |
| GET | `/admin/dlq/{queue}` · POST `/admin/dlq/{queue}/{job_id}/redrive` · DELETE | DLQ |
| GET | `/admin/audit-logs?target_type=&actor=&from=&to=` | |

`GET /admin/connectors?platform=instagram`
```json
{ "data": [
  {
    "id": "0192…", "key": "apify.instagram", "provider": { "key": "apify", "kind": "third_party", "enabled": true },
    "platform": "instagram", "runtime": "bun", "version": "1.2.0", "enabled": true,
    "capabilities": [
      { "operation": "search_hashtag", "status": "verified", "verified_at": "2026-10-02T03:00:00Z",
        "measured": { "p95_latency_ms": 41000, "min_interval_sec": 900 }, "evidence_ref": "s3://…/verify-….json" },
      { "operation": "search_keyword", "status": "declared", "verified_at": null }
    ],
    "health": [
      { "account_id": "0192…", "account_label": "apify-pool-1", "state": "healthy", "circuit": "closed",
        "score": 96, "success_rate_5m": 0.98, "p95_latency_ms": 38000, "last_error_code": null }
    ],
    "rate_limits": [ { "scope": "provider_account", "algorithm": "token_bucket", "capacity": 10,
                       "refill_tokens": 10, "refill_interval_ms": 60000, "source": "internal_safety",
                       "source_ref": "Belum ada angka resmi; nilai konservatif operator 2026-10-02" } ],
    "quota": [ { "scope": "connector", "period": "month", "unit": "results", "limit": 500000, "used": 121044, "hard": true } ]
  }
] }
```

`POST /admin/accounts`
```json
// req
{ "provider_id": "0192…", "label": "apify-pool-1", "tenant_id": null,
  "credential": { "kind": "api_key", "secret": { "token": "apify_api_…" } },
  "allowed_connector_ids": null }
// 201 — secret TIDAK dikembalikan
{ "data": { "id": "0192…", "label": "apify-pool-1", "status": "active", "display_hint": "••••9f2c",
            "credential": { "kind": "api_key", "created_at": "…" } } }
```

`PUT /admin/routing-policies/{id}`
```json
// header If-Match: "4"
{
  "strategy": "priority_weighted", "failover_enabled": true, "max_attempts": 3, "allow_unverified": false, "enabled": true,
  "rules": [
    { "connector_id": "…threads_api.threads", "priority": 1, "weight": 100, "enabled": true },
    { "connector_id": "…apify.threads",       "priority": 2, "weight": 70,  "enabled": true, "max_share_pct": null },
    { "connector_id": "…other.threads",       "priority": 2, "weight": 30,  "enabled": true },
    { "connector_id": "…instagrapi.threads",  "priority": 3, "weight": 0,   "enabled": false }
  ]
}
// 200 → { "data": { "id": "…", "version": 5, … } }  |  409 VERSION_MISMATCH
```

`POST /admin/routing-policies/simulate`
```json
// req
{ "tenant_id": "0192…", "platform": "instagram", "operation": "search_hashtag", "run_kind": "incremental",
  "interval_sec": 900, "exclude_connector_ids": [] }
// 200
{ "data": {
  "decision": { "kind": "selected", "connector_key": "apify.instagram", "account_label": "apify-pool-1" },
  "trace": [
    { "connector_key": "meta_graph.instagram", "eliminated_by": "CAPABILITY_NOT_VERIFIED" },
    { "connector_key": "apify.instagram", "priority": 2, "effective_weight": 96, "eligible_accounts": 2 },
    { "connector_key": "instagrapi.instagram", "eliminated_by": "RULE_DISABLED" }
  ] } }
```
Simulate **tidak** mengonsumsi token/quota (read-only peek).

---

### 9.1 Pengaturan LLM (Fase 3, A-03) — operator
Provider = baris DB; `kind` = protokol API: `gemini`, `openai_compatible` (OpenAI, OpenRouter, vLLM/Ollama/custom — `base_url` wajib, lolos SSRF guard), `anthropic`.

| Method | Path | Keterangan |
|---|---|---|
| GET | `/admin/llm` | provider + key (tanpa secret: label, `display_hint`, status, cooldown, error terakhir, jumlah request) + pemetaan tugas |
| POST | `/admin/llm/providers` | `{key, name, kind, base_url?, api_key?, key_label?}` |
| PATCH/DELETE | `/admin/llm/providers/{id}` | ubah nama/base_url/aktif · hapus (semua key di-crypto-shred) |
| POST | `/admin/llm/providers/{id}/keys` | tambah API key (banyak key per provider → rotasi; 429 → cooldown 60 s; key salah → `invalid`) |
| PATCH/DELETE | `/admin/llm/keys/{id}` | aktif/nonaktif · cabut (crypto-shred) |
| GET · POST | `/admin/llm/providers/{id}/models` · `…/models/refresh` | katalog model dari API provider (dropdown panel) |
| POST | `/admin/llm/test` | `{provider_id, model_id, text?, topic?}` → klasifikasi sentimen contoh (JSON terstruktur, token, latensi) |
| PUT | `/admin/llm/tasks/{default\|sentiment\|emotion\|keyphrase\|summary}` | `{provider_id, model_id, fallback_provider_id?, fallback_model_id?, enabled, params?}` — model wajib ada di katalog |

### 9.2 Batas & jadwal (owner, 2026-10-03)
| Rute | Catatan |
|---|---|
| `GET /admin/settings` | `{values, defaults, overridden}` — kunci: `topics.initial_backfill_days`, `comments.enabled`, `comments.top_posts_per_day`, `comments.max_pages_per_post`, `comments.refetch_hours`, `comments.max_post_age_days` |
| `PUT /admin/settings` `{values: {key: value \| null}}` | null = kembali ke default; kunci tak dikenal / di luar rentang → 400; diaudit `settings.update` |
| `PATCH /admin/platforms/{code}` `{max_items_per_run?, crawl_interval_sec?}` | interval 60–86.400 s berlaku ke **semua** plan & stream platform itu; interval per-topik dilepas; null = bawaan topik |
| `GET /admin/connectors` | + `config_fields` (properti angka/boolean config connector yang bisa diatur; schema lengkap tetap tidak dikirim) |

## 10. Admin — Tenant & User

`GET/POST /admin/tenants`, `PATCH /admin/tenants/{id}` (plan, status), `GET/POST /users`, `PATCH /users/{id}`, `POST /users/{id}/memberships`, `DELETE /users/{id}/memberships/{tenant_id}`, `GET/POST/DELETE /api-keys`.

Implementasi F-10 (`apps/api/src/{admin,routes/admin.ts}`), aturan yang berlaku:
| Rute | Siapa | Catatan |
|---|---|---|
| `/admin/tenants*` | operator (JWT, bukan API key) | slug unik → 409 |
| `GET /users` | admin+ tenant | hanya anggota tenant (users ber-RLS) |
| `POST /users` `{email,name,role,password?}` | admin+; role `owner` hanya oleh owner/operator | user baru → `status: invited` + `invite_token` (sekali pakai, 72 jam, **ditampilkan sekali**); **dengan `password` (≥ 12)** → langsung `active`, tanpa token; user lama → hanya membership (password lama tidak diubah, `password_ignored: true`) |
| `POST /users/{id}/password` `{password?}` | admin+ tenant sendiri | dengan `password` → diganti langsung; tanpa → `reset_token` (link sekali pakai 72 jam). **Ditolak (403)** bila user juga anggota kantor lain atau owner platform (cegah pengambilalihan lintas kantor); owner kantor hanya oleh owner. Sesi (refresh token) user dicabut; diaudit `user.password_set` / `user.password_reset_link` |
| `POST /auth/accept-invite` `{token,password≥12}` | publik | token undangan (user `invited`) **atau** token reset (user `active`) → set password; reset juga mencabut sesi lama |
| `GET/POST /admin/owners`, `DELETE /admin/owners/{id}` | owner platform | owner platform = `is_platform_operator`, anggota tenant internal `kind='platform'` (migrasi 0022, tidak tampil di daftar kantor); login owner masuk ke tenant platform; data kantor dilihat via impersonasi. Tidak bisa mencabut diri sendiri; owner terakhir → 409 |
| `GET /admin/users` | owner platform | semua user non-owner + daftar kantor & peran |
| `POST /admin/users/{id}/password` `{password?}` | owner platform | seperti di atas, lintas kantor |
| `GET /admin/tenants/{id}/users` | owner platform | user satu kantor (tanpa owner platform) |
| `PATCH /users/{id}` `{role?, status?}` | admin+; mengubah/menetapkan owner hanya owner/operator; `status` (global) hanya operator | owner terakhir tidak bisa diturunkan → 409 |
| `POST /users/{id}/memberships` | operator | lintas tenant |
| `DELETE /users/{id}/memberships/{tenant_id}` | admin+ tenant sendiri (tenant lain → 404) atau operator | owner terakhir → 409 |
| `/api-keys` | admin+ (manusia saja) | secret `smip_<prefix8>_<43 char>` hanya ditampilkan saat dibuat; DB simpan SHA-256; scope: `analytics:read, topics:read/write, posts:read/write, exports:write, alerts:read/write`; scope `*:write` → peran analyst, selain itu viewer |

**Header auth tambahan:** `X-API-Key: smip_…` (integrasi; tidak boleh ke rute pengelolaan akses). **Impersonasi operator:** `X-Tenant-Id: <uuid>` + `X-Impersonation-Reason: <≥10 karakter>` → bertindak sebagai `admin` di tenant tsb; setiap request diaudit (`operator.impersonate`, alasan tersimpan). Non-operator/API key → 403.

## 11. Ops

| Path | Auth | Keterangan |
|---|---|---|
| `GET /healthz` | none | proses hidup |
| `GET /readyz` | none | DB, Redis, ClickHouse reachable |
| `GET /metrics` | network-internal only | Prometheus text |
| `GET /v1/openapi.json` | user | spesifikasi |

## 12. Rate limit API
Per user/API key: token bucket (nilai di config `API_RATE_LIMIT_*`). Header response: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`.
