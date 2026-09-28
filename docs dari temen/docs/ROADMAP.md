# Roadmap — Fase 2 sampai 4

Fase 1 (Core MVP) ada di [TASK.md](../TASK.md). Dokumen ini memetakan jalur menuju paritas penuh dengan produk referensi.

Estimasi di sini lebih kasar daripada Fase 1 — sengaja. Estimasi fase jauh yang terlihat presisi itu menyesatkan. Angka di sini untuk perencanaan kapasitas, bukan komitmen tanggal.

---

## Ringkasan

| Fase | Tema | Estimasi | Prasyarat |
|---|---|---|---|
| 1 | Core MVP — ingestion, dashboard, sentiment | 71 hari | — |
| 2 | Conversation lengkap — emosi, kronologi, isu | ~35 hari | Fase 1 |
| 3 | Audience & Psychography — inferensi demografi | ~45 hari | Fase 2 |
| 4 | Self-host NLP & enterprise | ~40 hari | ~100K label dari Fase 1–2 |

Fase 4 punya prasyarat data, bukan cuma prasyarat kode: fine-tuning butuh label yang terkumpul dari operasi normal. Jam kalender di sini tidak bisa dipercepat dengan menambah orang.

---

## Fase 2 — Modul Conversation Lengkap

Melengkapi dropdown Conversation (`screenshots/Screenshot_7.png`). Semuanya diturunkan dari data yang sudah dikumpulkan Fase 1 — tidak ada biaya akuisisi tambahan.

### 2.1 Perception / Emotion
> `screenshots/Screenshot_4.png`

Delapan emosi Plutchik: anger, anticipation, disgust, trust, joy, sadness, surprise, fear.

| Komponen | Deskripsi |
|---|---|
| Perception Stream | Area chart bertumpuk, volume per emosi sepanjang waktu |
| Perception Radar | Radar 8 sumbu, intensitas emosi agregat |
| Emotion by Engagement | Sama, berbobot engagement |
| Perceptions by Engagement | Pie proporsi emosi berbobot engagement |

**Pendekatan teknis:** perluas prompt klasifikasi Fase 1 supaya mengembalikan emosi bersama sentimen dalam satu panggilan. Biaya tambahan hampir nol — teks input sudah dibayar, hanya output yang bertambah ~15 token per post (sekitar $30/bulan pada 400K post).

**Yang perlu diwaspadai:** klasifikasi 8 kelas jauh lebih sulit daripada 3 kelas, dan pembedaan Plutchik (anticipation versus surprise, trust versus joy) tipis bahkan untuk annotator manusia. Perlu gold set terpisah. Jangan berharap akurasi setinggi sentimen — target realistis 65–75% macro-F1, bukan 85%.

### 2.2 Chronology
Timeline peristiwa: lonjakan terdeteksi otomatis, dianotasi dengan post pemicu.
**Nilai:** menjawab "apa yang menyebabkan lonjakan tanggal 28" tanpa scrolling manual.

### 2.3 Gallery
Grid media (gambar/video) dari post yang cocok, bisa difilter sentimen dan engagement.
**Catatan:** ini yang membuat pertanyaan Q3 di PRD (simpan salinan media atau hotlink) jadi penting. Hotlink lebih murah tapi rusak kalau post aslinya dihapus.

### 2.4 Issues (halaman penuh)
Halaman khusus untuk isu: tren dari waktu ke waktu, drill-down ke post penyusun, isu naik dan turun.

### 2.5 Engagement (halaman penuh)
Analisis engagement mendalam: distribusi, outlier, rasio engagement per platform.

### 2.6 Contributors
Siapa yang mendorong percakapan: penyumbang teratas berdasarkan volume dan jangkauan.

### 2.7 Issues Comparison
Perbandingan berdampingan beberapa topic pada metrik yang sama.
**Prasyarat:** butuh minimal 2 topic matang untuk berguna.

### 2.8 Hashtag treemap & total posts comparison
> `screenshots/Screenshot_5.png` (bagian atas)

