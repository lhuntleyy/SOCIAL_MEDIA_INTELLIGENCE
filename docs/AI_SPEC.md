# AI SPEC

## 1. Ruang Lingkup

| Task | Output | Kapan | Runtime |
|---|---|---|---|
| Language ID | `lang` (ISO 639-1) + confidence | setiap post baru | worker-ai (Python) |
| Sentiment | `negative | neutral | positive` + score [0..1] | setiap post baru | worker-ai |
| Keyphrase / Issue | `issues: string[]` (1–3 gram) | setiap post baru | worker-ai |
| Issue ranking per window | top-N issue per topic/bucket | query time dari `agg_issue_1h` + skor | ClickHouse + api |
| Emotion / Perception | 8 emosi Plutchik (`anger|anticipation|disgust|trust|joy|sadness|surprise|fear`) + score | setiap post baru | worker-ai (§4A) |
| Geo inference | `geo_region_code` provinsi + confidence | setiap post baru | worker-pipeline (Bun, gazetteer) |
| Gender inference | `male|female|unknown` + confidence | per akun (di-cache) | worker-ai (§12) |
| Age range inference | `below_18…above_55|unknown` + confidence | per akun (di-cache) | worker-ai (§12) |
| LLM fallback | re-label sentiment/emotion low-confidence + alasan singkat | subset | worker-ai |
| (Fase 6) NER, clustering topik, deteksi koordinasi | — | — | — |

Semua model **diversioning** (`model_versions`), setiap hasil menyimpan `model_version`.

## 2. Preprocessing (deterministik, di-unit-test)

1. Unicode NFKC, hapus zero-width chars.
2. URL → token `<url>`, mention → `<user>`, angka panjang → `<num>` (kecuali tahun 4 digit).
3. Emoji dipertahankan (sinyal sentiment); opsional di-map ke teks via kamus emoji.
4. Hashtag: `#DemoDPR` → `demo dpr` (split camel-case) + tetap simpan hashtag asli.
5. Normalisasi slang/singkatan Indonesia via **kamus leksikon** (file versioned di `models/lexicon/`; sumber & lisensi dicatat — tidak mengklaim dataset tertentu sebelum dicek lisensinya). Contoh entri: `gk→tidak`, `bgt→banget`, `yg→yang`.
6. Lowercase untuk keyphrase; **tidak** lowercase untuk model transformer bila tokenizer case-sensitive (ikuti konfigurasi model).
7. Truncate ke max token model; teks sangat pendek (< 3 token) → `neutral` dengan flag `short_text`.

## 3. Language ID

- Kandidat: fastText language identification model (`lid.176`) — cek lisensi (Creative Commons) sebelum dipakai komersial; alternatif library lain dievaluasi di spike.
- Output digunakan untuk routing model sentiment/emotion (`id` / `en` / `ms` / lainnya) dan filter `languages` per query + `language_hints` topik. `ms` (Malaysia) didukung karena tab Query Lists produk menyediakannya (screenshot 12); model `id` sering cukup baik untuk `ms` (serumpun) tetapi rute `ms` dievaluasi terpisah di gold set (§6).

## 4. Sentiment

### 4.1 Pendekatan: Hybrid 2 tingkat
```
text ─► encoder classifier (lokal, cepat, murah)
          │ confidence ≥ τ ──► hasil final (source = "model")
          │ confidence < τ ──► ai.llm_fallback (source = "llm")
          ▼
     koreksi manusia (source = "human") selalu menang
```

### 4.2 Pemilihan model encoder (tanpa mengklaim akurasi)
Kandidat dievaluasi — **tidak ada yang dipilih sebelum ada angka dari gold set kita sendiri**:
- Model berbasis IndoBERT / IndoRoBERTa yang sudah di-fine-tune sentiment (Hugging Face Hub; cek lisensi & data latih masing-masing).
- Model multilingual (XLM-R) yang di-fine-tune sentiment media sosial.
- Fine-tune sendiri dari base IndoBERT pada data berlabel internal (direkomendasikan jangka menengah).

Kriteria pilih: macro-F1 pada gold set domain (§6), latensi CPU/GPU per batch, lisensi.

### 4.3 Target-aware (penting untuk kasus seperti di screenshot)
Post bisa positif secara umum tapi relevan negatif terhadap topik (atau sebaliknya). v1: sentiment **level post**. v2 (fase 6): *aspect/target-based sentiment* terhadap entitas topik (mis. "KDMP") via LLM atau model ABSA, disimpan sebagai kolom terpisah `target_sentiment` — tidak menggantikan kolom lama.

