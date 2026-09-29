# Pedoman Anotasi Gold Set — Sentiment & Emosi (S-20 / S-22, AI_SPEC §6.1)

Versi 1 · 2026-09-29. Gold set = **label manusia** untuk MENGUKUR model/LLM. Label LLM **tidak pernah** masuk gold set
(label LLM masuk `nlp_labels source=llm` sebagai bahan training, bukan alat ukur).

## Alur
1. `python -m smip_nlp.gold sample --n 2000 --out data/gold/sample.jsonl` — sampel stratified per platform, teks sudah
   dipseudonimkan (`<user>`, `<url>`, `<num>`), tanpa nama/ID akun.
2. `python -m smip_nlp.gold sheet data/gold/sample.jsonl data/gold/annotator_A.csv` (ulang untuk B). **Dua anotator
   mengerjakan file masing-masing tanpa saling melihat.**
3. `python -m smip_nlp.gold merge annotator_A.csv annotator_B.csv --out data/gold/gold.jsonl` → laporan Cohen's kappa +
   daftar item beda. Item beda diadjudikasi orang ketiga (`--adjudicated adj.csv`); yang tetap beda keluar dari gold.
4. Split dev/test beku otomatis (hash id). **Test tidak boleh dilihat saat memilih threshold/prompt.**
5. File gold disimpan di bucket training (bukan git) — `workers-py/data/` di-ignore.

Target kappa: sentiment ≥ 0,6 (substantial). Bila < 0,6 → perbaiki pedoman ini dulu, jangan lanjut melabel.

## Sentiment (kolom `sentiment`)
Nilai **sikap penulis terhadap topik/isu yang dibahas**, bukan nada kata.

| Label | Kapan | Contoh |
|---|---|---|
| `negative` | kritik, keluhan, kecewa, marah, ejekan, sarkasme yang maksudnya menjatuhkan | "mereka kecewa dengan penempatan manager kopdes" |
| `positive` | dukungan, pujian, harapan baik, rasa puas | "alhamdulillah kopdes di desa kami sudah jalan, warga terbantu" |
| `neutral` | berita/informasi tanpa opini, pertanyaan netral, pengumuman, campuran yang seimbang | "Besok buka kopdes biar penempatan sesuai domisili" |
| `skip` | spam/iklan, bukan bahasa Indonesia/Melayu/Inggris, teks kosong/tak bermakna, tidak terkait topik | "promo pulsa murah klik <url>" |

Aturan:
- **Sarkasme dinilai dari maksud**: "hebat banget, 3 bulan gaji belum cair 👏" → `negative`.
- Emoji ikut dipertimbangkan (🤣 mengejek vs tertawa senang — lihat konteks).
- Mengutip/menyebarkan berita buruk tanpa opini → `neutral`; berita + komentar penulis → nilai komentarnya.
- Positif ke satu pihak tapi negatif ke topik ("salut buat warga yang protes kopdes") → nilai terhadap **topik** (`negative`).
- Ragu antara dua label setelah 20 detik → pilih `neutral` dan isi kolom `note`.

## Emosi (kolom `emotion`, 8 Plutchik + unknown)
Emosi **dominan** penulis. Bila tidak jelas → `unknown` (jangan menebak).

| Label | Petunjuk |
|---|---|
| `anger` | marah, geram, menyalahkan, umpatan |
| `disgust` | jijik, muak, merendahkan ("alay", "memalukan") |
| `fear` | takut, cemas, khawatir akan akibat |
| `sadness` | sedih, kecewa pasrah, duka |
| `joy` | senang, lega, bangga, bercanda riang |
| `trust` | percaya, yakin, mendukung pihak/lembaga |
| `anticipation` | menunggu, berharap, merencanakan, penasaran akan yang akan terjadi |
| `surprise` | kaget, tak menyangka (positif/negatif) |
| `unknown` | informatif tanpa emosi, atau tidak bisa ditentukan |

Pasangan yang sering tertukar: anticipation↔surprise (sebelum vs sesudah kejadian), trust↔joy (yakin vs senang),
anger↔disgust (menyerang vs merendahkan). Tulis alasan singkat di `note` untuk kasus ini.

## Yang TIDAK dilabel
Gender/umur penulis (S-23 — butuh memo legal & DPO), identitas orang, lokasi. Jangan mencari akun asli penulis.
