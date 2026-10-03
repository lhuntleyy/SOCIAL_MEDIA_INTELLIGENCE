# UI SPEC

## 1. Stack
- React + Vite (build via `bun run build`, kompat diverifikasi spike), TypeScript strict.
- Routing: TanStack Router (atau React Router — pilih setelah spike).
- Data: TanStack Query (cache per query key `[endpoint, params]`), invalidasi dari SSE.
- Chart: Apache ECharts (line, area/stacked area, bar/horizontal bar, pie, radar, **treemap**, word cloud via `echarts-wordcloud`, map via GeoJSON provinsi).
- Form: React Hook Form + Zod (schema dibagi dengan `apps/api/dto` via package `contracts`).
- Styling: Tailwind + komponen headless; tema merah/abu seperti screenshot, dark mode opsional.
- i18n: `id` default, `en` opsional.

## 2. Layout Global

```
┌───────────────────────────────────────────────────────────────────────────┐
│ [logo] PAGE TITLE   [Dashboard][Resume▾][Conversation▾][Audience▾][Psychography▾]  [user▾] │
├───────────────────────────────────────────────────────────────────────────┤
│ FILTERS: [Topic: X ✕] [Week ✕]      [All Platform ▾] [⏱ 15m ▾] [🔍] [⛃ filter] │
├───────────────────────────────────────────────────────────────────────────┤
│  Widget grid (12 kolom, responsive)                                        │
└───────────────────────────────────────────────────────────────────────────┘
```
Nav utama (dinamis, dropdown submenu — sesuai produk referensi): **Dashboard**, **Resume ▾**, **Conversation ▾** (Chronology, Gallery, Issues, Engagement, Emotion, Sentiment, Contributors, Issues Comparison), **Audience ▾**, **Psychography ▾**.
- Filter state disimpan di URL query string (`?topic=…&from=…&to=…&platforms=x,instagram&refresh=15m`) → shareable link.
- **Auto-refresh dropdown** (Off/5m/15m/30m/1h, keputusan pemilik 2026-10-03): `refetchInterval` layar (diingat per topik di browser, gratis — membaca DB). **Off = topik dijeda di server** (`POST /topics/{id}/pause`, untuk semua pengguna, tanpa biaya); memilih interval pada topik dijeda → `resume`; viewer tidak bisa menjeda. Pengambilan data mengikuti jadwal owner (Pengaturan → Batas & jadwal), juga saat dashboard tidak dibuka. Tombol **Ambil sekarang** (analis+, jeda 5 menit) + "Terakhir diambil …". SSE tetap aktif untuk update instan bila tersedia.
- Badge freshness di header: "Data terakhir: 29 detik lalu" (dari `meta.freshness`).
- Setiap widget: judul + ikon ⓘ (definisi metrik) + ⚙ (opsi: ganti tipe chart, export PNG/CSV, granularity).

## 3. Halaman

### 3.1 Topic & Account (`/topics`)
Kiri — **daftar topik**:
- Tab "ALL TOPIC", sort Asc/Desc, filter tipe (Topic/Account), tombol **Create**.
- Search dengan debounce 300 ms.
- Card: ikon, nama, query main (abu kecil), sub query (kotak merah muda), ikon author.
- Pagination: `Page 1 of 22 | 108 total`.

Kanan — **form** (tab):
1. **General**: Author (read-only), Topic Name, Description, Topic Platform (checkbox dinamis dari `GET /platforms` — **All Platform + Twitter, Instagram, Facebook, Youtube, Tiktok, Bluesky, Threads, Reddit**), refresh interval per platform (select **5m/15m/30m/45m/1h**, hanya menampilkan yang ≥ `min_interval_sec`), Taxonomy Type (Interest/Industry), Taxonomy (tag input + tombol +), Filter Ads (toggle).
2. **Query Lists** (per query, tombol **Add New Query** — sesuai screenshot 12):
   - **Platform** (select) + **Language** (checkbox: 🇬🇧 English / 🇮🇩 Indonesia / 🇲🇾 Malaysia).
   - **Query** (boolean) — syntax highlight `"frasa"`, `OR`, `AND`, `NOT`, kurung; validasi live (`POST /topics/validate-query`) → error dengan posisi karakter.
   - **Keyword** (tag input + tombol +) — keyword sederhana yang di-OR-kan ke query.
   - **Media Tags** / **Not Media Tags** (tag input + tombol +).
   - Tombol **Preview** → panel sampel post + estimasi volume.
