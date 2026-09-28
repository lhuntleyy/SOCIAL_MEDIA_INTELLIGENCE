# Arsitektur Sistem

Dokumen pendamping [PRD.md](../PRD.md). Fokusnya bagaimana sistem dibangun dan kenapa dibangun seperti itu.

---

## 1. Gambaran Umum

```
┌──────────────────────────────────────────────────────────┐
│  apps/web — Next.js 15 (App Router, TypeScript)          │
│  Dashboard · Sentiment · Topic Admin · Auth              │
└───────────────────────┬──────────────────────────────────┘
                        │ REST (typed client)
┌───────────────────────▼──────────────────────────────────┐
│  services/api — FastAPI                                  │
│  Analytics query · Topic CRUD · Auth · Cost              │
└──────┬─────────────────────────────┬─────────────────────┘
       │                             │
┌──────▼────────────┐      ┌─────────▼──────────────────┐
│  PostgreSQL 16    │      │  OpenSearch 2.18+            │
│  · topic, query   │      │  · index posts-*           │
│  · stream, link   │      │  · index topic-queries     │
│  · nlp_labels     │      │    (percolator)            │
│  · cost_record    │      │  · analyzer Bahasa Indo    │
│  · user, audit    │      │  · agregasi                │
└───────────────────┘      └─────────▲──────────────────┘
                                     │
┌────────────────────────────────────┴─────────────────────┐
│  services/worker — Celery + Redis + Beat                 │
│                                                          │
│  queue:collect   → SourceAdapter.fetch()                 │
│         ↓                                                │
│  queue:collect   → Normalizer → unified Post             │
│         ↓                                                │
│  queue:collect   → Percolate → matched_topics[]          │
│         ↓                                                │
│  queue:enrich    → Preprocess → Sentiment → Issues       │
│         ↓                                                │
│  queue:aggregate → Rollup pre-computed                   │
└──────────────────────┬───────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────┐
│  SourceAdapter registry                                  │
│  twitterapi.io │ Apify (IG/TikTok/FB/Threads) │ YouTube  │
└──────────────────────────────────────────────────────────┘
                       │
              ┌────────▼────────┐
              │  MinIO / S3     │  payload mentah, thumbnail
              └─────────────────┘
```

---

## 2. Alur Data

### 2.1 Jalur ingestion (5 tahap)

```
1. COLLECT    Beat memicu stream yang jatuh tempo
              → Adapter.fetch(stream, cursor)
              → hasil mentah + cursor baru + biaya
              → biaya dicatat, cursor disimpan

2. NORMALIZE  payload mentah → unified Post
              → mentah disimpan ke S3, pointer disimpan
              → upsert idempoten pakai (platform, platform_post_id)

3. PERCOLATE  batch post → percolator index
              → matched_topics[] terisi
              → post tetap disimpan meski nol match
                (backfill topic baru nanti butuh ini)

4. ENRICH     preprocess (normalisasi gaul, stem, deteksi bahasa)
              → sentimen (batch 25 ke LLM)
              → isu, hashtag, entity
              → tulis ke nlp_labels
              → update dokumen OpenSearch

5. AGGREGATE  update rollup inkremental
              → invalidasi cache untuk topic yang terdampak
```

**Kenapa percolate sebelum enrich:** post yang tidak cocok topic apa pun tetap disimpan (murah) tapi tidak perlu di-NLP (mahal). Urutan ini menghemat biaya NLP untuk hasil di pinggiran collection stream.

### 2.2 Jalur query

```
UI mengubah filter
  → satu request ke /api/dashboard?topic=&from=&to=&platforms=
  → cek cache (Redis)
  → miss: query rollup pre-computed di OpenSearch
  → satu response berisi semua data panel
```

**Kenapa satu request, bukan satu per panel:** dashboard punya 7 panel. Tujuh request paralel akan tujuh kali memukul OpenSearch dengan filter yang sama. Satu request dengan multi-aggregation memakai satu kali filter pass.

---

