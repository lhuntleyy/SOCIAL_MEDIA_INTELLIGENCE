# Model Biaya

Semua angka bisa ditelusuri. Tarif dari [DATA-SOURCES.md bagian 7](DATA-SOURCES.md#7-sumber-harga). Kurs **Rp 16.500/USD**.

Dokumen ini adalah sumber kebenaran untuk angka biaya. Kalau ada dokumen lain yang berbeda, yang ini yang benar.

---

## 1. Baseline Volume

Diturunkan dari topic referensi "PERMASALAHAN KDMP", 1 minggu (`screenshots/Screenshot_2.png`):

| Platform | Post | Reply | Total | Porsi |
|---|---:|---:|---:|---:|
| Twitter | 12.763 | 6 | 12.769 | 89,28% |
| Threads | 929 | 0 | 929 | 6,49% |
| TikTok | 266 | 131 | 397 | 2,78% |
| Instagram | 24 | 133 | 157 | 1,10% |
| Facebook | 34 | 0 | 34 | 0,24% |
| YouTube | 17 | 0 | 17 | 0,12% |
| **Total** | **14.033** | **270** | **14.303** | **100%** |

**14.303 post/minggu = 60.000 post/bulan** untuk satu topic ramai. Porsi platform di atas dipakai di semua perhitungan berikutnya.

Satu hal yang langsung terlihat dari sebaran ini: **X mendominasi 89% volume tapi tarifnya paling murah** ($0,15/1K vs $1,50–2,00/1K). Kebetulan yang menguntungkan — kalau sebarannya terbalik, ekonomi produk ini akan jauh lebih berat.

---

## 2. Skenario A — Satu Topic (Pilot)

60.000 post/bulan.

### Akuisisi data

| Platform | Post | Tarif/1K | Biaya |
|---|---:|---:|---:|
| X / Twitter | 53.568 | $0,15 | $8,04 |
| Threads | 3.896 | $1,50 | $5,84 |
| TikTok | 1.665 | $1,70 | $2,83 |
| Instagram | 659 | $1,50 | $0,99 |
| Facebook | 143 | $2,00 | $0,29 |
| YouTube | 71 | gratis | $0,00 |
| **Subtotal** | **60.002** | | **$17,99** |
| Overhead polling (×1,25) | | | **$22,49** |
| Biaya platform Apify | | | **$29,00** |
| **Total data** | | | **$51,49** |

### NLP

Asumsi token (lihat bagian 6 untuk penurunannya): 78 token input, 25 token output per post.

| Item | Perhitungan | Biaya |
|---|---|---:|
| Input | 60.000 × 78 = 4,68 juta token @ $1,00/M | $4,68 |
| Output | 60.000 × 25 = 1,50 juta token @ $5,00/M | $7,50 |
| **Total NLP** | | **$12,18** |

### Total

| Komponen | Biaya |
|---|---:|
| Data | $51,49 |
| NLP | $12,18 |
| Infra (1 VPS 8vCPU/32GB) | $30–85 |
| **Total** | **$94–149** |
| **Dalam rupiah** | **Rp 1,55–2,45 juta** |

Mahal untuk satu topic — biaya platform Apify ($29) dan infra ditanggung sendirian. Ini bukan kondisi operasi normal; ini biaya pilot.

---

## 3. Skenario B — 30 Topic, Collection Stream Bersama

Ini target operasi normal.

Korpus unik ~400.000 post/bulan. Kenapa bukan 30 × 60.000 = 1,8 juta: topic publik Indonesia saling beririsan berat (banjir, bencana, dan gempa saling berbagi post), dan tidak semua topic seramai baseline. 400K adalah asumsi yang perlu divalidasi terhadap data nyata di bulan pertama operasi.

### Akuisisi data

| Platform | Post | Tarif/1K | Biaya |
|---|---:|---:|---:|
| X / Twitter | 357.120 | $0,15 | $53,57 |
| Threads | 25.960 | $1,50 | $38,94 |
| TikTok | 11.120 | $1,70 | $18,90 |
| Instagram | 4.400 | $1,50 | $6,60 |
| Facebook | 960 | $2,00 | $1,92 |
| YouTube | 480 | gratis | $0,00 |
| **Subtotal** | **400.040** | | **$119,93** |
| Overhead polling (×1,25) | | | **$149,91** |
| Biaya platform Apify | | | **$29,00** |
| **Total data** | | | **$178,91** |

### NLP

| Item | Perhitungan | Biaya |
|---|---|---:|
| Input | 400.000 × 78 = 31,2 juta token @ $1,00/M | $31,20 |
| Output | 400.000 × 25 = 10,0 juta token @ $5,00/M | $50,00 |
| **Total NLP** | | **$81,20** |

### Total

| Komponen | Biaya | Porsi |
|---|---:|---:|
| Data | $178,91 | 52% |
| NLP | $81,20 | 24% |
| Infra | $85,00 | 25% |
| **Total** | **$345** | |
| **Per topic** | **$11,50** | |
| **Per topic (Rp)** | **Rp 190 rb** | |

---

## 4. Jebakan Polling

Ini bagian paling penting di dokumen ini.

**Provider menagih per hasil yang mereka kembalikan, bukan per hasil unik yang baru bagi kita.**

Konsekuensinya besar. Collector yang polling tiap 5 menit dan menarik 100 hasil terbaru setiap kali:

```
288 run/hari × 100 hasil = 28.800 hasil/hari dibayar
Padahal yang benar-benar baru cuma ~2.000/hari
Pemborosan: 14x
```

Perbaikannya adalah fetch inkremental (FR-204) — lacak posisi, ambil hanya yang lebih baru. Efektivitasnya berbeda per platform:

| Platform | Mekanisme | Overhead |
|---|---|---:|
| X / Twitter | `since_id` sejati | 1,1x |
| YouTube | `publishedAfter` | 1,1x |
| Threads, TikTok, IG, FB | Filter timestamp + saring ID lokal | 1,4x |
| **Rata-rata terbobot** | | **1,25x** |

Rata-rata terbobotnya rendah karena X mendominasi volume dan punya mekanisme cursor terbaik.

Untuk platform Apify yang tidak punya cursor sejati, tiga mitigasi digabung:
1. `maxItems` diketatkan (25–50 per run, bukan 100+)
2. Interval polling lebih longgar (30 menit sampai 1 jam)
3. Adaptive polling melambat saat stream sepi (FR-203)

Menyaring duplikat setelah hasil diterima menjaga kebersihan data tapi **tidak menghemat uang** — biayanya sudah terjadi begitu actor mengembalikan hasil.

---

## 5. Nilai Dua Keputusan Desain

Bagian ini memisahkan kontribusi masing-masing pengaman, supaya jelas mana yang paling menentukan.

### Pembanding: desain naif

| Desain | Deskripsi | Total/bln | Per topic | vs Skenario B |
|---|---|---:|---:|---:|
| **B (rekomendasi)** | Stream bersama + fetch inkremental | **$345** | $11,50 | 1,0x |
| **Naif A** | Collector per topic, tapi tetap inkremental | $465 | $15,50 | **1,35x** |
| **Naif B** | Collector per topic, polling tanpa cursor | $4.385 | $146 | **12,7x** |

**Naif A** memakai collector terpisah per topic. Post yang cocok beberapa topic dibayar berkali-kali. Pada 30 topic, faktor tumpang tindih rata-rata sekitar 1,8x.

**Naif B** ditambah polling tanpa cursor: X di interval 15 menit dan platform Apify per jam, tanpa pelacakan posisi.

### Pengaman mana yang paling berpengaruh

Pada 30 topic, **fetch inkremental (FR-204) jauh lebih menentukan daripada stream bersama (FR-202)** — 12,7x versus 1,35x. Kalau harus memilih satu untuk dikerjakan lebih dulu, dahulukan T-012 dan T-022 (fetch inkremental) sebelum T-019 (dedup planner).

Tapi keunggulan relatif itu berbalik seiring jumlah topic bertambah, karena tumpang tindih meningkat:

| Jumlah topic | Korpus unik | Faktor tumpang tindih | Stream bersama | Naif A | Penghematan |
|---:|---:|---:|---:|---:|---:|
| 30 | 400K | 1,8x | $345 | $465 | 1,35x |
| 108 | 900K | ~4,0x | $699 | $1.711 | **2,45x** |

Produk referensi punya 108 topic. Pada skala itu, stream bersama menghemat sekitar $1.000 per bulan — dan biaya per topic turun jadi **$6,47 (Rp 107 rb)**.

Kesimpulan praktis: **kedua pengaman diperlukan, tapi urutan pengerjaannya penting.** Fetch inkremental melindungi dari sejak hari pertama; stream bersama baru terbayar setelah beberapa lusin topic. Keduanya jauh lebih murah dibangun di awal daripada di-retrofit setelah skema data terlanjur berbentuk per-topic.

---

## 6. Penurunan Asumsi Token

Dipakai di semua perhitungan NLP di atas.

**Input per post: 78 token**

| Komponen | Token | Catatan |
|---|---:|---|
| Teks post | 65 | Post Indonesia rata-rata ~180 karakter |
| Framing per post | 10 | Index, delimiter, struktur |
| System prompt teramortisasi | 3 | 700 token, di-cache (baca cache = 0,1x harga input), dibagi 25 post per batch |
| **Total** | **78** | |

**Output per post: 25 token**

JSON ringkas: `{"i":1,"s":"neg","c":0.92}`. Format verbose bisa mudah jadi 3x lipat — output berharga $5/M versus input $1/M, jadi keringkasan output punya nilai 5x lipat dibanding keringkasan input.

**Harga model:** Claude Haiku 4.5, $1,00/M input, $5,00/M output.

**Batch API** memberi diskon 50% dengan turnaround sampai 24 jam. Tidak bisa dipakai untuk jalur realtime (FR-402 mensyaratkan segar dalam 5 menit), tapi cocok untuk backfill historis (T-037).

---

## 7. Skenario C — Setelah NLP Self-Host (Fase 4)

Setelah IndoBERT di-fine-tune dari `nlp_labels` (lihat [ROADMAP.md](ROADMAP.md) Fase 4), LLM hanya dipakai untuk post low-confidence dan audit berkala — sekitar 12% volume.

| Komponen | Sebelum | Sesudah |
|---|---:|---:|
| Data | $178,91 | $178,91 |
| NLP | $81,20 | $11,07 |
| Infra | $85,00 | $85,00 |
| **Total** | **$345** | **$275** |
| **Per topic** | $11,50 | **$9,17** |
| **Per topic (Rp)** | Rp 190 rb | **Rp 151 rb** |

Rincian NLP sesudah: $9,74 pemakaian LLM (12% dari $81,20) plus $1,33 biaya pelatihan teramortisasi.

### Biaya pelatihan

| Item | Biaya |
|---|---:|
| Sewa GPU A100 (RunPod, ~$2/jam × 2 jam) | $4,00 |
| Diulang tiap kuartal | $16/tahun |
| **Teramortisasi bulanan** | **$1,33** |

**Inference tidak butuh GPU.** IndoBERT-base di CPU berjalan pada 20–50 post/detik. Volume 400K post/bulan berarti sekitar 4 jam CPU time per bulan — muat dengan mudah di node worker yang sudah ada.

Penghematan $70/bulan sendiri tidak dramatis. Nilai sesungguhnya ada di tempat lain:
- **Deployment on-premise jadi mungkin** — bisa jadi syarat wajib klien instansi pemerintah
- **Tidak ada dependensi eksternal** di jalur panas
- **Biaya jadi tetap**, tidak lagi naik linear terhadap volume — penting kalau ada isu viral tak terduga

---

## 8. Cost Guard (FR-702)

Tiga lapis, masing-masing menangkap kegagalan yang berbeda:

| Lapis | Requirement | Menangkap |
|---|---|---|
| 1. Preview sebelum simpan | FR-107 | Query terlalu luas, sebelum jadi tagihan |
| 2. Cap per topic | FR-702 | Topic yang meledak volumenya di luar dugaan |
| 3. Cap global | FR-702 | Total agregat lintas semua topic |

**Perilaku saat cap tercapai:**

| Ambang | Aksi |
|---|---|
| 80% | Alert ke admin |
| 100% | Interval polling turun ke maksimum (1 jam); alert; **ingestion tidak berhenti** |
| Override manual | Admin bisa menaikkan cap kapan saja |

Kenapa throttle, bukan stop: data parsial lebih berguna daripada tidak ada data. Menghentikan ingestion di tengah isu viral justru mematikan sistem tepat di saat paling dibutuhkan.

---

## 9. Yang Perlu Divalidasi

Angka di dokumen ini adalah estimasi. Yang harus diukur terhadap kenyataan di bulan pertama operasi:

| Asumsi | Nilai dipakai | Cara validasi | Risiko kalau meleset |
|---|---|---|---|
| Korpus unik pada 30 topic | 400K/bln | Hitung post unik setelah dedup | Linear terhadap biaya data |
| Faktor tumpang tindih | 1,8x | Rata-rata `len(matched_topics)` | Mempengaruhi nilai FR-202 |
| Overhead polling | 1,25x | `unit_count` dibagi post baru tersimpan | Linear terhadap biaya data |
| Token input per post | 78 | Log `usage` sebenarnya dari API | Linear terhadap biaya NLP |
| Porsi platform | 89% X | Hitung per platform | Bergeser jauh dari X akan menaikkan biaya |
| Tarif provider | Lihat tabel | Bandingkan dengan tagihan | Langsung |

T-070 (dashboard biaya) harus menampilkan nilai sebenarnya berdampingan dengan estimasi di sini, supaya selisihnya terlihat sejak dini dan bukan saat akhir bulan.