### 4.4 Kalibrasi & threshold
- Skor dikalibrasi (temperature scaling) di validation set.
- `τ` (threshold fallback) dipilih untuk memenuhi **budget LLM** (mis. maksimal X% item ke LLM) dengan kurva akurasi vs coverage dari eval — nilainya disimpan di `model_versions.config`.

### 4.5 LLM fallback
- Abstraksi `LlmProvider` (pola sama dengan connector: bisa diganti, punya rate limit & quota di DB). Default implementasi: **Claude API via SDK resmi `anthropic` (Python)**.
- Model default: `claude-opus-5` (ID valid per daftar model Anthropic; $5/$25 per MTok). **Bukan** model paling kapabel (di atasnya ada `claude-fable-5-1`) — dipilih sebagai default kualitas-per-harga yang wajar. Opsi lebih murah (`claude-sonnet-5` $2/$10, `claude-haiku-4-5` $1/$5) **dipilih operator berdasarkan eval S-20 (akurasi per $)** — konfigurasi, bukan hardcode. Dampak biaya tiap pilihan: COST_MODEL §4a.
- **Thinking & effort (wajib di-set untuk klasifikasi).** Opus 5 menjalankan adaptive thinking secara default dan token thinking ditagih sebagai output. Untuk klasifikasi pendek set `output_config: {effort: "low", format: {...}}` (atau `thinking: {type: "disabled"}`, diizinkan di Opus 5 pada effort ≤ high). Ukur `usage.output_tokens` di S-20. Parameter `temperature`/`budget_tokens` **ditolak** (400) di Opus 5 — jangan dipakai.
- **Refusal.** Selain cek `stop_reason == "refusal"` (fallback ke label encoder + flag `llm_refused`), aktifkan server-side fallback Anthropic (`fallbacks: "default"` + beta `server-side-fallback-2026-07-01`) agar refusal karena klasifier keamanan dialihkan otomatis — konten politik/kekerasan di media sosial cukup sering memicu klasifier. Verifikasi ID via `GET /v1/models` saat build; **jangan** menambah suffix tanggal pada ID (mis. bukan `claude-opus-5-20260401`). Model batch/reprocess boleh berbeda dari realtime.
- Structured output via `output_config.format` (JSON schema) — tidak parsing teks bebas.
- Batch: reprocessing historis memakai **Message Batches API** (asinkron, lebih hemat); realtime memakai request biasa.
- Prompt caching: system prompt + instruksi + contoh few-shot diletakkan di prefix yang stabil.
- Wajib cek `stop_reason` sebelum membaca konten; `refusal` → label tetap dari encoder + flag `llm_refused`.