## 3. Keputusan Desain

### 3.1 Collection stream dipisahkan dari topic

**Masalah:** N topic yang masing-masing punya collector berarti biaya N kali lipat, padahal topic sering berbagi keyword.

**Solusi:** *dedup planner* (T-019) mengambil query semua topic aktif, mengekstrak keyword, dan menggabungkannya jadi himpunan **collection stream** minimal.

```
Topic A: "banjir" OR "bencana"
Topic B: "bencana" OR "gempa"
Topic C: "banjir" AND "jakarta"

  ↓ dedup planner

Stream 1: banjir     → [A, C]
Stream 2: bencana    → [A, B]
Stream 3: gempa      → [B]
```

Tiga topic, tiga stream — bukan tiga collector penuh. Topic keempat yang memakai "banjir" tidak menambah biaya sama sekali.

Pemetaan akhir post ke topic **tidak** dilakukan oleh stream. Stream cuma mengumpulkan bahan mentah; percolator yang menerapkan boolean logic sesungguhnya (`"banjir" AND "jakarta"` untuk Topic C).

### 3.2 Percolator untuk routing topic

Pencarian biasa menjawab "dokumen mana yang cocok query ini". Percolator membalik: "query mana yang cocok dokumen ini". Itu persis yang dibutuhkan di sini.

```
Index topic-queries (tipe percolator)
  { topic_id: "...", query: { bool: { must: [ ...klausa banjir..., ...klausa jakarta... ] }}}

Post masuk
  → POST /topic-queries/_search { percolate: { document: {...} }}
  → mengembalikan semua topic_id yang cocok, dalam satu panggilan
```

Manfaat utamanya: biaya routing tidak naik seiring jumlah topic — satu panggilan percolate per batch, bukan N pencarian per post.

**Revisi saat mengerjakan T-024: query dibangun sebagai `bool` DSL dari AST, bukan dirangkai jadi `query_string`.**

Rencana awal memakai `query_string` karena sintaksnya memetakan hampir 1:1 ke boolean query di UI. Itu benar, tapi membawa dua masalah:

1. **Permukaan injeksi.** `query_string` mentah mengizinkan akses field (`author.username:x`), regex yang bisa menghabiskan CPU, dan wildcard awalan. Semuanya harus disaring lewat daftar putih — dan daftar putih adalah pengaman yang gampang bocor.

2. **Ambiguitas operator implisit.** Parser kita memperlakukan spasi sebagai `AND` (itu yang dimaksud orang), sementara default `query_string` adalah `OR`. Perbedaan itu harus dijaga sinkron lewat `default_operator`, dan kalau lupa, preview dan pencocokan sungguhan memberi hasil berbeda **tanpa error apa pun**.

Karena parser sudah menghasilkan AST (`sma_core.query.boolean`), menerjemahkannya langsung ke `bool` query menghapus keduanya sekaligus: tidak ada string yang diteruskan ke mesin query, dan struktur `AND`/`OR`/`NOT` dinyatakan eksplisit alih-alih diserahkan ke penafsiran default.

```
"banjir" AND "jakarta"
  -> {"bool": {"must": [<klausa banjir>, <klausa jakarta>]}}
```

Implementasi: `sma_core.query.translate`.

### 3.3 Pemisahan Postgres dan OpenSearch

| Data | Tempat | Alasan |
|---|---|---|
| Topic, query, user, role | Postgres | Relasional, butuh konsistensi, volume kecil |
| `nlp_labels` | Postgres | Append-only, diekspor massal, tidak perlu dicari |
| `cost_record` | Postgres | Data keuangan, butuh presisi transaksional |
| Post | OpenSearch | Pencarian teks, agregasi, volume besar |
| Percolator | OpenSearch | Satu-satunya tempat fitur ini ada |
| Payload mentah | S3/MinIO | Besar, jarang diakses, cuma untuk replay |

**Kenapa tidak semuanya di OpenSearch:** OpenSearch bukan database transaksional. Perubahan topic dan penugasan user butuh jaminan konsistensi yang tidak diberikan OpenSearch.