3. **Demography Filter**: aktif (Psychography aktif default) — hanya memengaruhi **widget agregat** Psychography (mis. tampilkan breakdown gender/age tertentu). **Tidak** memfilter feed, daftar akun, atau export (memilih individu berdasarkan atribut hasil inferensi = penggunaan per-individu, dilarang ADR-007). Selalu tampilkan catatan coverage/confidence.

Tombol kanan atas: **Cancel**, **Clear**, **Preview**, **Save**.
- Sebelum Save: modal **Cost Estimate** (requests/hari per platform, % kuota tenant setelah aktif, warning `INTERVAL_CLAMPED`). Jika `QUOTA_WOULD_EXCEED` → Save disabled + saran interval.

### 3.1a Akun (`/accounts`) — pantau akun (2026-10-01)
Daftar pantauan (topik `kind=account`) + form: nama, deskripsi, baris *platform + username* (platform dari `GET /platforms` yang `operations_available` memuat `user_timeline`). Detail/analitik memakai halaman topik & seluruh halaman analitik (pemilih topik dikelompokkan Topik / Pantau akun).

### 3.2 Dashboard (`/dashboard`)
Grid sesuai screenshot ISA:
| Widget | Chart | Endpoint |
|---|---|---|
| Exposure | stacked area per platform | `/analytics/exposure` |
| Issues | word cloud (ukuran = score) | `/analytics/issues?mode=count` |
| Engagements History | line | `/analytics/engagement/history` |
| Issue Engagement | word cloud | `/analytics/issues?mode=engagement` |
| Total Posts | stat list per platform | `/analytics/totals?kind=posts` |
| Total Replies | stat list per platform | `/analytics/totals?kind=replies` |
| Topic Location | choropleth provinsi + legend list (+ baris "Tidak diketahui" & coverage) | `/analytics/locations` |
| Hashtags | treemap (ukuran = count) | `/analytics/hashtags?mode=count` |

Klik kata di word cloud / kotak treemap → membuka feed terfilter issue/hashtag tsb (drill-down). Klik provinsi → filter feed.

### 3.3 Conversation › Sentiment (`/conversation/sentiment`)
| Widget | Chart | Endpoint |
|---|---|---|
| Timeline | 3 line (positive biru, neutral abu, negative merah) | `/analytics/sentiment/timeline?mode=count` |
| Proportion | pie dengan label % | `/analytics/sentiment/proportion?mode=count` |
| Sentiment by Engagement | 3 line | `/analytics/sentiment/timeline?mode=engagement` |
| Proportion by Engagement | pie | `/analytics/sentiment/proportion?mode=engagement` |
| Sentiment Timeline (feed) | 3 kolom Neutral/Negative/Positive, infinite scroll | `/posts?sentiment=…` |

Post card: avatar, nama/handle, waktu lokal, teks (clamp 4 baris), media thumbnail, ikon platform, badge sumber label (model/LLM/manual). Menu `⋯` → **Ubah sentiment** (analyst+) → dialog alasan → `PATCH` → optimistic update.

### 3.4 Audience (`/audience`)
| Widget | Chart | Endpoint |
|---|---|---|
| Account Creation Year / User Created Time | bar per tahun + coverage % | `/analytics/accounts/age` |
| Posts per hari | bar | `/analytics/exposure` (sum) |
| Total Posts Comparison | bar (post vs comment) per bucket | `/analytics/totals/comparison` |
| Most Reposted Accounts | tabel paginated (username di-repost + count) | `/analytics/accounts/most-reposted` |
| Top Accounts (posts) | tabel paginated | `/analytics/accounts/top?by=posts` |
| Top Accounts Comment/Reply | horizontal bar | `/analytics/accounts/top?by=replies` |
| Top Account Retweet/Repost | horizontal bar | `/analytics/accounts/top?by=reposts` |
| Active Accounts | bar per hari | `/analytics/accounts/active` |