Schema output LLM:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["label", "confidence", "target_relevant"],
  "properties": {
    "label": { "enum": ["negative", "neutral", "positive"] },
    "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
    "target_relevant": { "type": "boolean" },
    "rationale_short": { "type": "string", "maxLength": 200 }
  }
}
```

Prompt system (ringkas, versioned di `workers-py/ai_worker/prompts/sentiment_v1.md`):
> Kamu mengklasifikasikan sentiment post media sosial berbahasa Indonesia (bisa campur Inggris, slang, sarkasme) terhadap topik yang diberikan. Label: negative, neutral, positive. Sarkasme dinilai berdasarkan maksud, bukan kata literal. Berita/informasi tanpa opini = neutral. Keluarkan JSON sesuai schema.

Data yang dikirim ke LLM: hanya teks post (mention sudah menjadi `<user>`) + nama topik. Tidak mengirim handle/ID author (minimisasi data — SECURITY §9). Pengiriman ke penyedia LLM di luar negeri = transfer data pribadi lintas negara (UU PDP Pasal 56) — dasar & DPA ditetapkan di S-15; self-host (§14) adalah mitigasi jangka panjang.

## 4A. Emotion / Perception (8 emosi Plutchik)

Fitur "Perception" di produk referensi (Perception Stream/Radar, Emotion by Engagement, Perceptions by Engagement — screenshot 4). Label: **anger, anticipation, disgust, trust, joy, sadness, surprise, fear** (+ `unknown`).

### 4A.1 Model
- **Multi-label alami**, tetapi v1 menyimpan **emosi dominan** (`emotion`) + `emotion_score` di `topic_match_events` agar konsisten dengan pola `sign`/SummingMergeTree (radar & stream tetap terbentuk dari agregat per-emosi). Skor per-emosi penuh boleh disimpan di `enr:` cache untuk drill-down fase lanjut.
- Kandidat (dievaluasi, tidak diklaim akurasinya sebelum gold set): model emosi berbasis IndoBERT/XLM-R yang di-fine-tune (Hugging Face — cek lisensi & data latih), atau LLM untuk item low-confidence (pola sama §4.5, schema output ditambah `emotion`).
- Pipeline: dihitung **satu pass** bersama sentiment di `ai.enrich` (hemat) — lihat QUEUE_SPEC §4.5.

### 4A.2 Preprocessing & threshold
- Preprocessing sama seperti §2 (emoji **dipertahankan** — sinyal kuat untuk emosi).
- Confidence < τ_emotion → `emotion='unknown'` (tidak menebak); τ disimpan di `model_versions.config`.
- Sarkasme dinilai berdasarkan maksud (LLM fallback bila perlu), konsisten dengan aturan sentiment.

### 4A.3 Agregat
- `agg_emotion_1h`/`agg_emotion_1d` (DATA_MODEL §6.5), `posts=sum(sign)`, `engagement=sum(sign*engagement)`.
- Perception Stream = stacked area per emosi per bucket; Radar = jumlah per emosi dalam window; by-Engagement = versi berbobot engagement.
- Override/reprocess emosi memakai pasangan `sign` -1/+1 (sama seperti sentiment).

## 5. Keyphrase / Issue Extraction

Tujuan: menghasilkan frasa seperti "gedung dpr", "elemen mahasiswa", "penanganan bencana".

Per post (worker-ai):
1. Tokenisasi + stopword Indonesia & Inggris (daftar versioned) + stopword per tenant.
2. Kandidat n-gram 1–3 yang tidak diawali/diakhiri stopword; pola POS (NOUN/PROPN/ADJ) jika POS tagger tersedia & lolos evaluasi.
3. Buang kandidat yang merupakan kata query topik itu sendiri (config `exclude_query_terms=true`).
4. Simpan maksimal 5 frasa/post ke `issues`.

Per window (query time):
- Skor = c-TF-IDF: frekuensi frasa di topik/window vs frekuensi latar belakang (seluruh topik tenant 30 hari, dari `agg_issue_1h`).
- "Issue Engagement" = sama tetapi dibobot `engagement`.
- Merge sinonim sederhana (lemmatization/stemming Indonesia jika library lolos evaluasi; dan tabel alias per tenant).

Fase 6: clustering embedding (BERTopic-style) untuk mengelompokkan issue.

## 6. Evaluasi

### 6.1 Gold set
- Sampling stratified dari data nyata per platform & topik (min. awal 2.000 post; target bertambah dari koreksi analyst).
- Dilabeli ≥ 2 anotator, pedoman anotasi tertulis (`docs/annotation-guide.md`, fase 3). Hitung inter-annotator agreement (Cohen's/Fleiss' kappa); item disagreement diadjudikasi.
- Split: dev / test (test **tidak pernah** dipakai tuning).

### 6.2 Metrik
| Task | Metrik utama | Metrik pendukung |
|---|---|---|
| Sentiment | macro-F1 | per-class P/R, confusion matrix, ECE (kalibrasi) |
| Emotion | macro-F1 (8 kelas) | per-class P/R, coverage (non-unknown), ECE |
| Lang ID | accuracy pada set campur (incl. `ms`) | — |
| Keyphrase | precision@5 (penilaian manusia) | coverage |
| Geo | precision provinsi (sample) | coverage |
| Gender | precision pada sample berlabel (self-declared/manual) | coverage %, disparitas per grup |
| Age range | precision pada sample berlabel | coverage %, MAE bucket |

Target angka ditetapkan **setelah baseline diukur** (fase 0 S-20), bukan diasumsikan di awal. Aturan rilis: model baru hanya boleh `active` jika macro-F1 test ≥ model aktif − 0 (tidak turun) dan tidak ada kelas turun > 3 poin.

### 6.3 Regression test di CI
`pytest -m eval` menjalankan model kandidat pada test set beku; gagal jika di bawah threshold di `model_versions`.

### 6.4 Ekspektasi kesulitan (bukan target — untuk kalibrasi harapan)
Berdasarkan pengalaman domain, **kesulitan relatif** tiap task (angka nyata tetap dari gold set kita):

| Task | Ekspektasi kasar | Catatan |
|---|---|---|
| Sentiment (3 kelas) | ~85% | paling matang |
| Emotion (8 kelas Plutchik) | 65–75% | jauh lebih sulit; pembedaan anticipation/surprise, trust/joy tipis bahkan untuk annotator manusia — gold set terpisah |
| Gender | 75–85% | dari nama + sinyal profil |
| Age range | **45–60%** | **paling sering salah** |
| Geo (provinsi) | 60–70% | |

> **Peringatan.** Produk referensi menampilkan angka presisi (`negative (2.093)` untuk umur 18–21) yang **menyiratkan keyakinan yang tidak dimiliki model mana pun**. Karena itu widget wajib menampilkan **confidence + coverage + kategori `unknown` sebagai kelas satu** (§12, SECURITY §9). Angka presisi tanpa itu = keyakinan palsu yang akan masuk laporan resmi analis.

## 7. Monitoring Model (drift)

- Distribusi label per hari per topik (alert jika bergeser > k·σ tanpa lonjakan volume).
- Persentase low-confidence (proxy drift).
- Rasio override manusia per 1.000 post.
- Latency & error rate inference.

## 8. Human-in-the-loop

- Analyst mengubah label di feed (`PATCH /v1/posts/{platform}/{post_id}/sentiment`).
- Efek: `sentiment_overrides` + `topic_match_events` pasangan -1/+1 → agregat berubah < 1 menit.
- Override masuk antrean kurasi → setelah diverifikasi admin, masuk training set berikutnya.

## 9. Reprocessing

Saat model baru diaktifkan: admin memilih range waktu & topik → `reprocess.ai` → hasil baru ditulis sebagai pasangan -1/+1 (sehingga dashboard tidak double count). Berjalan pada prioritas terendah dengan rate cap.

## 10. Geo Inference (Bun, deterministik)

Urutan sumber:
1. Geotag post (lat/lng) → point-in-polygon provinsi (GeoJSON batas provinsi — sumber & lisensi dicatat).
2. `place_name` dari platform → gazetteer.
3. `author.location_raw` → gazetteer (`geo_regions.aliases`, fuzzy match dengan threshold).
4. Tidak ketemu → `null` (tidak menebak dari isi teks di v1).

Confidence: 1.0 (geotag), 0.8 (place), 0.5 (profil, exact alias), 0.3 (fuzzy). UI menampilkan hanya confidence ≥ threshold config.

## 11. Account Age

`author_created_year` dari `author.created_at` (jika provider menyediakan). Jika tidak → `null` dan widget menampilkan "data tersedia untuk X% akun".

> **Framing intelijen (bernilai tinggi untuk org analis).** Histogram waktu pembuatan akun (widget "User Created Time") adalah **indikator buzzer paling praktis**: lonjakan akun yang dibuat dalam rentang waktu sempit dan aktif di satu topic = pola khas kampanye terkoordinasi. Murah karena `author.created_at` sudah ditangkap. **Deteksi koordinasi** penuh (teks identik, waktu posting mirip, akun seumur, pola retweet — analisis graf) = riset fase lanjut.

## 12. Psychography — Gender & Age (scope inti, aktif default)

Produk referensi menampilkan **Sentiment by Gender** (Male/Female) dan **Sentiment by Age Range** (Below 18 … Above 55) — screenshot 9–10. Fitur ini diimplementasikan, aktif default, **dengan metode yang benar dan kontrol yang membuatnya defensible** (bukan sekadar tebakan). Bila operator tenant ingin mematikan, ada feature flag per tenant.

### 12.1 Yang diinferensi & yang TIDAK
- **Diinferensi:** `gender` (male/female/unknown) dan `age_range` (below_18/18_21/22_30/31_45/46_55/above_55/unknown), **per akun**, di-cache lintas tenant (`author_demographics`, DATA_MODEL §6.6).
- **TIDAK PERNAH diinferensi** (batas keras, tetap berlaku): agama, etnis/suku, orientasi politik, orientasi seksual, kondisi kesehatan, atau atribut sensitif lain milik individu. Ini bukan bagian produk.

### 12.2 Sumber sinyal (prioritas: data > inferensi)
1. **Self-declared / platform** bila tersedia (mis. field profil) — confidence tertinggi.
2. **Gender:** leksikon nama Indonesia (dan nama umum `en`/`ms`) → probabilitas gender; diperkuat sinyal profil (bila ada). Nama ambigu/unisex → `unknown`.
3. **Age:** `author_created_at` (umur akun) + cue teks/profil + model; hasilnya **rentang**, bukan umur pasti.
   - **`below_18` (data anak).** Menandai individu sebagai anak = memproses data anak (UU PDP). Default: hasil `below_18` **tidak disimpan per akun** (tercatat `unknown`, `method=minor_suppressed`) dan bucket digabung ke `unknown` di agregat; bucket `below_18` hanya ditampilkan bila memo DPO (S-23) mengizinkan, dan itu pun hanya agregat (DATA_MODEL §6.6, ADR-007).
4. Sinyal tidak cukup / confidence < τ → **`unknown`** (tidak menebak). τ_gender, τ_age disimpan di `model_versions.config`.

### 12.3 Kontrol wajib (compliance & etika)
- **Hanya agregat.** Gender/age **tidak pernah** ditampilkan sebagai label pada akun/post individu di feed — hanya di widget agregat Psychography.
- **Transparansi ketidakpastian.** Setiap widget menampilkan `coverage_pct` (porsi akun ber-label ≥ τ) dan bucket `unknown` tidak disembunyikan.
- **Metode versioned + evidence.** `method` + `model_version` dicatat; eval di §6 (precision + coverage + cek disparitas antar grup untuk mengurangi bias).
- **Dasar hukum & retensi.** Diperlakukan sebagai data pribadi (SECURITY §9, UU PDP): dasar pemrosesan terdokumentasi, retensi mengikuti post global (DATA_MODEL §9), perubahan model demografi masuk audit, review DPO sebelum go-live. Keputusan & konsekuensi: **ADR-007**.
- **Minimisasi ke LLM.** Bila LLM dipakai untuk membantu inferensi, kirim hanya sinyal minimal yang relevan (bukan seluruh profil), konsisten §4.5.

### 12.4 Agregat & tampilan
- `agg_psycho_gender_1d` & `agg_psycho_age_1d` (DATA_MODEL §6.5), `posts=sum(sign)`, hanya baris dengan confidence ≥ τ yang dihitung ke kelas non-`unknown`.
- Halaman per-sentiment (Positive/Negative/Neutral → Timeline/Text Cloud/Account/Hashtag Cloud, screenshot 10–11) = reuse endpoint sentiment/hashtag/keyphrase dengan filter `sentiment=`.

## 13. Serving

- worker-ai memuat model sekali saat start; batch dinamis (≤ 64 item / ≤ 50 ms tunggu).
- CPU-only memungkinkan untuk v1 (ukur throughput di spike); GPU opsional via node pool terpisah.
- Endpoint internal `GET /healthz` (model loaded, versi).

## 14. Korpus Training & Self-Host NLP

### 14.1 `nlp_labels` — tulis setiap inferensi
**Aturan load-bearing:** setiap inferensi NLP (source `model`/`llm`/`human`) **ditulis ke `nlp_labels`** (DATA_MODEL §5.10), dan teksnya ke `s3://smip-training/` (bukan pointer ke raw S3 yang terhapus 30 hari — korpus akan kehilangan teksnya). Alasan: data training **tidak bisa dibuat surut** — inferensi yang tak dicatat hilang selamanya, dan ini korpus untuk fine-tune. Berlaku untuk sentiment, emotion, gender, age, keyphrase, lang. Koreksi manusia (§8) di-tag `source=human` (label emas prioritas tinggi).

### 14.2 Jalur self-host (mengurangi biaya LLM)
Setelah ~100K label terkumpul (~3 bulan operasi normal):
1. Fine-tune **IndoBERT-base / IndoBERTweet** dari `nlp_labels` (sentiment; emotion butuh lebih banyak label karena 8 kelas).
2. **Switchover A/B**: jalankan model self-host paralel dengan LLM, bandingkan pada trafik nyata; pindah jalur utama hanya bila akurasi ≥ LLM pada gold set.
3. LLM tetap dipakai untuk: post low-confidence (~12% volume), audit drift berkala, topic baru yang belum terwakili di data training.
4. Inference **di CPU** (~20–50 post/detik) — tidak butuh GPU produksi.

Nilai: biaya NLP ~$81 → ~$11/bln (COST_MODEL §7), **biaya jadi tetap** (tak naik linear saat viral), dan **deployment on-premise/air-gapped** jadi mungkin (syarat klien instansi).