Treemap hashtag berukuran frekuensi, plus bar chart post versus comment sepanjang waktu.

---

## Fase 3 — Audience & Psychography

Bagian paling ambisius, dan yang paling perlu kehati-hatian.

### 3.1 Inferensi demografi
> `screenshots/Screenshot_9.png`, `Screenshot_10.png` (bagian atas)

Menurunkan gender, kelompok umur, dan lokasi dari sinyal profil publik.

| Atribut | Sinyal | Akurasi realistis |
|---|---|---|
| Gender | Nama depan (kamus nama Indonesia), foto profil, gaya bahasa | 75–85% |
| Kelompok umur | Umur akun, referensi budaya, gaya bahasa, sinyal bio | 45–60% |
| Lokasi | Field lokasi, dialek, referensi geografis | 60–70% (sudah sebagian di FR-207) |

**Peringatan jujur soal akurasi.** Kelompok umur adalah yang paling sulit dan paling sering salah. Produk referensi menampilkan rentang umur dengan angka presisi (`negative (2.093)` untuk 18–21) yang menyiratkan keyakinan yang hampir pasti tidak dimiliki model mana pun. Kalau fitur ini dibangun, **tampilkan indikator confidence dan porsi unknown** — kalau tidak, ini menghasilkan angka yang terlihat berwibawa padahal sebenarnya tebakan. Analis akan memasukkannya ke laporan resmi.

Rekomendasi: sertakan `unknown` sebagai kategori kelas satu di semua visualisasi demografi, dan jangan pernah menyembunyikannya untuk membuat grafik terlihat lebih rapi.