> "Top Account Retweet/Repost" = akun yang **melakukan** repost terbanyak (`agg_author_1d.reposts`); "Most Reposted Accounts" = akun yang **kontennya** paling banyak di-repost (`agg_reposted_author_1d`). Keduanya berbeda dan dua-duanya ada di produk.

### 3.4a Conversation › Emotion (`/conversation/emotion`)
| Widget | Chart | Endpoint |
|---|---|---|
| Perception Stream | stacked area 8 emosi | `/analytics/emotion/stream?mode=count` |
| Perception Radar | radar 8 emosi | `/analytics/emotion/radar?mode=count` |
| Emotion by Engagement | stacked area | `/analytics/emotion/stream?mode=engagement` |
| Perceptions by Engagement | pie | `/analytics/emotion/proportion?mode=engagement` |

### 3.4b Conversation › lainnya
| Halaman | Isi | Endpoint |
|---|---|---|
| Chronology | linimasa peristiwa/post kronologis | `/analytics/chronology` |
| Gallery | grid media (image proxy), filter sentiment/tipe | `/analytics/gallery` |
| Issues | word cloud + tabel issue | `/analytics/issues` |
| Engagement | line + breakdown | `/analytics/engagement/history` |
| Contributors | tabel akun berpengaruh | `/analytics/contributors` |
| Issues Comparison | dua periode berdampingan | `/analytics/issues/compare` |

### 3.4c Psychography (`/psychography`) — aktif default
| Widget | Chart | Endpoint |
|---|---|---|
| Sentiment by Gender (Male/Female) | 2 pie | `/analytics/psychography/gender?split=sentiment` |
| Sentiment by Age Range (Below 18 … Above 55) | treemap per bucket usia | `/analytics/psychography/age?split=sentiment` |
| Positive/Negative/Neutral Sentiment Timeline | line | `/analytics/sentiment/timeline` + filter `sentiment=` |
| Positive/… Text Cloud | word cloud | `/analytics/issues?sentiment=` |
| Positive/… Account | tabel | `/analytics/accounts/top?sentiment=` |
| Positive/… Hashtag Cloud | word cloud | `/analytics/hashtags?sentiment=` |

**Wajib**: setiap widget Psychography menampilkan `coverage_pct` + bucket `unknown`; tidak ada label gender/age di feed individu (SECURITY §9, AI_SPEC §12).

### 3.4d Resume (`/resume`)
Ringkasan/overview lintas widget (KPI utama + delta vs periode sebelumnya) untuk laporan cepat; sumber `/analytics/summary` + panel ringkas dari endpoint lain. Tombol export laporan (PDF/CSV, async). **Submenu Resume tidak terlihat penuh di screenshot — konfirmasi isi persisnya dengan pemilik produk.**

### 3.5 Alerts (`/alerts`)
Daftar event (open/acked/resolved), editor rule, channel notifikasi (secret field write-only dengan status "tersimpan").

### 3.6 Exports (`/exports`)
Riwayat export + status + link unduh (kedaluwarsa).

### 3.7 Admin — Providers (`/admin/providers`) — **platform_operator**
Tabel per platform (tab X / Instagram / Facebook / Threads / …, dinamis):

| Kolom | Kontrol |
|---|---|
| Connector (provider · kind badge official/third-party/unofficial) | — |
| Enabled | toggle (konfirmasi + audit) |
| Priority | number input / drag-and-drop antar grup |
| Weight | slider 0–1000 + % share efektif dalam grup |
| Capabilities | chip per operation: hijau verified, abu declared, merah failed; tombol **Verify** |
| Health | badge state + score + sparkline success rate; tombol **Run health check** |
| Circuit | closed/open/half-open + waktu probe berikut |
| Rate limit | ringkasan + sumber (docs/observed/internal) → drawer edit |
| Quota | progress bar used/limit per period → drawer edit |
| Accounts | jumlah aktif / butuh perhatian → drawer |