**Kenapa tidak semuanya di Postgres:** full-text search Indonesia dan agregasi word cloud di puluhan juta baris adalah kerja yang memang dirancang untuk OpenSearch. Postgres bisa, tapi jauh lebih lambat dan lebih rumit.

### 3.4 Antrean Celery terpisah

```
queue:collect     prioritas tinggi, worker sedikit — dibatasi rate limit provider
queue:enrich      throughput tinggi, worker banyak — dibatasi rate limit LLM
queue:aggregate   prioritas rendah — boleh tertinggal
```

**Kenapa dipisah:** backlog NLP tidak boleh menghentikan ingestion. Kalau LLM sedang lambat, data tetap masuk dan mengantre — tidak hilang. Antrean tunggal akan membuat kelambatan NLP menghentikan collector, dan post yang lewat window pencarian provider hilang selamanya.

---

## 4. Skema OpenSearch

### 4.1 Analyzer Bahasa Indonesia

```json
{
  "analysis": {
    "filter": {
      "id_stop":     { "type": "stop", "stopwords_path": "stopwords_id.txt" },
      "id_stemmer":  { "type": "stemmer", "language": "indonesian" },
      "slang_norm":  { "type": "synonym", "synonyms_path": "slang_id.txt" }
    },
    "analyzer": {
      "indonesian_text": {
        "tokenizer": "standard",
        "filter": ["lowercase", "slang_norm", "id_stop", "id_stemmer"]
      },
      "indonesian_exact": {
        "tokenizer": "standard",
        "filter": ["lowercase"]
      }
    }
  }
}
```

`slang_id.txt` memetakan bentuk gaul ke bentuk baku (`gk, ga, nggak, engga → tidak`). Diterapkan **sebelum** stopword, supaya bentuk gaul dari stopword ikut tersaring.

Dua analyzer karena keduanya dibutuhkan untuk hal berbeda:
- `indonesian_text` untuk pencarian dan word cloud (stemming membantu recall)
- `indonesian_exact` untuk pencocokan frasa persis (stemming merusak `"Kopdes Merah Putih"`)

### 4.2 Mapping index posts

```json
{
  "properties": {
    "platform":         { "type": "keyword" },
    "platform_post_id": { "type": "keyword" },
    "post_type":        { "type": "keyword" },
    "text": {
      "type": "text", "analyzer": "indonesian_text",
      "fields": { "exact": { "type": "text", "analyzer": "indonesian_exact" } }
    },
    "created_at":       { "type": "date" },
    "collected_at":     { "type": "date" },
    "author": {
      "properties": {
        "username":        { "type": "keyword" },
        "display_name":    { "type": "text" },
        "followers_count": { "type": "long" },
        "account_created_at": { "type": "date" }
      }
    },
    "metrics": {
      "properties": {
        "likes": {"type":"long"}, "shares": {"type":"long"},
        "comments": {"type":"long"}, "views": {"type":"long"},
        "engagement_total": {"type":"long"}
      }
    },
    "hashtags":          { "type": "keyword" },
    "mentions":          { "type": "keyword" },
    "location_province": { "type": "keyword" },
    "matched_topics":    { "type": "keyword" },
    "stream_id":         { "type": "keyword" },
    "nlp": {
      "properties": {
        "sentiment":            { "type": "keyword" },
        "sentiment_confidence": { "type": "float" },
        "model_version":        { "type": "keyword" },
        "issues":               { "type": "keyword" }
      }
    }
  }
}
```

**`nlp.issues` bertipe `keyword`, bukan `text`:** frasa isu adalah unit utuh. Word cloud melakukan agregasi terms terhadapnya; membaginya jadi token akan merusak seluruh tujuannya.

### 4.3 Strategi index

Index bulanan: `posts-2026-09`, `posts-2026-10`, dengan alias `posts`.