**Blokir hukum.** Ini profiling menurut UU PDP dan penanganannya lebih ketat daripada penyimpanan data publik biasa. **Perlu review hukum sebelum fase ini dimulai**, bukan sebelum dirilis. Lihat [DATA-SOURCES.md bagian 6](DATA-SOURCES.md#6-legal--kepatuhan).

### 3.2 Sentiment berdasarkan demografi
Semua panel sentimen dipecah berdasarkan gender dan kelompok umur.
**Prasyarat:** 3.1, termasuk penyelesaian review hukumnya.

### 3.3 Taxonomy Interest & Industry
Klasifikasi akun ke kategori interest dan industry (field `Taxonomy` di `Screenshot_11.png`).

### 3.4 Leaderboard akun
> `screenshots/Screenshot_5.png` (bawah), `Screenshot_6.png`

Most retweeted accounts, top accounts comment/reply, top account retweet, active accounts.

### 3.5 Distribusi User Created Time
> `screenshots/Screenshot_5.png` (kiri bawah)

Histogram tanggal pembuatan akun. **Ini indikator buzzer yang paling praktis** — lonjakan akun yang dibuat dalam rentang sempit dan aktif di satu topic adalah pola khas kampanye terkoordinasi.

Nilainya sangat tinggi untuk analisis intelijen, dan implementasinya relatif murah karena `author.account_created_at` sudah ditangkap di Fase 1.

### 3.6 Deteksi koordinasi
Deteksi perilaku terkoordinasi: teks identik, waktu posting mirip, akun berumur sama, pola retweet.
**Teknis:** analisis graf pada jaringan retweet dan mention. Ini butuh riset, bukan sekadar implementasi.

---

## Fase 4 — Self-Host NLP & Enterprise

### 4.1 Fine-tune IndoBERT
Latih model sentimen dari `nlp_labels` yang terkumpul di Fase 1–2.

| Langkah | Detail |
|---|---|
| Prasyarat data | ~100K labeled example (sekitar 3 bulan operasi normal) |
| Base model | IndoBERT-base atau IndoBERTweet |
| Pelatihan | Sewa GPU A100, ~2 jam, ~$4 per run |
| Validasi | Harus menyamai atau melampaui akurasi LLM pada gold set Fase 1 |
| Deployment | Inference CPU, 20–50 post/detik — tidak butuh GPU produksi |

Pendekatan yang sama berlaku untuk klasifikasi emosi Fase 2, tapi butuh lebih banyak label karena kelasnya 8 bukan 3.

### 4.2 Switchover A/B
Jalankan model self-host paralel dengan LLM, bandingkan pada trafik nyata, pindah jalur utama hanya kalau akurasinya sudah setara.

LLM tetap dipakai untuk:
- Post low-confidence (~12% volume)
- Audit berkala untuk mendeteksi drift
- Topic baru yang belum terwakili di data training

### 4.3 Deployment on-premise
Setelah NLP self-host, tidak ada lagi dependensi eksternal di jalur panas kecuali provider data. Memungkinkan deployment air-gapped untuk klien yang mensyaratkannya.

### 4.4 Modul Resume
Item nav `Resume` di `screenshots/Screenshot_7.png` — ringkasan naratif tergenerate untuk sebuah topic pada rentang waktu tertentu.

### 4.5 Ekspor & pelaporan
Ekspor PDF dan Excel, laporan terjadwal, template paparan.

### 4.6 Alerting realtime
Notifikasi saat metrik melewati ambang: lonjakan volume, pergeseran sentimen, isu baru muncul.

### 4.7 Multi-tenant
Isolasi organisasi, topic per tenant, penagihan per tenant.

### 4.8 Platform tambahan
Bluesky (AT Protocol, gratis) dan Reddit (API resmi, gratis). Volume Indonesia rendah, tapi biaya integrasinya juga rendah.

---

## Cakupan Screenshot

Verifikasi bahwa tiap panel di 13 screenshot referensi punya rumah.

| Screenshot | Isi | Fase |
|---|---|---|
| `Screenshot_1.png` | Exposure, Issues, Engagements History, Issue Engagement | **1** |
| `Screenshot_2.png` | Total Posts, Total Replies, Topic Location | **1** |
| `Screenshot_3.png` | Sentiment proportion, sentiment by engagement | **1** |
| `Screenshot_4.png` | Perception stream, radar, emotion by engagement | 2 |
| `Screenshot_5.png` | Hashtag treemap, user created time, posts comparison, most retweeted | 2 (treemap, comparison), 3 (user created time, most retweeted) |
| `Screenshot_6.png` | Top accounts comment/reply, top retweet, active accounts | 3 |
| `Screenshot_7.png` | Nav bar, dropdown Conversation | 1 (shell), 2 (isi menu) |
| `Screenshot_8.png` | Sentiment timeline, proportion, feed 3 kolom | **1** |
| `Screenshot_9.png` | Sentiment by gender, by age range | 3 |
| `Screenshot_10.png` | Age range lanjutan; positive timeline, text cloud, account, hashtag cloud | 3 (atas), **1** (bawah) |
| `Screenshot_11.png` | Topic & Account — tab General | **1** |
| `Screenshot_12.png` | Topic & Account — tab Query Lists | **1** |
| `Screenshot_13.png` | Dashboard, dropdown refresh interval | **1** |

Tidak ada panel yang tidak terpetakan.

---

## Yang Sebaiknya Tidak Dibangun

Beberapa hal terlihat masuk akal tapi sebaiknya ditolak lebih dulu:

| Ide | Kenapa jangan |
|---|---|
| Klasifikasi sentimen realtime di bawah 1 menit | Provider polling tidak lebih cepat dari itu. Optimasi NLP tidak menolong kalau datanya belum ada |
| Prediksi viral | Ekspektasi akurasi yang tidak bisa dipenuhi; jalan pintas menuju kepercayaan yang salah tempat |
| Skor sentimen otomatis per individu | Melewati batas dari analisis isu menjadi pemantauan orang. Bukan sekadar risiko hukum — ini pergeseran tujuan produk |
| Dukungan setiap platform yang ada | Tiap platform adalah adapter yang harus dipelihara. Enam yang dipakai orang lebih baik daripada dua belas yang setengah jalan |