Fitur tambahan:
- **Routing simulator**: pilih tenant/platform/operation → tampilkan jejak eliminasi & keputusan (`/admin/routing-policies/simulate`).
- **Diff & confirm**: perubahan policy ditampilkan sebagai diff sebelum Save; konflik versi → prompt reload.
- **Accounts drawer**: tambah account (form credential write-only), rotasi, disable, status `needs_attention` dengan alasan (mis. `CHALLENGE_REQUIRED`).
- **Usage & Cost** (`/admin/usage`): chart request/result/cost unit per connector per hari; tabel per tenant.
- **Crawl Monitor** (`/admin/crawl`): run terakhir per plan, gagal beruntun, coalesced/skipped, lag per queue.
- **DLQ** (`/admin/dlq`): list, detail payload (redacted), redrive/discard.
- **Audit Log** (`/admin/audit`).

### 3.8 Settings
Tenant (timezone, retensi), Users & roles, API keys, Plan & usage.

## 4. State & Data Flow
```
URL filters ──► useFilters() ──► query keys
SSE /stream ──► on aggregates.updated → queryClient.invalidateQueries({ queryKey: ['analytics', topicId] })
Auto-refresh ──► refetchInterval (hanya saat tab visible); Off ──► pause topik
```
- `staleTime` analytics = 30 s; feed = 15 s.
- Error boundary per widget (satu widget gagal tidak menjatuhkan halaman) + tombol retry.
- Empty state yang jujur: "Belum ada data untuk platform ini" vs "Provider untuk platform ini sedang tidak tersedia" (dari `meta.freshness` + status platform).

## 5. RBAC di UI
| Elemen | viewer | analyst | admin | operator |
|---|---|---|---|---|
| Lihat dashboard | ✓ | ✓ | ✓ | ✓ |
| Buat/edit topik | | ✓ | ✓ | ✓ |
| Ubah sentiment | | ✓ | ✓ | ✓ |
| Backfill, user mgmt, BYO credential | | | ✓ | ✓ |
| Admin providers global | | | | ✓ |
UI hanya menyembunyikan; otorisasi final selalu di API.

## 6. Aksesibilitas & Performa
- Warna sentiment tidak jadi satu-satunya pembeda (ikon/label juga).
- Kontras WCAG AA; navigasi keyboard untuk form dan tabel admin.
- Bundle split per route; chart lazy-loaded; target LCP < 2.5 s di koneksi 4G (diukur Lighthouse CI).
- Feed virtualized list.

## 7. Cakupan Screenshot (checklist QA)

Verifikasi tiap panel di 13 screenshot referensi punya "rumah". Tidak boleh ada panel tanpa halaman.

| Screenshot | Isi | Halaman di kita |
|---|---|---|
| 1 | Exposure, Issues, Engagements History, Issue Engagement | Dashboard (§3.2) |
| 2 | Total Posts, Total Replies, Topic Location | Dashboard (§3.2) |
| 3 | Sentiment proportion, sentiment by engagement | Conversation › Sentiment (§3.3) |
| 4 | Perception stream/radar, emotion by engagement | Conversation › Emotion (§3.4a) |
| 5 | Hashtag treemap, user created time, posts comparison, most retweeted | Dashboard (treemap) + Audience (§3.4) |
| 6 | Top accounts comment/reply, top retweet, active accounts | Audience (§3.4) |
| 7 | Nav bar + dropdown Conversation | Shell (§2) + Conversation (§3.4b) |
| 8 | Sentiment timeline, proportion, feed 3 kolom | Conversation › Sentiment (§3.3) |
| 9 | Sentiment by gender, by age range | Psychography (§3.4c) |
| 10 | Age range lanjut; positive timeline/text cloud/account/hashtag cloud | Psychography (§3.4c) |
| 11 | Topic & Account — tab General | Topic page (§3.1) |
| 12 | Topic & Account — tab Query Lists | Topic page (§3.1) |
| 13 | Dashboard + dropdown refresh interval | Dashboard + filter bar (§2) |

Tidak ada panel yang tidak terpetakan.