Kenapa: retensi jadi urusan menghapus index, bukan menghapus dokumen (jauh lebih murah). Query berdasarkan rentang tanggal cuma menyentuh index yang relevan.

---

## 5. Skema PostgreSQL

Definisi tabel ada di [PRD.md bagian 8.2](../PRD.md#82-entitas-konfigurasi-postgresql). Catatan penting soal implementasi:

**`nlp_labels` akan jadi tabel terbesar di Postgres.** Pada 400K post per bulan, dia bertambah 400K baris per bulan. Rancang untuk itu sejak awal:
- Partisi per bulan
- Index pada `(model_version, created_at)` untuk ekspor training
- Tidak ada foreign key ke post (post kena retensi 12 bulan; label harus tetap hidup — label yang kehilangan post-nya tetap berguna untuk training)

**`cost_record` ditulis di jalur panas.** Tiap panggilan provider menulis satu baris. Buat batching kalau jadi hambatan, tapi jangan pernah menjatuhkan record — akurasi biaya bergantung pada kelengkapannya.

---

## 6. Kontrak SourceAdapter

Detail lengkap: [DATA-SOURCES.md](DATA-SOURCES.md). Bentuk singkatnya:

```python
class SourceAdapter(ABC):
    platform: Platform

    @abstractmethod
    async def fetch(
        self,
        stream: CollectionStream,
        cursor: Cursor | None,
    ) -> FetchResult:
        """Ambil post baru sejak cursor.

        WAJIB inkremental. Implementasi yang mengambil ulang data lama
        akan menghancurkan model biaya (lihat FR-204).
        """


@dataclass
class FetchResult:
    posts: list[RawPost]
    next_cursor: Cursor | None
    cost: CostRecord  # bukan opsional — tiap fetch melaporkan biayanya
    rate_limit: RateLimitInfo | None
```

`cost` bagian dari nilai balik, bukan efek samping. Adapter tahu berapa hasil yang dikembalikan dan berapa tarifnya; menjadikannya bagian dari kontrak berarti tidak ada adapter yang bisa diam-diam menghabiskan biaya tanpa tercatat.

---

## 7. Tata Letak Deployment

### Development
`docker compose up` — semuanya di satu mesin.

### Produksi (rekomendasi awal)

| Node | Spesifikasi | Isi |
|---|---|---|
| app | 4 vCPU / 8 GB | Next.js, FastAPI, Redis |
| data | 8 vCPU / 32 GB | OpenSearch, PostgreSQL |
| worker | 4 vCPU / 8 GB | Celery worker |
| storage | object storage | payload mentah, media |

**OpenSearch yang menentukan sizing.** Butuh RAM untuk field data dan cache agregasi. Aturan praktis: 1 GB heap per 10 juta dokumen, heap maksimal setengah RAM sistem.

Bisa mulai dari satu VPS 32 GB dan dipisah saat sudah terasa. Yang tidak boleh: menaruh OpenSearch di mesin dengan RAM kurang dari 16 GB — akan terlihat baik-baik saja di development lalu berperilaku aneh di produksi dengan cara yang sulit didiagnosis.

---

## 8. Yang Sengaja Ditinggalkan

| Yang tidak dipakai | Kenapa |
|---|---|
| Kafka / message queue berat | Redis plus Celery cukup sampai jutaan post per hari. Kafka menambah beban operasional tanpa manfaat pada skala ini |
| Kubernetes | Satu sampai empat node tidak butuh orkestrator. Docker Compose atau systemd cukup sampai ada beberapa environment |
| GraphQL | Satu klien, endpoint stabil. REST plus tipe hasil generate lebih sederhana |
| Microservice per platform | Adapter adalah kelas, bukan service. Batas yang benar adalah interface, bukan proses |
| Vector database | Fase 1 tidak butuh pencarian semantik. Kalau nanti perlu, `knn_vector` OpenSearch sudah tersedia |
| ClickHouse | OpenSearch menangani agregasi **dan** full-text search. Menambah ClickHouse berarti dua sistem untuk kerja yang bisa ditangani satu |
