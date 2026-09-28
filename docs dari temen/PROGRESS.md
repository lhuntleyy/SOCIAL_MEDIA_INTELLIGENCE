# PROGRESS — Log Pengerjaan

Log append-only untuk task di [TASK.md](TASK.md). Entri terbaru di atas.

## Aturan penulisan

1. **Satu entri per task selesai.** Ditulis saat task dicentang di TASK.md, bukan dikumpulkan di akhir.
2. **Jangan pernah mengedit atau menghapus entri lama.** Kalau ada yang berubah kemudian, tulis entri baru yang merujuk ke yang lama.
3. **Wajib jujur.** Kalau ada acceptance criteria yang tidak terpenuhi, tulis apa adanya di bagian Deviasi dan jangan centang task-nya. Task setengah jadi lebih berbahaya daripada task yang belum mulai, karena kelihatannya sudah beres.
4. **Verifikasi berarti output nyata.** Tulis perintah yang dijalankan dan hasilnya. "Sudah dites" bukan verifikasi.
5. **Deviasi adalah bagian paling berharga di file ini.** Kalau realitanya beda dari asumsi PRD — rate limit berbeda, field provider hilang, biaya meleset — tulis di sini. Ini yang bikin estimasi berikutnya lebih akurat.

## Template

```markdown
## T-xxx · <judul task> — SELESAI <YYYY-MM-DD>

**FR:** FR-xxx
**Dikerjakan:** <apa yang dibangun, 2-4 kalimat>
**File:** <path yang dibuat atau diubah>
**Verifikasi:** <perintah yang dijalankan dan hasilnya>
**Deviasi:** <beda dari rencana, atau "tidak ada">
**Dampak biaya:** <kalau menyentuh ingestion atau NLP; kalau tidak, "n/a">
**Next:** T-xxx
```

---

## T-069 · Budget cap, alert, & throttle — 2026-09-15

**FR:** FR-702

**Dikerjakan:** Cap biaya bulanan per topic dan global, alert di 80%, throttle di 100% yang melambatkan tanpa menghentikan, dan override manual yang tercatat di audit log.

**File:** `packages/core/sma_core/cost/{guard,cap}.py`, `packages/core/sma_core/streams/scheduler.py`, `packages/core/sma_core/db/models.py`, `migrations/versions/0003_cost_cap.py`, `services/api/sma_api/cost/{periode,router}.py`

**Verifikasi:** 1.446 test Python lolos di 63 berkas (dari 1.373/60); ruff, `ruff format --check`, mypy (122 berkas) bersih. Sisi web tidak tersentuh.

### Tidak ada jalur yang menghentikan ingestion

FR-702 menyebutnya eksplisit, dan COST-MODEL.md bagian 8 menjelaskan alasannya: menghentikan ingestion di tengah isu viral mematikan sistem tepat di saat paling dibutuhkan — dan isu viral persis keadaan yang membuat cap tercapai.

Yang dilakukan di kode bukan sekadar tidak menulis jalur berhenti, tapi membuatnya tidak bisa ditulis tanpa sengaja: enum `Tingkat` cuma punya NORMAL, ALERT, dan TAHAN. Tidak ada nilai yang berarti berhenti, jadi tidak ada yang bisa dipilih orang berikutnya yang merasa berhenti lebih aman. Ada test yang memeriksa daftar nilainya.

`TAHAN` berarti interval turun ke tingkat paling lambat (1 jam). Sepuluh kali lipat melewati cap pun tidak menghasilkan sesuatu yang lebih keras.

### Cap satu topic tidak selalu bisa ditegakkan sendirian

Ini bagian yang paling mudah dinilai salah, jadi ditulis panjang di modulnya.

Stream dipakai bersama beberapa topic — itu inti FR-202 dan alasan model biayanya bekerja. Kalau topic A lewat cap sementara topic B yang berbagi stream masih jauh di bawah, melambatkan stream itu:

- tidak menghemat apa pun yang tidak sudah jadi hak B. Stream-nya tetap harus jalan untuk B, dengan biaya yang sama persis.
- merugikan B, yang tidak melakukan kesalahan apa pun.

Jadi stream ditahan hanya kalau SELURUH topic-nya sudah lewat cap, atau cap global tercapai. Cap topic yang stream-nya dipakai bersama tetap memicu ALERT: adminnya tetap diberi tahu, dan yang bisa dia lakukan adalah mempersempit query topic itu atau menaikkan cap-nya — bukan berharap sistem melambatkan sesuatu yang tidak akan menghemat apa pun.

Menutupi keterbatasan ini dengan throttle yang terlihat bekerja akan lebih buruk: angkanya tidak akan turun, dan orang menghabiskan waktu mencari kenapa cost guard "tidak jalan".

### Throttle diperiksa paling awal di scheduler

    if ditahan_biaya:  ← sebelum rate limit, sebelum "stream ramai"

Urutannya menentukan. Cabang "stream ramai" MEMPERCEPAT interval saat provider masih punya sisa hasil, dan stream yang sedang ramai justru yang paling cepat menghabiskan anggaran. Memeriksa cap setelahnya berarti cost guard kalah tepat pada stream yang paling membutuhkannya.

Throttle boleh melewati `dasar` (interval pilihan user), sama seperti rate limit: yang membatasi di sini bukan preferensi user, melainkan uang yang sudah habis.

Satu detail yang mencegah kebisingan: stream yang sudah berada di interval paling lambat dikembalikan sebagai TETAP, bukan sebagai perubahan. Tanpa itu, setiap stream menghasilkan satu tulisan database dan satu baris log per siklus selama cap-nya masih tercapai — dan justru selama itulah orang sedang membaca log-nya.

### Cap: database dulu, config sebagai cadangan

    1. baris `cost_cap`   override admin
    2. config             nilai bawaan

Config saja tidak cukup: cap yang hanya bisa diubah lewat deploy tidak bisa dinaikkan saat isu viral sedang berjalan, dan itu persis saat orang membutuhkannya. Tapi config tetap jadi lapis kedua, supaya sistem punya batas sejak hari pertama tanpa perlu ada yang mengisi tabelnya dulu.

Satu tabel untuk dua lingkup: `topic_id` NULL berarti global. Dua tabel terpisah akan menduplikasi kolom yang sama persis beserta jalur baca dan audit-nya, dan yang ketinggalan diperbarui adalah yang jarang dipakai.

Dua indeks unik parsial menjaga "paling banyak satu baris per lingkup". Yang global memakai indeks atas ekspresi `(topic_id IS NULL)` — cara Postgres menuliskan "cuma boleh ada satu". Tanpa itu, dua override untuk lingkup yang sama membuat cap yang berlaku bergantung urutan baca: bug yang hasilnya berubah-ubah tanpa ada yang mengubah apa pun.

Satu jebakan yang ditutup dengan test: mencari baris global harus memakai `IS NULL`, bukan `== None`. SQLAlchemy menerjemahkan yang kedua jadi `= NULL`, yang tidak pernah cocok dengan apa pun — dan setiap penyimpanan cap global akan membuat baris baru alih-alih memperbarui yang ada.

### Alasan wajib, dan perubahannya diaudit

Mengubah cap menuntut `alasan` minimal tiga karakter, dan perubahannya menulis baris audit dengan nilai sebelum dan sesudah (T-067). Cap yang dinaikkan tanpa alasan tercatat adalah cap yang tidak menahan apa pun: enam bulan kemudian tidak ada yang tahu apakah angka itu masih relevan atau sisa satu kejadian yang sudah lewat.

Ada juga batas atas `CAP_MAKS_USD` — bukan aturan produk, penjaga terhadap salah ketik yang menaikkan cap seribu kali lipat dan membuat cost guard tidak menahan apa pun. Dan `DELETE /cost/caps` mengembalikan cap ke nilai config: tanpa jalan kembali, satu override darurat yang dipasang setahun lalu tetap berlaku sampai ada yang ingat angka bawaannya berapa.

### Periodenya bulan kalender, bukan 30 hari bergulir

Cap-nya bulanan, dan "bulan" butuh satu definisi yang dipakai semua pihak — kalau pemeriksa cap memakai jendela bergulir sementara dashboard memakai bulan kalender, keduanya menampilkan angka berbeda untuk pertanyaan yang sama.

Dipilih kalender karena tagihan provider datang per bulan kalender, dan acceptance FR-701 adalah mencocokkan angka kita dengan tagihan itu. Jendela bergulir tidak akan pernah cocok dengan apa pun yang bisa dibandingkan. Zonanya UTC, sama dengan seluruh penyimpanan: memakai WIB akan membuat biaya tujuh jam pertama tiap bulan terhitung di bulan yang salah.

### Alert hanya saat tingkatnya NAIK

`perlu_alert` mengembalikan True cuma untuk kenaikan. Alert yang dikirim ulang tiap siklus selama tingkatnya tidak berubah akan membuat orang memasang filter di kotak masuknya — dan filter itu juga akan menelan alert yang berikutnya benar-benar penting.

Penurunan tidak memicu apa pun: pemulihan bukan kejadian yang membangunkan orang. Statusnya tetap terbaca kapan saja lewat `/cost/status`.

**Deviasi:** saluran pengiriman alert belum ada. "Alert ke admin" sekarang berarti satu baris log terstruktur dan tingkat yang terbaca di `/cost/status` — cukup untuk dilihat orang yang mencari, belum cukup untuk memberi tahu orang yang tidak sedang melihat. Pengirimannya (email, Slack) adalah T-073, dan sampai itu selesai cost guard ini mengandalkan seseorang membuka halamannya.

**Deviasi:** throttle-nya belum pernah benar-benar melambatkan fetch. Logikanya teruji sebagai fungsi murni, tapi yang memanggil scheduler dengan `ditahan_biaya` adalah collector — yang belum ditulis (T-068). Jalurnya siap; pemakaiannya menunggu.

**Deviasi:** migrasi `0003` belum dijalankan. Indeks unik parsialnya — bagian yang paling mudah salah — baru terbukti saat ada Postgres. Cara mengujinya dua baris: dua `INSERT` global harus ditolak yang kedua.

**Deviasi:** belum ada UI. Cap diubah lewat API; halaman biayanya T-070.

**Dampak biaya:** ini task yang MENGURANGI biaya, bukan menambah. Tambahannya satu query kecil ke tabel berisi belasan baris per siklus penjadwalan.

**Next:** T-070

---

## T-068 · Cost accounting — 2026-09-14

**FR:** FR-701 · **Status: `[~]`** — lihat Deviasi

**Dikerjakan:** Setiap panggilan provider sekarang punya jalur untuk mencatat biayanya ke `cost_record`, dan biaya per stream bisa dialokasikan ke topic secara proporsional. Membuka E9.

**File:** `packages/core/sma_core/cost/{__init__,tarif,store,alokasi}.py`, `services/worker/sma_worker/tasks/fetch.py`

**Verifikasi:** 1.373 test Python lolos di 60 berkas (dari 1.335/57); ruff, `ruff format --check`, mypy (117 berkas) bersih. Sisi web tidak tersentuh.

### Pembungkus, bukan pengingat

`FetchResult.cost` sudah wajib di tingkat tipe sejak T-011, jadi adapter tidak bisa lupa MENGHITUNG biayanya. Tapi menghitung bukan mencatat: hasil yang sudah berisi biaya tetap tidak berguna kalau pemanggilnya tidak menuliskannya, dan itu kelalaian yang tidak menimbulkan error apa pun — data masuk, biaya tidak tercatat, dan yang menemukan adalah tagihan.

CLAUDE.md menuliskan aturannya: "Jangan pernah menambahkan jalur kode yang memanggil provider tanpa mencatat biaya." Aturan yang harus diingat akan dilanggar. Jadi ditambahkan `fetch_tercatat(adapter, stream, cursor, sesi)` sebagai satu-satunya jalur yang sah, dan docstring `schedule_due_streams` sekarang menyebutnya — supaya orang yang menulis loop-nya nanti membacanya sebelum memanggil `adapter.fetch` langsung.

### Biaya dicatat juga saat fetch gagal di tengah

Provider menagih untuk apa yang sudah mereka kirim, termasuk saat koneksi putus setelah halaman ketiga. Adapter yang sudah menerima sebagian hasil melempar `BiayaParsialError` yang membawa biayanya; pembungkus mencatatnya lalu melempar ulang penyebab ASLINYA, jadi pemanggil menangani kegagalan yang sama seperti biasa dan tidak perlu tahu soal mekanisme pencatatan.

Tanpa jalur ini, kegagalan berulang jadi cara menghabiskan uang secara tak terlihat — dan justru kegagalan berulang yang paling sering terjadi. Kegagalan yang terjadi SEBELUM provider mengirim apa pun tetap tidak mencatat apa-apa: tidak ada yang ditagih.

### Proporsional terhadap post yang cocok, bukan dibagi rata

Biaya ditagih per stream, tapi pertanyaan yang diajukan orang selalu "topic ini menghabiskan berapa" — dan satu stream melayani banyak topic (FR-202), yang justru itu yang membuat model biayanya bekerja.

Pembagiannya mengikuti jumlah post dari stream itu yang benar-benar cocok tiap topic: stream yang 90% keluarannya cocok topic A menanggungkan 90% biayanya ke A. Pembagian rata ditolak sebagai aturan utama karena topic yang menyerap sepersepuluh keluaran sebuah stream akan terlihat sama mahalnya dengan yang menyerap sisanya — dan keputusan "topic mana yang dihentikan" diambil dari angka itu.

Pembagian rata tetap dipakai sebagai CADANGAN untuk stream yang punya topic tapi belum menghasilkan post cocok apa pun di rentang itu: stream baru, atau keyword yang sedang sepi. Biayanya nyata, dan membaginya rata lebih jujur daripada menyebutnya tidak bertuan.

Bobotnya dihitung dengan satu agregasi bersarang di OpenSearch (`stream_id` → `matched_topics`), bukan satu query per stream. Dengan 40 stream dan 108 topic, yang kedua berarti ribuan pencarian untuk menghasilkan satu tabel.

### Jumlahnya harus utuh, dan itu yang membuat acceptance 5% bisa diperiksa

Acceptance menyebut selisih maksimal 5% terhadap tagihan provider. Angka itu tidak bisa diperiksa sama sekali kalau laporannya kehilangan biaya di tengah jalan, jadi tiga tempat dijaga tidak membuang apa pun:

- `total_periode` tidak menyaring apa pun selain waktu — ada test yang memastikan SQL-nya tidak menyebut provider, platform, atau stream.
- `per_stream` menyertakan kunci `None` untuk biaya yang tidak terikat stream (panggilan yang gagal sebelum stream-nya diketahui, atau stream yang barisnya sudah dihapus lewat `ON DELETE SET NULL`).
- `HasilAlokasi` memisahkan `tak_teralokasi` alih-alih menyembunyikannya, dan `total` selalu sama dengan jumlah yang dimasukkan.

Tidak ada pembulatan di dalam alokasi. Membulatkan tiap bagian ke sen membuat jumlahnya meleset dari totalnya — tiga bagian dari sepuluh sen menghasilkan sembilan atau dua belas, tidak pernah sepuluh. Pembulatan dilakukan saat menampilkan.

### `total_usd` disimpan, bukan dihitung ulang

Kolomnya redundan terhadap `unit_count × unit_cost_usd`, dan itu disengaja. Tarif provider berubah seiring waktu; baris tahun lalu harus tetap menunjukkan biaya yang benar-benar dibayar saat itu, bukan hasil perkalian dengan tarif hari ini. Laporan historis yang berubah angkanya setiap kali harga naik tidak bisa dipakai membandingkan apa pun.

### Rentang setengah terbuka, di kedua sisi

`mulai <= occurred_at < selesai`, sama seperti audit log T-067. Dan bobot dari OpenSearch memakai rentang yang sama persis — kalau berbeda, bobot dan biayanya menghitung himpunan post yang berbeda, dan alokasinya salah tanpa ada yang bisa menunjuk sebabnya.

### `sma_core/cost.py` jadi paket

Dulu satu berkas berisi tarif saja. Sekarang tiga hal berkumpul di sana dan masing-masing berubah karena alasan berbeda: tarif berubah kalau provider menaikkan harga, store berubah kalau skemanya berubah, alokasi berubah kalau aturannya berubah. Impor lama (`from sma_core import cost`) tetap bekerja.

**Deviasi — ini yang membuat task-nya `[~]`:** dua dari tiga acceptance belum terbukti.

Pertama, **loop collector-nya belum ada.** `schedule_due_streams` masih stub yang menunggu adapter lepas dari `[~]`, jadi `fetch_tercatat` belum pernah dipanggil di produksi. Yang sudah ada: jalurnya, dan penanda di tempat yang akan membacanya.

Kedua, **belum ada tagihan provider untuk dibandingkan.** "Selisih maksimal 5%" butuh satu bulan operasi berbayar. Yang bisa dipastikan sekarang cuma sifat yang lebih lemah tapi perlu: alokasinya tidak pernah membuang biaya, dan ada test yang menjumlahkan ulang untuk membuktikannya.

**Deviasi:** Postgres dan OpenSearch diganti palsu — yang diperiksa SQL yang tersusun dan badan agregasi yang disusun, bukan hasil eksekusinya. Bagian dari verifikasi Docker/VPS.

**Dampak biaya:** tidak menambah panggilan provider apa pun. Satu INSERT per panggilan yang sudah terjadi, dan satu agregasi OpenSearch saat laporan biaya diminta.

**Next:** T-069

---

## T-067 · Audit log — 2026-09-14

**FR:** FR-603

**Dikerjakan:** Tujuh operasi sekarang meninggalkan jejak: membuat topic, mengubahnya, mengganti query, menyimpan demografi, mengaktifkan, mengubah penugasan topic, dan login — berhasil maupun gagal. Masing-masing menyimpan nilai sebelum dan sesudah, bisa dicari per aktor dan rentang tanggal, dan tidak bisa diubah. Menutup E8.

**File:** `services/api/sma_api/audit/{pencatat,repo,router}.py`, `migrations/versions/0002_audit_append_only.py`, plus pemasangan di `topics/router.py`, `users/router.py`, dan `auth/router.py`

**Verifikasi:** 1.335 test Python lolos di 57 berkas (dari 1.285/54); 611 test web lolos di 24 berkas (tidak berubah — T-067 tidak menyentuh dashboard); ruff, `ruff format --check`, mypy (113 berkas), eslint, `tsc --noEmit`, dan `next build` bersih.

### Audit ikut transaksi perubahannya

`catat()` memanggil `sesi.add` dan tidak commit. Barisnya ikut transaksi pemanggil, dan itu yang membuat satu kelas kegagalan jadi mustahil: perubahan yang di-rollback membatalkan catatannya, dan catatan yang gagal ditulis membatalkan perubahannya.

Konsekuensinya diambil dengan sadar: kegagalan menulis audit menggagalkan operasinya juga. Alternatifnya — menulis audit di luar transaksi, atau menelan errornya — menghasilkan sistem yang perubahannya tersimpan sementara jejaknya hilang, dan itu ketahuan justru saat ada yang mencarinya. Audit yang boleh gagal diam-diam bukan audit.

Satu pengecualian, dan alasannya berbeda: audit untuk login yang GAGAL punya transaksinya sendiri. Di jalur itu tidak ada perubahan yang perlu dilindungi, dan jawaban yang benar tetap 401 — menjadikannya 500 karena audit tidak bisa ditulis akan menukar penolakan yang benar dengan kesalahan server, dan sekaligus memberi tahu penebak bahwa sesuatu berubah.

### Yang disimpan cuma yang berubah

    before  {"name": "LAMA"}
    after   {"name": "BARU"}

Bukan seluruh baris di kedua sisi. Menyimpan semuanya membuat "apa yang berubah" harus dicari dengan mata di antara dua puluh field yang identik — dan pada topic yang disimpan sepuluh kali sehari, itu dua puluh kali lipat data yang tidak pernah dibaca.

Kuncinya sengaja sama persis di kedua sisi, termasuk untuk field yang HILANG (muncul sebagai `null` di `after`). Menyaring yang hilang akan membuat penghapusan tidak terlihat di audit sama sekali.

Perubahan yang tidak mengubah apa pun tidak menghasilkan baris. Formulir yang disimpan ulang tanpa diubah adalah hal yang sering terjadi, dan mencatatnya akan mengubur perubahan sungguhan di antara puluhan baris yang tidak mengatakan apa-apa.

### Potret diambil sebelum, bukan sesudah

    sebelumnya = _potret_topic(baris, sebagian.keys())
    repo.ubah_topic(sesi, baris, sebagian)

Urutan yang terbalik terlihat wajar dan menghasilkan audit yang bohong: `ubah_topic` menyetel atribut pada baris ORM yang SAMA, jadi membacanya sesudahnya menghasilkan dua salinan nilai baru. `before` dan `after` jadi identik, selisihnya kosong, dan tidak ada baris audit yang ditulis sama sekali — kegagalan yang tidak menimbulkan error apa pun. Ada test khusus untuknya.

### Email login gagal: disimpan, kecuali kalau tidak dikenal

T-064 sengaja menjauhkan email dari log aplikasi: log itu berakhir di penyimpanan yang aturan aksesnya berbeda dari database. Audit log berbeda — ia ADA di Postgres, cuma bisa dibaca admin, dan justru gunanya menyebut siapa.

Tapi ada satu kasus yang tidak boleh disimpan: alamat yang tidak cocok akun mana pun. Kolom email yang isinya bukan akun siapa pun paling sering berisi password yang salah ketik ke kolom sebelahnya, dan menyimpannya berarti menaruh password orang di tabel yang dibaca admin. Jadi email dicatat hanya kalau akunnya ada; sisanya jadi `(tidak dikenal)`.

Di atas itu ada daftar larangan yang berlaku untuk SEMUA pemanggilan: `password`, `password_hash`, `token`, `secret` tidak pernah masuk, berapa pun bentuk `sesudah` yang dikirim pemanggil. Hash password yang tercatat di audit adalah hash password yang bocor lewat jalur yang tidak pernah dianggap sebagai penyimpanan kredensial.

### "Tidak bisa diubah" dijamin di tiga lapis

1. **Tidak ada fungsinya.** Modul `pencatat` cuma bisa menambah, modul `repo` cuma bisa membaca, dan ada test yang memeriksa daftar fungsinya — fungsi bernama `ubah_*` atau `hapus_*` di kedua modul menggagalkan build.
2. **Tidak ada endpointnya.** Router audit hanya GET. Baris audit lahir sebagai efek samping operasi lain, bukan dari permintaan yang mengaku sebagai audit.
3. **Trigger database.** UPDATE dan DELETE pada `audit_log` melempar exception, dari aplikasi maupun dari psql.

Lapis ketiga melebihi bunyi acceptance, dan ditambahkan karena dua lapis pertama berumur sampai orang berikutnya menambahkan satu fungsi. `sesi.delete(baris)` pada ORM tidak akan ditolak apa pun tanpa lapis ketiga.

Yang TIDAK dijaga, dan disebut di migrasinya: superuser masih bisa mematikan trigger-nya, dan `TRUNCATE` melewati trigger baris. Menutup keduanya butuh pemisahan hak akses di tingkat Postgres, dan itu penyiapan produksi — bukan migrasi skema.

### Rentang pencarian setengah terbuka

`mulai <= created_at < selesai`. Batas atas yang inklusif membuat baris tepat di detik terakhir muncul di DUA halaman rentang yang bersebelahan, dan jumlah per rentang tidak pernah menjumlah ke total.

Urutannya terbaru dulu, dengan `id` sebagai pemecah seri. Tanpa pemecah seri, dua baris dengan `created_at` identik — satu transaksi, satu `now()` — bisa bertukar tempat antar halaman, dan baris yang sama muncul dua kali sementara yang lain hilang.

### Modulnya bernama `pencatat`, bukan `catat`

Paket ini mengekspor fungsi `catat`, jadi `from sma_api.audit import catat` menghasilkan FUNGSINYA dan menutupi modul yang sama namanya. Yang mengimpor modulnya berakhir dengan `AttributeError` pada konstanta yang jelas-jelas ada di berkasnya — kesalahan yang butuh waktu lama untuk dipercaya. Ketahuan saat menulis test-nya, dan modulnya diganti nama.

**Deviasi:** tidak ada halaman audit di dashboard. Pencariannya lewat API (`GET /api/v1/audit`, admin saja), dan tidak ada task Fase 1 yang meminta UI-nya. Acceptance-nya terpenuhi — "bisa dicari berdasarkan aktor dan rentang tanggal" — tapi yang bisa memakainya sekarang cuma orang yang nyaman dengan `curl`.

**Deviasi:** trigger di migrasi `0002` BELUM pernah dijalankan. Migrasinya butuh Postgres, dan lingkungan test belum punya. Ini bagian pertama verifikasi Docker/VPS untuk E8, dan cara mengujinya satu baris: `UPDATE audit_log SET action = 'x'` harus ditolak.

**Deviasi:** retensi tidak diatur. Tabelnya tumbuh selamanya — disengaja untuk sekarang. Pemangkasannya nanti harus lewat prosedur yang mematikan trigger dengan sengaja, justru supaya penghapusan audit tidak pernah jadi operasi biasa yang berjalan otomatis tiap malam.

**Dampak biaya:** tidak ada panggilan provider. Satu INSERT tambahan per operasi tulis; operasi baca tidak terpengaruh sama sekali.

**Next:** T-068

---

## T-066 · Proteksi route & API — 2026-09-14

**FR:** FR-602

**Dikerjakan:** Model izin dari T-065 dipasang ke SETIAP endpoint yang sudah ada, plus penjaga route di sisi web. Sampai kemarin sistem ini punya tabel kewenangan yang hampir tidak dipakai siapa pun; sekarang tiga belas endpoint memeriksa pemanggilnya, dan FR-602 terpenuhi.

**File:** `services/api/sma_api/topics/{router,repo}.py`, `services/api/sma_api/analytics/router.py`, `apps/web/components/auth/{sesi-provider,penjaga-route}.tsx`, `apps/web/app/layout.tsx`, `apps/web/lib/nav.ts`, `apps/web/lib/uji/ketik.ts`, `tests/api/conftest.py`

**Verifikasi:** 1.285 test Python lolos di 54 berkas (dari 1.266/53); 611 test web lolos di 24 berkas (dari 595/23); ruff, `ruff format --check`, mypy (109 berkas), eslint, `tsc --noEmit`, dan `next build` bersih.

### Daftar disaring, satu topic ditolak

Dua jalur yang sama-sama membaca topic, dijawab berbeda dengan sengaja:

    GET /topics          disaring — viewer melihat yang ditugaskan saja
    GET /topics/{id}     403      — kalau bukan haknya

403 pada daftar cuma menghasilkan halaman kosong tanpa alasan yang bisa dibaca: viewer yang ditugaskan tiga topic akan melihat penolakan, bukan tiga topic miliknya. Sebaliknya, menyaring pada satu topic berarti menjawab 404 untuk topic yang jelas-jelas ada, dan orang akan menyimpulkan topic itu terhapus lalu membuat laporan tentang data yang hilang.

Acceptance FR-602 menyebut yang kedua persis: "viewer yang mengakses topic tak berizin lewat URL langsung dapat 403, bukan halaman kosong".

### Izin diperiksa sebelum cache, dan itu bukan detail

Endpoint dashboard menyimpan hasilnya di Redis dengan kunci yang memuat filter dan generasi topic — bukan identitas peminta. Dua orang dengan hak berbeda yang meminta topic yang sama berbagi entri yang sama, dan itu memang tujuannya.

Konsekuensinya: kalau izin diperiksa SETELAH cache dibaca, viewer yang tidak berhak dilayani penuh dari entri yang dihangatkan analis sepuluh detik sebelumnya. Tidak ada query yang berjalan atas namanya, jadi tidak ada jejak apa pun di log OpenSearch — kebocoran yang tidak meninggalkan bekas.

Ada test yang mengunci urutannya: ia mengganti `boleh_dicache` dengan penghitung dan memastikan penghitung itu TIDAK pernah tersentuh saat permintaannya ditolak.

### Preview dan validate-query butuh izin MENULIS

Keduanya terlihat seperti endpoint baca, dan keduanya tidak menyebut topic sama sekali. Justru itu masalahnya: tanpa topic, lingkup topic tidak membatasi apa pun, dan `preview` menjalankan boolean query karangan pemanggil terhadap SELURUH korpus.

Membukanya untuk `TOPIC_READ` berarti memberi viewer jalan membaca post di luar topic yang ditugaskan kepadanya — lewat query yang dia tulis sendiri. Jadi keduanya butuh `TOPIC_WRITE`, yang di tabel kewenangan cuma dimiliki admin.

Ini contoh kenapa izin dan lingkup dipisah di T-065: endpoint tanpa resource tidak bisa dijaga oleh lingkup, dan yang menahannya harus permission.

### Urutan 404 dan 403

    baris = _ambil_atau_404(sesi, topic_id)
    pastikan_boleh_topic(sesi, user, topic_id)

Bukan sebaliknya. Memeriksa izin lebih dulu terlihat lebih aman — tidak ada query yang berjalan untuk orang yang tidak berhak — tapi efeknya topic yang memang TIDAK ADA dijawab 403. Untuk admin, yang lingkupnya seluruh topic, itu berarti URL salah ketik dijawab "tidak berwenang", dan orang mengira dirinya kehilangan akses.

Biayanya satu pembacaan primary key untuk permintaan yang akan ditolak. Itu ditukar dengan 404 yang tetap berarti "tidak ada".

### Daftar putih, bukan daftar hitam

Halaman yang boleh dibuka tanpa sesi didaftar eksplisit (`TANPA_SESI = ["/login"]`), dan segala yang lain tertutup. Arah gagalnya yang menentukan: halaman baru yang lupa didaftarkan jadi TERTUTUP dan langsung ketahuan saat dibuka. Dengan daftar hitam, halaman yang lupa dimasukkan jadi TERBUKA, dan tidak ada apa pun yang mengatakannya.

Hal yang sama berlaku di sisi server lewat bentuk yang berbeda: penjaga dipasang sebagai parameter dependency di tiap fungsi endpoint, dan ada test yang menyapu seluruh daftar endpoint tulis sekaligus. Endpoint tulis yang lupa penjaganya tidak menimbulkan error apa pun sampai ada yang memakainya — jadi yang harus menemukannya adalah test, bukan pengguna.

### Empat keadaan di penjaga route, dan yang paling mudah salah

    memuat        belum tahu       tahan, jangan render apa pun
    galat         tidak bisa tahu  tawarkan coba lagi, JANGAN usir ke login
    tanpa sesi    belum masuk      alihkan ke /login?next=
    sesi kurang   bukan haknya     tampilkan penolakan, jangan alihkan

Baris kedua yang paling sering disamakan dengan ketiga. Server yang sedang tidak menjawab terlihat persis seperti "belum masuk" kalau tidak dibedakan — dan mengusir orang ke halaman login saat sesinya sebenarnya masih hidup membuat mereka mengetik password untuk masalah yang bukan miliknya.

Baris keempat juga disengaja: mengalihkan orang yang SUDAH masuk ke halaman login adalah lingkaran. Dia punya identitas; yang kurang kewenangannya, dan login ulang tidak mengubah itu.

Baris pertama menahan seluruh isi halaman, bukan merendernya sambil menunggu. Merendernya lebih dulu berarti panel-panelnya menembak API yang akan menjawab 401, dan yang terlihat adalah halaman penuh galat sekejap sebelum dialihkan.

### Satu `/auth/me` per halaman

Header dan penjaga route sama-sama butuh identitas, dan keduanya sempat memanggil `useSaya()` sendiri — dua permintaan identik ke endpoint yang membaca database, di setiap muat halaman. Ditambahkan `<SesiProvider>` yang memanggilnya sekali dan membagikan hasilnya.

`useSesi()` MELEMPAR kalau dipakai di luar provider, bukan menjawab "belum masuk". Komponen yang lupa dibungkus akan terlihat seperti pengguna anonim, dan yang tampil adalah halaman login untuk orang yang sebenarnya sudah masuk — kesalahan yang sulit ditelusuri ke penyebabnya.

### Test yang mengetik terlalu pelan, lagi

T-064 sudah menemukannya sekali; kali ini muncul di berkas lain. `user.type` mengirim satu event per karakter, tiap karakter merender ulang input terkontrol, dan saat suite-nya tumbuh jadi 24 berkas yang masing-masing menyiapkan jsdom sendiri, test yang seharusnya selesai dalam ratusan milidetik melewati batas waktunya.

Yang membuatnya sulit didiagnosis: test yang kehabisan waktu di tengah pengetikan meninggalkan ketikan yang belum selesai, dan sisanya mendarat di formulir test BERIKUTNYA yang kebetulan sudah ter-fokus. Kegagalannya muncul di test yang tidak bersalah.

Dibuat `lib/uji/ketik.ts` dan seluruh pengisian formulir di test admin diganti ke `paste` — satu event, jalur `onChange` yang sama. Yang diuji formulir-formulir itu memang bukan pengetikannya; kalau suatu saat ada yang perlu menguji perilaku per karakter, di sana `user.type` tetap alat yang benar.

### Sesi bawaan untuk test yang menguji hal lain

Sejak semua endpoint menolak permintaan tanpa sesi, puluhan test yang memeriksa bentuk respons panel atau penanganan galat ikut gagal 401 — padahal bukan itu yang mereka uji. `tests/api/conftest.py` memasang sesi admin otomatis, dan berkas yang justru menguji kewenangan melepasnya lewat marker `tanpa_sesi_bawaan`.

Defaultnya sengaja "ada sesi", bukan "tidak ada". Kalau sebaliknya, setiap test baru yang memanggil endpoint gagal 401 dengan pesan yang tidak menjelaskan apa-apa, dan orang akan menambahkan fixture-nya secara refleks tanpa membaca apa yang dilonggarkan.

**Deviasi:** penegakannya diuji dengan session dan klien OpenSearch palsu. Yang dibuktikan test: kode status untuk tiap kombinasi role dan endpoint, urutan 404-sebelum-403, dan bahwa pencarian tidak pernah berjalan untuk permintaan yang ditolak. Yang BELUM: satu pun penolakan sungguhan terhadap Postgres berisi baris `user_topic`. Urutan verifikasi manualnya: buat satu viewer, tugaskan satu topic, lalu buka topic lain lewat URL langsung.

**Deviasi:** `/health` dan `/health/live` tetap terbuka. Itu disengaja — load balancer tidak punya sesi, dan health check yang butuh login akan membuat instance yang sehat ditandai mati. Isinya sudah tidak menyebut detail infrastruktur.

**Dampak biaya:** kecil dan searah menghemat. Permintaan dashboard yang ditolak sekarang berhenti sebelum menyentuh OpenSearch, jadi agregasi yang tidak berhak tidak pernah dijalankan. Penambahannya satu query primary key per request untuk viewer; admin dan analis tidak menyentuh tabel penugasan sama sekali.

**Next:** T-067

---

## T-065 · Model role & permission — 2026-09-14

**FR:** FR-602

**Dikerjakan:** Tiga role terdefinisi dalam satu tabel kewenangan, viewer bisa ditugaskan ke topic tertentu lewat endpoint admin, dan penolakannya terjadi di server. Header dashboard mulai menyembunyikan kontrol yang tidak akan diizinkan.

**File:** `packages/core/sma_core/auth/rbac.py`, `packages/schema/sma_schema/{enums,user}.py`, `services/api/sma_api/auth/{izin,router}.py`, `services/api/sma_api/users/{repo,router}.py`, `apps/web/lib/api/auth.ts`, `apps/web/components/shell/app-header.tsx`

**Verifikasi:** 1.266 test Python lolos di 53 berkas (dari 1.205/49); 595 test web lolos di 23 berkas (dari 586); ruff, `ruff format --check`, mypy (109 berkas), eslint, `tsc --noEmit`, dan `next build` bersih.

### Kode menyebut permission, bukan role

    Depends(butuh_izin(Permission.TOPIC_WRITE))     dipakai
    if user.role == "admin"                         tidak

Keduanya menghasilkan perilaku yang sama hari ini. Bedanya terasa saat role keempat muncul — misalnya "auditor" yang boleh membaca audit log dan tidak boleh apa-apa lagi. Dengan pemetaan, yang berubah satu tabel di `sma_core/auth/rbac.py`. Dengan perbandingan role langsung, yang berubah setiap pemeriksaan yang tersebar di sepuluh berkas, dan yang terlewat tidak menimbulkan error — cuma memberi akses kepada orang yang salah.

Tabelnya sendiri diuji baris per baris, bukan cuma "fungsinya jalan". Ada test yang memastikan setiap role punya entri (role tanpa entri melempar KeyError di tengah request), bahwa viewer tidak pernah lebih luas dari analyst, dan bahwa setiap permission dimiliki setidaknya satu role — permission yatim adalah endpoint yang tidak bisa dipakai siapa pun.

### Dua lapis: permission dan lingkup

Permission menjawab "boleh membaca topic?". Lingkup menjawab "topic yang MANA?". Viewer dan analyst sama-sama punya `TOPIC_READ`; yang membedakan lingkupnya.

Memisahkannya penting karena mode kegagalannya berbeda:

    permission salah   menolak orang yang seharusnya boleh — langsung dikeluhkan
    lingkup salah      MEMBERI data yang bukan haknya — tidak ada yang mengeluh

Yang kedua adalah alasan lapisan ini ditulis dengan hati-hati, dan alasan keputusan berikutnya dijaga di tiga tempat sekaligus.

### Daftar penugasan kosong berarti TIDAK ADA, bukan "tanpa batasan"

Ini bug RBAC yang paling sering terjadi: daftar penugasan kosong diperlakukan sebagai filter kosong, lalu viewer yang belum diberi topic apa pun justru melihat semuanya. Sistemnya tidak error, tidak ada log yang aneh, dan yang menemukan biasanya orang yang tidak seharusnya melihat.

Jadi bedanya dinyatakan eksplisit di tiga lapis, dengan test di masing-masing:

- `rbac.boleh_akses_topic` menolak kalau himpunannya kosong
- `izin.lingkup_topic_user` mengembalikan `None` untuk "seluruh topic" dan himpunan kosong untuk "tidak ada satu pun" — dua nilai yang berbeda, dan pemanggilnya wajib membedakannya
- `auth.ts` di sisi web memakai `null` dan `[]` dengan arti yang sama persis

Tiga salinan aturan yang sama adalah harga yang dibayar dengan sengaja. Alternatifnya satu salinan di server dan klien yang menebak — dan klien yang menebak ke arah longgar menampilkan topic yang lalu ditolak server, halaman penuh galat yang terlihat seperti kerusakan.

### Role yang tidak dikenal jatuh ke viewer

`ke_role("superadmin")` menghasilkan `VIEWER`, bukan exception. Baris user dengan role kacau — hasil impor, migrasi setengah jalan, atau ketikan di SQL langsung — harus jatuh ke kewenangan paling sempit.

Dua alternatifnya lebih buruk. Melempar membuat SETIAP request user itu jadi 500, termasuk halaman yang seharusnya bisa dia buka. Menebak ke atas memberi kewenangan kepada baris yang justru paling mencurigakan.

### 403, bukan 404

FR-602 menyebutnya persis: viewer yang membuka topic tak berizin lewat URL langsung mendapat 403, bukan halaman kosong. Pilihan itu tidak netral — 404 menyembunyikan keberadaan topic tersebut, 403 mengakui topic itu ada tapi bukan haknya.

Dipilih 403 karena penggunanya satu instansi, bukan publik. Di sini "topic itu ada, mintalah aksesnya" adalah jawaban yang berguna; 404 mengirim orang mencari-cari topic yang dikira hilang dan berakhir jadi tiket dukungan.

Yang tetap 404 adalah topic yang memang tidak ada, dan itu sebabnya `pastikan_boleh_topic` bukan dependency: dia dipanggil SETELAH topic-nya dibaca. Memeriksa izin lebih dulu akan mengubah "topic tidak ada" jadi "tidak berwenang" untuk admin sekalipun.

### Penugasan berlaku tanpa perlu logout

Buah langsung dari keputusan T-064 menyimpan cuma id user di sesi. Admin yang mencabut penugasan seorang viewer berlaku di request berikutnya, bukan delapan jam kemudian. Harganya satu query ke tabel dua kolom yang ter-index primary key — dan admin tidak menyentuh tabel itu sama sekali, karena lingkupnya diputuskan dari role sebelum ada query.

### Yang ditolak endpoint penugasan

Tiga penolakan yang ditambahkan karena diam-diam menerimanya lebih berbahaya daripada menolak:

- **Topic yang tidak ada (atau sudah dihapus lunak) tidak ikut disimpan**, dan id-nya dikembalikan sebagai `diabaikan`. Kalau diterima diam-diam, admin melihat "5 topic ditugaskan" padahal yang terlihat viewer cuma 3 — selisih yang tidak punya penjelasan di mana pun.
- **Menugaskan topic ke admin atau analyst dijawab 409.** Role mereka sudah menjangkau seluruh topic; menyimpannya akan membuat admin mengira sudah membatasi seseorang.
- **Membaca penugasan admin/analyst menjawab `seluruh_topic: true`**, bukan daftar kosong. Daftar kosong di layar terbaca sebagai "tidak punya akses" — kebalikan dari keadaan sebenarnya.

### UI menyembunyikan, server menolak

Tautan Topic & Account sekarang cuma muncul untuk yang punya `TOPIC_WRITE`. Itu kenyamanan, bukan pengaman — dan perbedaannya ditulis di komentarnya supaya tidak ada yang menyimpulkan endpoint-nya sudah aman karena tombolnya hilang. Penjaga route-nya sendiri baru datang di T-066.

Daftar permission datang dari server lewat `/auth/me`, tidak disimpulkan dari role di TypeScript. Menyalin peta role-ke-permission ke klien berarti dua salinan yang akan berbeda perlahan, dan bedanya muncul sebagai tombol yang terlihat lalu ditolak server. Ada test yang menguncinya: user ber-role `admin` tapi `permissions` cuma `["topic:read"]` TIDAK melihat tautan itu — kalau UI menyimpulkan sendiri dari role, test itu gagal.

Tautannya juga ditahan selama sesi masih diperiksa, bukan ditampilkan lalu disembunyikan. Tautan yang sempat terlihat akan dicoba.

**Deviasi:** endpoint analytics dan topic yang sudah ada belum memakai penjaga ini sama sekali. Model izinnya jadi, tapi yang memakainya baru endpoint `/users`. Sampai T-066 selesai, viewer masih bisa memanggil `/api/v1/topics` mana pun lewat `curl`. Itu pembagian yang disengaja antara kedua task, bukan kelalaian — tapi artinya FR-602 BELUM terpenuhi sampai T-066 selesai.

**Deviasi:** role belum bisa diubah lewat API, dan akun masih dibuat lewat `python -m sma_api.auth.buat_user`. Alasannya audit log: FR-603 meminta perubahan user tercatat dengan nilai sebelum dan sesudah, dan itu T-067.

**Deviasi:** Postgres diganti palsu di seluruh test — yang diperiksa adalah SQL yang tersusun (`DELETE` yang disaring per user, `deleted_at IS NULL` pada pemeriksaan topic), bukan hasil eksekusinya. Bagian dari verifikasi manual Docker/VPS.

**Dampak biaya:** tidak ada.

**Next:** T-066

---

## T-064 · Autentikasi — 2026-09-14

**FR:** FR-601

**Dikerjakan:** Login, logout, dan sesi yang mati setelah 8 jam tidak dipakai. Password di-hash Argon2id, percobaan login dibatasi dua penghitung, dan header sekarang menampilkan identitas sungguhan menggantikan placeholder dari T-048. Membuka E8.

**File:** `packages/core/sma_core/auth/password.py`, `services/api/sma_api/auth/{sesi,ratelimit,repo,deps,router,buat_user}.py`, `packages/schema/sma_schema/user.py`, `apps/web/lib/api/{auth,use-saya}.ts`, `apps/web/app/login/page.tsx`, `apps/web/components/auth/form-login.tsx`, `apps/web/components/shell/app-header.tsx`, `apps/web/vitest.config.mts`, `README.md`

**Verifikasi:** 1.205 test Python lolos di 49 berkas (dari 1.132/45); 586 test web lolos di 23 berkas (dari 553/21); ruff, `ruff format --check`, mypy (104 berkas), eslint, `tsc --noEmit`, dan `next build` bersih (`/login` 2,18 kB).

### Parameter Argon2 dipilih dari pengukuran, bukan dari kutipan

Angka yang paling sering dikutip untuk Argon2id adalah RFC 9106 opsi kedua: t=3, m=64 MiB, p=4. Diukur dulu sebelum dipakai:

    m=64 MiB  t=3  p=4     hash 573 ms   verify 740 ms
    m=64 MiB  t=3  p=1     hash 362 ms   verify 356 ms
    m=19 MiB  t=2  p=1     hash  76 ms   verify  73 ms

Dua hal terbaca di situ. `p=4` justru MEMPERLAMBAT — biaya koordinasi thread-nya lebih besar daripada hasilnya, dan di VPS yang core-nya dipakai bersama OpenSearch keadaannya tidak akan lebih baik.

Yang menentukan adalah baris pertama: 740 ms per verifikasi berarti tiap percobaan login menahan satu thread hampir satu detik. Lima penebak paralel sudah cukup membuat API berhenti melayani. Rate limit menahan penebakan agar tidak MENEMBUS, tapi request-nya tetap harus diproses dulu — jadi pertahanan password yang dipasang terlalu keras berubah jadi lubang ketersediaan.

Dipakai anjuran OWASP: m=19 MiB, t=2, p=1. Tetap Argon2id sesuai FR-601, ~75 ms, dan memori per login serentak turun dari 64 MiB ke 19 MiB. Parameternya ikut tersimpan di dalam hash, jadi menaikkannya nanti tidak mengunci siapa pun: `perlu_hash_ulang` memperbarui hash lama saat orangnya login — satu-satunya saat password aslinya ada di memori.

### Token opaque di Redis, bukan JWT

FR-601 meminta dua hal yang JWT tidak berikan: sesi yang mati setelah 8 jam **tidak aktif**, dan logout yang benar-benar mematikan sesi. JWT tidak bisa dicabut — logout pada JWT berarti menghapus token di browser dan berharap tidak ada salinan lain. Dan "idle" pada JWT berarti menerbitkan ulang token di hampir setiap request.

Keduanya sederhana kalau kebenarannya ada di server: TTL diperpanjang tiap kali sesi dipakai, logout menghapus satu kunci. Ada batas umur mutlak 30 hari di atasnya, karena sesi yang disentuh sekali tiap tujuh jam jika tidak akan hidup selamanya — dan sesi yang tidak pernah berakhir adalah sesi yang tidak pernah perlu dicuri dua kali.

Yang tersimpan di Redis adalah SHA-256 tokennya, bukan tokennya. Isi Redis bisa terlihat lewat backup, replika, atau `MONITOR`; kalau tokennya tersimpan apa adanya, siapa pun yang melihat isi itu bisa langsung memakainya untuk masuk.

Konsekuensinya sesi ikut mati kalau Redis mati. Itu diterima: tanpa Redis, rate limit login juga tidak jalan, dan menerima login tanpa rate limit lebih buruk daripada meminta orang login lagi.

### Yang disimpan di sesi cuma id user

Bukan role, bukan nama. Role yang disalin ke sesi berarti admin yang menurunkan seseorang jadi viewer tidak berlaku sampai orang itu logout — delapan jam ke depan dia masih admin. Membaca baris user tiap request harganya satu lookup primary key, dan sekaligus membuat penonaktifan akun berlaku di request berikutnya.

Ini keputusan yang baru berbuah di T-065 dan T-066, tapi harus diambil sekarang: mengubahnya nanti berarti mengubah bentuk sesi setelah ada sesi yang berjalan.

### Dua penghitung rate limit, karena ada dua serangan

    per email   satu akun dicoba dengan banyak password
    per IP      banyak akun dicoba dengan password yang sama

Menghitung per email saja tidak menghentikan yang kedua: password spraying justru dirancang supaya tiap akun cuma dicoba sekali atau dua kali, jauh di bawah ambang mana pun yang masuk akal per akun. Yang dihitung cuma percobaan GAGAL, dan login berhasil menghapus hitungannya — kalau tidak, orang yang salah ketik sekali lalu bekerja seharian bisa terkunci karena memakai sistemnya.

Ada konsekuensi yang disengaja: penyerang bisa mengunci akun orang lain dengan sengaja salah password. Itu ditukar dengan perlindungan terhadap penebakan, dan durasinya dibuat 15 menit — bukan sampai admin membuka — supaya biaya kesalahannya terbatas.

### Halaman login tidak boleh jadi alat verifikasi daftar email

Email tidak dikenal dan password salah dijawab dengan pesan yang sama. Kalau dibedakan, siapa pun bisa mengetes ribuan alamat dan tahu mana yang punya akun di sini; untuk sistem yang penggunanya petugas instansi, daftar itu sendiri sudah informasi yang tidak perlu diberikan.

Alasan yang sama berlaku untuk WAKTUNYA, dan ini bagian yang paling mudah terlewat. Kalau email tak dikenal dijawab langsung sementara email nyata menunggu Argon2 selesai, selisihnya sendiri sudah jadi jawabannya. Jadi email yang tidak ditemukan tetap menjalankan verifikasi terhadap hash boneka, dan ada test yang memastikan verifikasi itu benar-benar dipanggil.

Formulir di sisi klien juga tidak memvalidasi panjang password. Menolak "terlalu pendek" sebelum mengirim memberi tahu penyerang bahwa tebakannya bahkan tidak sempat diperiksa.

### 401 dan 503 dibedakan dengan sungguh-sungguh

Dua kegagalan yang mudah disamakan dan sangat berbeda akibatnya:

    401   kredensialnya memang tidak ada atau sudah mati
    503   kami tidak bisa memeriksanya sekarang

Menjawab 401 saat Redis mati akan membuat seluruh pengguna terlihat ter-logout serentak, dan setiap orang mencoba login lagi — persis beban tambahan yang tidak dibutuhkan sistem yang sedang bermasalah. Header di sisi web mengikuti pembedaan itu: ia punya tiga keadaan (belum tahu, sudah masuk, belum masuk) plus pesan tersendiri untuk sesi yang tidak bisa DIPERIKSA.

Logout sengaja tidak memerlukan sesi yang sah dan selalu menjawab 204. Logout yang menjawab 401 saat sesinya sudah kedaluwarsa meninggalkan cookie mati di browser dan membuat tombol Keluar terlihat rusak justru di keadaan paling wajar.

### Cookie tanpa Max-Age

Cookie-nya `HttpOnly`, `SameSite=Lax`, `Secure` hanya di produksi — dan sengaja TANPA umur tetap. Yang menentukan umur sesi adalah TTL di Redis, dan itu diperpanjang tiap kali dipakai. Cookie ber-`Max-Age` 8 jam justru salah untuk "8 jam tidak aktif": orang yang bekerja terus akan tetap terlempar keluar tepat di jam kedelapan.

`HttpOnly` berarti kode di halaman tidak pernah bisa membaca tokennya. Itu sebabnya token tidak dikembalikan di body sama sekali — tempat mana pun yang bisa dibaca JavaScript bisa dibaca juga oleh skrip pihak ketiga yang kebetulan masuk ke halaman.

### Test yang gagal karena mengetik terlalu pelan

Test formulir login sempat gagal dengan cara yang menyesatkan: argumen yang diterima berisi dua salinan email yang saling bersisipan. Penyebabnya bukan logika — `user.type` mengirim satu event per karakter, dan 21 karakter ke input terkontrol memakan 4 detik saat mesinnya sibuk. Test-nya kehabisan waktu di tengah pengetikan, lalu ketikan yang tertinggal mendarat di formulir test BERIKUTNYA yang kebetulan sudah ter-fokus.

Diganti `paste`: satu event, jalur `onChange` yang sama. Yang diuji formulir ini memang bukan pengetikannya.

Masalah kedua muncul dari arah yang sama: satu test T-062 yang sudah lama hijau mulai gagal karena kehabisan waktu. Penyebabnya bukan test itu — suite-nya tumbuh jadi 23 berkas, tiap worker menyiapkan jsdom-nya sendiri, dan penyiapan lingkungan saja memakan ~170 detik gabungan di mesin empat core. Test yang selesai dalam ratusan milidetik bisa melewati 5 detik semata karena menunggu giliran CPU.

`testTimeout` dinaikkan ke 15 detik. Yang dibeli batas ketat adalah deteksi dini terhadap test yang menggantung; yang dibayar adalah kegagalan yang berpindah-pindah berkas tiap kali suite-nya tumbuh — dan kegagalan seperti itu mengajari orang mengulang perintahnya sampai hijau, kebiasaan yang jauh lebih mahal daripada menunggu 15 detik.

**Deviasi:** belum ada penjaga route. Halaman masih bisa dibuka tanpa sesi, dan endpoint analytics serta topic belum memeriksa siapa pemanggilnya — itu T-066, dan sampai T-066 selesai sistem ini punya login tapi belum punya proteksi. Yang sudah dipasang sekarang supaya perubahannya nanti kecil: `credentials: "include"` di seluruh klien API, jadi yang berubah tinggal sisi server.

**Deviasi:** `X-Forwarded-For` tidak dibaca. Header itu bisa ditulis siapa saja kalau tidak ada proxy tepercaya di depan, dan mempercayainya membuat rate limit per IP bisa dilewati hanya dengan mengarang nilai baru tiap percobaan. Membacanya baru sah setelah ada daftar proxy tepercaya di config.

**Deviasi:** `pyjwt` sudah ada di `pyproject.toml` sejak T-001 dan sekarang jadi dependensi yang tidak dipakai. Dicatat di utang teknis TASK.md, bukan dibuang diam-diam.

**Deviasi:** Postgres dan Redis diganti palsu di seluruh test. Yang dibuktikan test: kontrak HTTP-nya, apa yang tidak bocor lewat pesan atau selisih waktu, dan perilaku TTL. Yang BELUM: satu pun login sungguhan terhadap kedua service itu. Urutan verifikasi manualnya nanti: `make up`, `make migrate`, `python -m sma_api.auth.buat_user`, lalu login dari dashboard dan periksa kunci `sesi:` di Redis beserta TTL-nya.

**Dampak biaya:** tidak ada. Autentikasi tidak menyentuh provider.

**Next:** T-065

---

## T-063 · Aktivasi topic & pemicu backfill — 2026-09-14

**FR:** FR-109

**Dikerjakan:** Menyimpan query sekarang sekaligus mengaktifkan topic: query didaftarkan ke percolator, rencana stream dihitung ulang dan ditulis ke database, lalu backfill data historis dimulai. Panel aktivasi di tab Query Lists menampilkan hasilnya beserta progres backfill yang terus diperbarui sampai selesai. Menutup E7.

**File:** `packages/core/sma_core/streams/{store,planner}.py`, `packages/core/sma_core/search/percolator.py`, `services/api/sma_api/topics/{aktivasi,router}.py`, `apps/web/lib/api/topics.ts`, `apps/web/components/admin/{panel-aktivasi,tab-query,tab-general}.tsx`, `apps/web/app/globals.css`, plus test di kedua sisi

**Verifikasi:** 1.132 test Python lolos di 45 berkas (dari 1.102/43); 553 test web lolos di 21 berkas (dari 543); ruff, `ruff format --check`, mypy (94 berkas), eslint, `tsc --noEmit`, dan `next build` bersih (`/admin/topic` 10,8 kB).

### Urutan langkahnya dipilih supaya kegagalan bisa dibatalkan

Tiga langkah menyentuh dua sistem yang sifatnya berbeda: Postgres bisa di-rollback, OpenSearch tidak. Urutannya mengikuti sifat itu.

    1. rencana stream   Postgres, di dalam transaksi request
    2. percolator       OpenSearch
    3. backfill         OpenSearch task

Kalau langkah 2 gagal, exception-nya menggagalkan transaksi dan langkah 1 batal dengan sendirinya — plus pendaftaran yang sempat masuk dicabut lagi. Urutan sebaliknya tidak punya sifat itu: percolator yang sudah terdaftar tidak bisa "dibatalkan" oleh kegagalan Postgres, dan yang tertinggal adalah topic yang mencocokkan post tanpa stream yang mengumpulkannya.

Langkah 3 sengaja TIDAK dibatalkan kalau gagal. Membatalkan pendaftaran yang sudah benar hanya karena backfill gagal akan membuat topic berhenti mengumpulkan post BARU juga — yang rusak cuma data historisnya, dan itu yang diperbaiki dengan mengulang. Aktivasi idempotent, jadi "coba lagi" selalu aman.

### Menyimpan dan mengaktifkan dipisah, walau satu klik

Acceptance-nya berbunyi "menyimpan topic akan mendaftarkan percolator...", dan cara paling langsung membacanya adalah menaruh ketiganya di dalam endpoint penyimpanan. Itu tidak dilakukan.

Alasannya arah kegagalan: menyimpan cuma menyentuh Postgres dan hampir tidak pernah gagal, sementara aktivasi menyentuh OpenSearch. Kalau keduanya satu operasi, indeks yang sedang bermasalah membuat query yang baru diketik ikut gagal disimpan — pekerjaan orang hilang karena sistem lain yang sedang sakit. Sekarang Save menyimpan dulu, lalu memanggil aktivasi; kalau aktivasinya gagal, panelnya berkata "Topic tersimpan, tapi belum aktif" dengan tombol coba lagi. Dari sisi admin tetap satu klik.

### Rencana stream dihitung dari SELURUH topic, bukan topic yang diaktifkan

Ini inti FR-202 dan alasan model biayanya bekerja. Planner menerima seluruh query milik semua topic aktif, lalu menyusun himpunan stream minimal yang mencakup semuanya. Topic baru yang keyword-nya sudah dikumpulkan topic lain muncul sebagai "diperbarui", bukan "dibuat" — tidak ada panggilan provider tambahan, tidak ada biaya tambahan.

Panel aktivasi menyebutnya apa adanya: "Memakai ulang stream yang sudah ada: banjir — tidak menambah biaya pengumpulan." Penghematan yang tidak terlihat gampang dikira tidak ada, lalu dibongkar orang berikutnya yang merasa desainnya terlalu rumit.

Dua hal yang dijaga di penyimpanannya:

- **Stream yang tidak lagi dipakai DINONAKTIFKAN, bukan dihapus.** Post yang sudah terkumpul menyimpan `stream_id`; menghapus barisnya memutus jejak dari mana data itu datang.
- **Stream mati yang kembali dibutuhkan dihidupkan, bukan dibuat ulang.** Cursor-nya masih ada, jadi fetch inkrementalnya tidak mulai dari nol — dan mulai dari nol berarti menarik ulang yang sudah pernah dibayar.

### Query yang dihapus ikut dicabut dari percolator

Sinkronisasi butuh tahu apa yang SEKARANG terdaftar, bukan cuma apa yang seharusnya terdaftar. Ditambahkan `id_query_terdaftar` yang membaca daftar itu dari index percolator; tanpanya, query yang sudah dihapus di UI tetap mencocokkan post baru — topic terus menerima data dari query yang tidak terlihat lagi di mana pun.

Query yang tidak valid dilewati, bukan menggagalkan seluruh aktivasi, dan jumlahnya disebut sebagai peringatan. Satu query rusak tidak boleh membuat query lain di topic yang sama ikut tidak terdaftar.

### Progres di-poll, bukan ditunggu

Backfill berjalan sebagai task di dalam OpenSearch (`update_by_query`) — bisa detik, bisa menit untuk korpus besar. Menahan permintaan sampai selesai akan membuat tombol Save menggantung tanpa batas, jadi aktivasi mengembalikan id task-nya dan panel menanyakan kabarnya tiap lima detik sampai selesai.

Satu keputusan kecil yang menentukan kejujurannya: task yang tidak bisa ditanya dianggap **belum** selesai, bukan selesai. Menandainya selesai akan membuat progres melompat ke 100% justru pada saat ada yang salah.

Status aktivasi disimpan di Redis dengan TTL seminggu, bukan di Postgres: ini keadaan sementara yang basi sendiri, dan menambah kolom untuk sesuatu yang umurnya sehari berarti migrasi untuk data yang tidak pernah dibaca lagi. Redis yang mati tidak membatalkan aktivasi yang sudah berhasil — yang hilang cuma tampilan progresnya.

### Backfill tidak menambah biaya sama sekali

`update_by_query` menandai post yang SUDAH ada di index. Tidak ada panggilan provider, tidak ada penarikan ulang — itu sebabnya topic baru bisa langsung menampilkan data historis yang cocok tanpa menambah tagihan. Panelnya menyebut itu, karena "backfill" terdengar seperti sesuatu yang menarik data dan mahal.

**Deviasi:** seluruh alurnya diuji dengan klien palsu — percolator, backfill, dan session database semuanya digantikan. Yang dibuktikan test: urutan langkahnya, apa yang dibatalkan saat tiap langkah gagal, dan keputusan mana yang diambil penyimpan rencana. Yang BELUM dibuktikan: bahwa OpenSearch dan Postgres sungguhan menerima pernyataan itu apa adanya. Itu bagian terbesar dari verifikasi manual Docker/VPS untuk E7, dan urutannya nanti: jalankan stack, buat satu topic, simpan query, lalu periksa index percolator, tabel `collection_stream`, dan `matched_topics` pada post lama.

**Dampak biaya:** aktivasi sendiri tidak memanggil provider. Yang menentukan biaya adalah rencana stream yang dihasilkannya, dan di situ penghematan FR-202 terjadi: keyword yang sudah dikumpulkan topic lain dipakai ulang alih-alih membuka stream baru. Backfill berbiaya nol.

**Next:** T-064

---

## T-062 · Preview query — 2026-09-14

**FR:** FR-107

**Dikerjakan:** Tombol Preview di tab Query Lists menjalankan query yang sedang diedit terhadap korpus yang sudah terkumpul, lalu menampilkan jumlah cocok, perkiraan volume harian, perkiraan biaya bulanan, sebaran platform, peringatan, dan 20 sampel post. Endpoint `POST /api/v1/topics/preview` tidak butuh topic dan tidak menyentuh Postgres.

**File:** `packages/core/sma_core/cost.py`, `packages/core/sma_core/query/topik.py`, `packages/schema/sma_schema/topic.py`, `apps/web/lib/schema.generated.ts`, `services/api/sma_api/topics/{preview,router}.py`, `services/api/sma_api/analytics/filters.py`, `apps/web/lib/api/topics.ts`, `apps/web/components/admin/{panel-preview,tab-query,baris-tab}.tsx`, `apps/web/app/globals.css`, plus test di kedua sisi

**Verifikasi:** 1.102 test Python lolos di 43 berkas (dari 1.049/40); 543 test web lolos di 21 berkas (dari 530); ruff, `ruff format --check`, mypy (92 berkas), eslint, `tsc --noEmit`, dan `next build` bersih (`/admin/topic` 9,75 kB).

### Angkanya batas bawah, dan itu harus disebut

Preview mencari di korpus yang SUDAH terkumpul — ia tidak meramal apa yang akan ditarik provider. Dua hal langsung mengikuti dari itu, dan keduanya ditulis di layar alih-alih dibiarkan disimpulkan sendiri:

- **Hasilnya batas bawah.** Pengumpulan digerakkan keyword (FR-206), jadi post yang cocok query baru tapi tidak pernah dikumpulkan tidak ada di korpus.
- **Nol bukan berarti query-nya salah.** Bisa jadi memang belum ada yang dikumpulkan untuk kata itu. Kalau nol dibiarkan tanpa penjelasan, orang akan mengubah query yang sebenarnya sudah benar.

### Biaya dihitung per platform, bukan dari satu tarif rata-rata

Tarif antar platform berbeda lebih dari 13x: X $0,15 per 1.000 post, Facebook $2,00 (COST-MODEL.md bagian 2). Total dikali rata-rata akan salah besar begitu campuran platformnya bergeser — dan campuran itu persis yang berubah waktu admin menambah atau membuang platform.

Jadi satu pencarian mengambil tiga hal sekaligus: sampel, jumlah total, dan sebaran platform (`terms` agg). Sebarannya dibagi panjang jendela jadi volume harian per platform, dan itu yang dikalikan tarif masing-masing. Sebarannya ikut ditampilkan supaya angkanya bisa ditelusuri, bukan dipercaya begitu saja.

Tarifnya sendiri tinggal di satu modul (`sma_core/cost.py`) yang menyebut COST-MODEL.md sebagai sumbernya, sesuai aturan CLAUDE.md. Cost guard E9 akan memakai modul yang sama — estimasi dan penegakan harus memakai angka yang sama, kalau tidak yang satu memperingatkan sementara yang lain tidak.

Yang sengaja TIDAK dihitung: biaya platform Apify ($29/bulan) karena itu biaya tetap yang dibagi seluruh topic, dan biaya NLP karena klasifikasi berjalan pada korpus bersama yang sudah di-dedup.

### Ambang peringatannya sama dengan ambang yang menegakkan nanti

Peringatan biaya memakai `cost_cap_per_topic_usd` dan `cost_alert_threshold` dari konfigurasi cost guard — bukan angka baru. Angka yang memicu peringatan di preview harus sama dengan angka yang memicu throttle di produksi; dua ambang berbeda berarti preview yang menenangkan untuk topic yang nanti justru dicekik.

### Pembangun query ditaruh di core, bukan di API

Bentuk "apa yang cocok dengan topic ini" dipakai dua tempat: preview sekarang, dan percolator di T-063. Kalau keduanya menyusun query sendiri-sendiri, preview akan menjanjikan angka yang tidak pernah terjadi — dan bedanya muncul sebagai topic yang "tidak seaktif waktu di-preview", tanpa error apa pun. Jadi `sma_core/query/topik.py` yang memilikinya, dan T-063 wajib memakainya.

Satu detail yang dijaga test: topic tanpa query menghasilkan `match_none`, bukan `match_all`. Di preview itu bedanya antara "nol" dan angka seukuran seluruh korpus; di percolator itu bedanya antara tidak mengumpulkan apa pun dan mengumpulkan segalanya.

### Tafsiran FR-105 ditulis, bukan ditebak ulang

PRD cuma mendefinisikan `not_media_tags` secara eksplisit ("post yang cocok dikecualikan meski cocok query utama"). Dua yang lain ditafsirkan dan tafsirannya ditulis di docstring modulnya: `keywords` mempersempit (minimal satu harus cocok), `media_tags` dicocokkan sebagai hashtag. Ditulis supaya bisa diperdebatkan sekali, alih-alih ditebak ulang tiap kali ada yang menyentuhnya.

### Jendela tujuh hari

Estimasi harian butuh pembagi. Jendela panjang meratakan lonjakan sampai topic yang sedang ramai terlihat sepi; jendela pendek membesar-besarkan satu hari ramai. Tujuh hari menutup satu siklus mingguan penuh — akhir pekan ikut, dan itu yang membedakan topic politik dari topic hiburan. Panjangnya ikut di respons (`window_days`) karena "1.200 post" tidak bisa dibaca tanpa tahu jendelanya.

### Hasil preview dibuang begitu query diubah

Angka biaya yang menjelaskan query lain adalah jenis kesalahan yang mahal: admin melihat "$0,45/bulan", menambah satu OR yang melipatgandakan cakupan, lalu menyimpan sambil mengira angkanya masih berlaku. Setiap perubahan blok query membuang hasil preview yang tampil.

Urutan tampilannya juga disengaja: peringatan dulu, lalu angka, sampel terakhir. Sampel di atas membuat orang membaca "hasilnya masuk akal" dan berhenti di situ — padahal yang menentukan layak-tidaknya query ini adalah angka di atasnya.

**Deviasi:** acceptance "preview kembali di bawah 5 detik untuk korpus 1 juta post" belum bisa diukur — butuh OpenSearch berisi data sebanyak itu, dan itu bagian dari verifikasi Docker/VPS yang sama dengan task E7 lainnya. Yang sudah ada di kode: badan pencariannya satu kali jalan (bukan beberapa), `_source` dibatasi ke field kartu saja, dan preview yang melewati 5 detik dicatat sebagai peringatan di log dengan lama sebenarnya. Tombol Preview sengaja hanya aktif di tab Query Lists; dari tab lain ia nonaktif dan menyebut ke mana harus pergi, karena yang di-preview adalah query yang sedang diedit.

**Dampak biaya:** ini fitur yang tujuannya justru menurunkan biaya, dan biayanya sendiri satu pencarian OpenSearch per klik — tidak menyentuh provider mana pun. Pengaman berikutnya adalah cost guard E9 yang menegakkan ambang yang sama saat pengumpulan sudah berjalan.

**Next:** T-063

---

## T-061 · Tab Demography Filter — 2026-09-14

**FR:** FR-106

**Dikerjakan:** Tab ketiga formulir topic: gender, kelompok umur, dan provinsi, dengan endpoint `GET` dan `PUT /api/v1/topics/{id}/demography`. Bentuk konfigurasinya dinyatakan di `packages/schema` sebagai `DemographyConfig` beserta enum `Gender` dan `AgeGroup`, dan tipe TypeScript-nya ikut di-generate.

**File:** `packages/schema/sma_schema/{enums,topic,__init__}.py`, `apps/web/lib/schema.generated.ts`, `services/api/sma_api/topics/{repo,router}.py`, `apps/web/lib/api/topics.ts`, `apps/web/components/admin/{tab-demografi,baris-tab,form-topic}.tsx`, `apps/web/app/globals.css`, plus test di kedua sisi

**Verifikasi:** 1.049 test Python lolos di 40 berkas (dari 1.032); 530 test web lolos di 21 berkas (dari 506/20); ruff, `ruff format --check`, mypy (89 berkas), eslint, `tsc --noEmit`, dan `next build` bersih (`/admin/topic` 8,9 kB).

### Tab yang menyimpan tapi tidak menyaring adalah tab yang mudah berbohong

Ini task paling kecil di E7 dan yang paling gampang dikerjakan dengan tidak jujur. Filternya tidak menyaring apa pun — inferensi gender, umur, dan lokasi baru ada di Fase 3 — tapi tab yang terlihat berfungsi akan dibaca sebagai tab yang berfungsi. Begitu seseorang mencentang "Perempuan, 22–30, DKI Jakarta" lalu menyalin angka dashboard ke laporan, angka itu masuk laporan sebagai "sentimen perempuan usia 22–30 di Jakarta" padahal tidak ada satu pun post yang disaring.

Tiga hal yang dikerjakan supaya itu tidak terjadi:

- **Peringatan di atas segalanya**, bukan catatan kecil di bawah, dan kalimatnya datang dari server (`catatan` di respons). Begitu Fase 3 tiba, yang berubah satu tempat — bukan setiap tempat yang menampilkannya.
- **`is_enforced` tidak bisa dikirim klien.** Request body-nya cuma memuat `config`; mengirim `is_enforced` ditolak 422, dan repo menulis False setiap kali menyimpan. Nilai true di kolom itu sekarang hanya bisa berarti ada yang salah.
- **Keterangan per dimensi menyebut apa yang hilang kalau disaring.** Gender: sebagian besar akun tidak menyatakannya, jadi mencentang hanya Laki-laki dan Perempuan membuang porsi terbesar datanya. Umur: ROADMAP 3.1 mencatat akurasinya 45-60%, yang paling sering salah dari ketiganya.

### Konfigurasi punya bentuk, bukan `dict` bebas

Kolomnya JSONB, jadi apa pun bisa masuk. Godaannya menyimpan `dict` apa adanya — dan itu memindahkan setiap kesalahan ketik ke masa depan, ke kode Fase 3 yang belum ditulis dan tidak akan memeriksa apa pun.

Jadi bentuknya dinyatakan di `packages/schema` (`DemographyConfig` plus enum `Gender` dan `AgeGroup`), sesuai aturan CLAUDE.md bahwa paket itu adalah sumber kebenaran bentuk data. Efek sampingnya menyenangkan: tipe TypeScript-nya ikut di-generate, jadi klien memakai tipe yang sama tanpa ditulis ulang.

`extra="forbid"` berlaku di sini juga — `{"genders": [...]}` ditolak, bukan tersimpan diam-diam sebagai field yang tidak pernah dibaca siapa pun.

### Rentang umur: yang terbaca, dan yang tidak

Kelompok umurnya mengikuti panel produk referensi supaya panel Fase 3 nanti cocok: `Screenshot_9.png` memberi "BELOW 18", "18 - 21", dan "22 - 30" dengan jelas. Dua kelompok teratas ada di `Screenshot_10.png`, tapi judulnya terpotong persis di tepi atas gambar — sudah dicoba dibaca dengan memperbesar potongannya dan tetap tidak terbaca, cuma separuh bawah gliftnya yang ada.

`41_55` dan `above_55` karena itu adalah dugaan, dan ditulis sebagai dugaan di docstring enumnya beserta catatan bahwa yang berubah cuma enum itu kalau ternyata salah. Menuliskannya sebagai fakta akan membuat panel Fase 3 memakai batas yang salah tanpa ada yang ingat dari mana angkanya datang.

### Provinsi divalidasi, bukan diterima apa adanya

Nama provinsi disimpan sebagai string — paket schema tidak boleh mengimpor `sma_core`. Yang memvalidasinya API, terhadap gazetteer 38 provinsi yang sama dengan panel Topic Location (T-055). "Batavia" ditolak sekarang; kalau diterima, ia jadi filter yang begitu Fase 3 aktif tidak pernah menemukan siapa pun, dan yang terlihat cuma panel kosong tanpa sebab.

### Dua hal kecil yang menentukan keandalannya

- **Upsert dengan `ON CONFLICT`,** bukan SELECT-lalu-INSERT-atau-UPDATE. Tabelnya punya `uq_demography_topic` (satu baris per topic), dan dua permintaan bersamaan sama-sama melihat barisnya belum ada. Satu pernyataan tidak punya celah itu.
- **Konfigurasi yang tidak terbaca tidak menjatuhkan tab.** Kalau isi JSONB-nya tidak lagi cocok dengan bentuk sekarang — field yang dihapus di versi berikutnya, misalnya — yang dikembalikan adalah konfigurasi kosong plus catatan bahwa yang tersimpan tidak bisa dibaca. Tab yang gagal dimuat membuat topic itu tidak bisa diurus sama sekali.

**Deviasi:** tidak ada screenshot referensi untuk tab ini; tiga dimensinya diturunkan dari FR-106 dan ROADMAP 3.1. Kategori "Tidak terdeteksi" sengaja bisa dipilih di gender dan umur — menyembunyikannya membuat filter membuang mayoritas data tanpa mengatakannya (aturan `unknown` di CLAUDE.md). Acceptance "konfigurasi tersimpan dan ter-restore" diverifikasi lewat test kontrak endpoint dan komponen, bukan terhadap Postgres sungguhan; itu bagian dari verifikasi manual Docker/VPS yang sama dengan task E7 lainnya.

**Dampak biaya:** n/a sekarang. Yang perlu diingat untuk Fase 3: filter ini menyaring SETELAH post dikumpulkan dan dibayar — menyaring demografi tidak menurunkan biaya ingestion sama sekali, cuma mempersempit yang ditampilkan.

**Next:** T-062

---

## T-060 · Tab Query Lists — 2026-09-14

**FR:** FR-102, FR-104, FR-105

**Dikerjakan:** Tab Query Lists: satu blok per query dengan Platform, Language, Query, Keyword, Media Tags, dan Not Media Tags, plus "Add New Query" — seperti `Screenshot_12.png`. Sintaksnya diperiksa sambil mengetik lewat endpoint baru `POST /topics/validate-query`, dan seluruh daftar disimpan lewat `PUT /topics/{id}/queries`. Formulir topic dipecah jadi shell plus satu komponen per tab.

**File:** `services/api/sma_api/topics/{repo,router}.py`, `apps/web/lib/api/topics.ts`, `apps/web/components/admin/{form-topic,baris-tab,tab-general,tab-query,daftar-chip}.tsx`, `apps/web/app/globals.css`, plus test di kedua sisi

**Verifikasi:** 1.032 test Python lolos di 40 berkas (dari 1.002); 506 test web lolos di 20 berkas (dari 472/19); ruff, `ruff format --check`, mypy (89 berkas), eslint, `tsc --noEmit`, dan `next build` bersih (`/admin/topic` 8,87 kB).

### Satu parser, bukan dua

"Validasi sintaks realtime" paling gampang dikerjakan dengan menulis ulang parser boolean di TypeScript: tidak ada jeda jaringan, tidak ada endpoint baru. Itu juga satu-satunya keuntungannya.

Biayanya jauh lebih besar dan datang belakangan: dua parser untuk satu sintaks akan berbeda perlahan — satu sisi memperbaiki penanganan kurung, sisi lain tidak — dan bedanya tidak muncul sebagai error. Yang muncul adalah UI yang mengatakan "valid" untuk query yang ditolak collector, atau sebaliknya. Parser di `packages/core/sma_core/query/` sudah memuat keputusan yang tidak boleh berbeda antar sisi: operator implisit adalah AND, bukan OR seperti default OpenSearch.

Jadi pemeriksaan dikirim ke server setelah orang berhenti mengetik (400 ms), memakai `compile_query` — bukan cuma `parse`. Query bisa lolos parser tapi gagal diterjemahkan ke DSL percolator, dan kalau itu tidak ditangkap sekarang, ia tersimpan dan baru meledak waktu topic diaktifkan di T-063.

Endpoint itu bebas database dan menjawab **200 dengan `valid: false`** untuk query yang salah. "Tidak valid" adalah jawaban normal bagi endpoint yang dipanggil tiap kali orang berhenti mengetik; membuatnya 422 akan membuat setiap ketikan setengah jadi terlihat seperti error di log.

Satu pembedaan yang gampang terlewat: kalau pemeriksaannya sendiri gagal (jaringan mati), yang ditampilkan adalah "sintaks tidak bisa diperiksa sekarang", **bukan** "query tidak valid". Keduanya berlawanan artinya, dan ada test yang menjaganya.

### Yang ditampilkan adalah keyword yang DIKUMPULKAN, bukan term di query

Untuk `"banjir" AND "jakarta"`, keyword pengumpulannya satu, bukan dua: post yang cocok pasti memuat `banjir`, jadi mengumpulkan keduanya membayar dua kali untuk hasil yang sama (lihat `collection_keywords`). Untuk `"a" OR "b"`, keduanya wajib dikumpulkan.

Perbedaan itu yang menentukan biaya, jadi itu yang ditampilkan di bawah textarea — bukan daftar term yang diketik. Peringatan dari parser ikut tampil, termasuk kasus query yang hanya berisi negasi: mengumpulkan berdasarkan negasi berarti menarik seluruh internet.

### Daftar utuh, lalu di-diff per id

Tab ini menyimpan semua query sekaligus seperti di referensi, jadi endpoint-nya `PUT` dengan daftar utuh. Dua alasan, dan keduanya soal kegagalan:

- **Penghapusan ikut terwakili.** Dengan endpoint per-query, query yang dihapus di UI butuh permintaan tersendiri yang bisa gagal setengah jalan — dan yang tertinggal adalah keadaan yang tidak pernah diminta siapa pun.
- **Id dipertahankan.** Di dalam repo daftarnya di-diff per id, bukan hapus-semua-lalu-tulis-ulang. Percolator mendaftarkan query per id (FR-109); menulis ulang seluruh daftar setiap kali satu huruf berubah berarti mendaftarkan ulang semuanya, dan kehilangan jejak query mana yang sebenarnya diubah.

Query yang hilang dari daftar dihapus keras, dan itu berbeda dari topic yang di-soft-delete. Alasannya: post yang sudah cocok menyimpan `matched_topics`, bukan id query — menghapus query tidak menghilangkan data historis apa pun.

### Query tidak valid ditolak, bukan ditandai

Tabel `query` punya kolom `is_valid` dan `validation_error`, dan itu menggoda untuk dipakai sebagai tempat menyimpan query yang salah. Tidak dipakai begitu: query yang jelas salah ditolak 422 dengan nomornya ("Query #2"), karena menyimpannya berarti topic yang tidak mengumpulkan apa pun sampai ada yang memeriksa query-nya satu per satu.

Kolom itu tetap ada untuk kasus yang berbeda — query yang dulu sah lalu menjadi tidak sah karena parsernya berubah. Itu ditemukan audit, bukan diketik orang.

### Empat penolakan yang menghemat kebingungan belakangan

- **Platform di luar daftar platform topic.** Query Instagram pada topic yang tidak memilih Instagram tidak akan pernah cocok. Pesannya menyebut itu.
- **Id yang tidak dikenal di topic ini.** Hampir selalu berarti klien mengirim keadaan basi; membuatnya jadi query baru akan menyembunyikan itu sambil menggandakan query.
- **Query kembar** (string, platform, dan bahasa yang sama) — dua pendaftaran percolator untuk satu maksud.
- **Bahasa kosong atau `unknown`.** Daftar bahasa kosong terbaca seperti "semua bahasa" padahal artinya tidak pernah cocok; `unknown` ada di enum sebagai hasil deteksi untuk post yang bahasanya tidak terbaca, bukan pilihan.

### Bug yang ketemu karena refactor: pesan sukses menghapus dirinya sendiri

Formulir dipecah jadi shell (memuat topic, menyimpan tab yang dibuka) plus satu komponen per tab, karena tiap tab menyimpan ke endpoint yang berbeda. Setelah itu, test T-059 "pesan setelah simpan mengatakan pengumpulan belum jalan" gagal — dan bukan karena test-nya salah.

Alurnya: tab menyimpan, shell memperbarui topic yang dipegangnya (perlu, supaya query baru mendapat id-nya), prop topic yang baru sampai ke tab, efek seeding jalan, dan efek itu menghapus pesan sukses yang baru dipasang. Hasilnya tombol Save yang tidak pernah memberi kabar apa pun. Diperbaiki dengan penanda "penyimpanan ini milik saya sendiri" supaya efeknya me-seed ulang nilai tanpa menghapus pesannya. Kedua tab kena masalah yang sama, jadi keduanya diperbaiki.

### Hal-hal kecil

- **Tab ikut di URL** (`?tab=query`), alasan yang sama dengan state daftar dan filter dashboard: tampilan harus bisa dibagikan dan dibuka lagi lewat Back. Tautan lama ke `tab=query` untuk topic yang belum tersimpan jatuh ke General, bukan menampilkan tab kosong yang tidak bisa menyimpan.
- **Tab Query Lists nonaktif sampai topic tersimpan**, karena query menyimpan `topic_id` — tanpa topic tidak ada yang bisa dirujuk. Tabnya tetap terlihat supaya urutannya tidak bergeser begitu topic disimpan.
- **Input daftar (`DaftarChip`) dikumpulkan jadi satu komponen**, dipakai empat kali di dua tab. Empat salinan akan berbeda perlahan, dan yang paling sering berbeda justru aturan duplikatnya.
- **Pesan validasi punya tinggi minimum** supaya munculnya tidak menggeser isi di bawahnya — pergeseran yang sama yang dihindari di T-057.

**Deviasi:** referensi menaruh tombol Delete di kartu topic; di sini setiap blok query punya tombol Hapus sendiri, karena yang dihapus memang query, bukan topic. Penghapusan topic belum ada sama sekali — tidak ada task yang memintanya, dan `deleted_at` sudah disiapkan di schema. Acceptance FR-102 "query valid tersimpan dan cocok dengan post yang tepat" belum bisa dibuktikan: separuh pertamanya sudah (tersimpan, sintaks diperiksa parser yang sama dengan collector), separuh keduanya butuh percolator T-063 dan OpenSearch jalan.

**Dampak biaya:** tidak menyentuh ingestion sekarang, tapi ini titik paling awal di mana biaya bisa dilihat sebelum terjadi — keyword pengumpulan ditampilkan sambil query ditulis, jadi query yang terlalu luas ketahuan sebelum disimpan, bukan setelah tagihan datang. Pengaman lapis berikutnya adalah preview T-062 yang menyebut estimasi volume dan biayanya.

**Next:** T-061

---

## T-059 · Tab General — 2026-09-13

**FR:** FR-103, FR-108

**Dikerjakan:** Formulir topic tab General — nama, deskripsi, checkbox platform, taxonomy type dan tag, toggle Filter Ads — beserta jalur tulisnya: `GET /api/v1/topics/{id}`, `POST /api/v1/topics`, dan `PATCH /api/v1/topics/{id}`. Kartu di daftar sekarang bisa dipilih untuk dibuka di formulir, dan topic yang tersimpan langsung muncul di daftar tanpa memuat ulang halaman.

**File:** `services/api/sma_api/topics/{repo,router}.py`, `apps/web/lib/api/topics.ts`, `apps/web/components/admin/{form-topic,admin-topic,daftar-topic}.tsx`, `apps/web/app/admin/topic/page.tsx`, `apps/web/app/globals.css`, plus test di kedua sisi

**Verifikasi:** 1.002 test Python lolos di 40 berkas (dari 967); 472 test web lolos di 19 berkas (dari 426/18); ruff, `ruff format --check`, mypy (89 berkas), eslint, `tsc --noEmit`, dan `next build` bersih (`/admin/topic` 6,8 kB).

### PATCH mengirim sebagian, dan itu bukan detail gaya

Tab General cuma memiliki sebagian field topic; Query Lists (T-060) dan Demography Filter (T-061) memiliki sisanya. Kalau penyimpanan mengirim seluruh baris, tab yang disimpan akan menimpa field milik tab lain dengan nilai lama yang dipegangnya sejak formulir dibuka — dan kerusakannya tidak terlihat sampai ada yang membandingkan dua tab.

Jadi `TopicUbah` membuat semua field opsional, dan yang diterapkan cuma yang benar-benar dikirim (`model_dump(exclude_unset=True)`). Yang dibedakan bukan None-nya: `description: null` yang dikirim eksplisit berarti "kosongkan", sementara field yang tidak disebut sama sekali berarti "jangan disentuh". Tubuh kosong ditolak 422, bukan dijawab 200 — 200 tanpa perubahan membuat kesalahan klien terlihat seperti penyimpanan yang berhasil.

### Nama unik dijaga database, bukan dijaga aplikasi

Godaannya SELECT-dulu-lalu-INSERT. Itu punya celah balapan yang nyata: dua admin menyimpan nama yang sama pada detik yang sama, keduanya melihat nama itu bebas, dan keduanya lolos. Indeks partial `uq_topic_name_active` yang sudah ada sejak migrasi awal tidak punya celah itu.

Yang perlu dikerjakan supaya pelanggarannya terbaca sebagai 409 dan bukan 500:

- **`flush()` di dalam endpoint.** Tanpa itu, `IntegrityError` baru meledak saat session di-commit di penutup request — di luar blok `try`, jadi jawabannya 500.
- **`rollback()` sebelum melempar.** Transaksi yang sudah gagal tidak bisa di-commit; tanpa rollback, commit di penutup melempar lagi dan menutupi 409 yang sudah disiapkan.

Keduanya punya test sendiri, karena keduanya adalah jenis kesalahan yang tidak terlihat sampai ada dua orang memakai sistemnya bersamaan.

### `extra="forbid"`: field yang salah ketik ditolak, bukan diabaikan

Formulir yang mengirim `filterAds` alih-alih `filter_ads` akan tersimpan dengan tenang tanpa efek apa pun. Yang terlihat cuma toggle yang "tidak berfungsi" — tanpa error, tanpa log, tanpa petunjuk. Menolaknya 422 memindahkan kegagalan itu ke tempat yang bisa dibaca.

### Platform tanpa adapter ditolak, tapi tetap ditampilkan

FR-103 menyebut delapan platform; adapter yang ada cuma enam (`services/worker/sma_worker/adapters/`). Bluesky dan Reddit karena itu ditampilkan nonaktif berlencana "Fase 4" dan ditolak server.

Daftar platform yang didukung ditulis ulang di API, bukan diimpor dari worker — keduanya service yang sengaja tidak saling impor. Duplikasi itu disengaja, dan yang membuatnya aman adalah arah gagalnya: kalau adapter baru datang dan daftar ini lupa diperbarui, akibatnya topic menolak platform yang sebenarnya sudah bisa (terlihat langsung, langsung dikeluhkan). Kebalikannya yang berbahaya — menerima platform tanpa adapter berarti topic yang diam-diam tidak mengumpulkan apa pun.

### Menyimpan topic belum mengumpulkan apa pun, dan formulirnya mengatakannya

Pendaftaran query ke percolator dan pemicu backfill adalah FR-109, dikerjakan di T-063. Tab General berhenti di Postgres. Pesan setelah menyimpan topic baru menyebut itu apa adanya, karena tanpanya admin akan menunggu data yang tidak akan datang dan menyimpulkan sistemnya rusak — kesimpulan yang salah dan mahal, tepat di menit pertama orang memakai fitur ini.

### Deviasi dari referensi: Taxonomy Type jadi radio

Referensi memakai dua checkbox (Interest, Industry), tapi `taxonomy_type` di schema menyimpan satu nilai. Dua checkbox tercentang tidak punya representasi di data, jadi dipakai radio plus pilihan "Tidak dipakai" — yang sekalian menjawab cara membatalkan pilihan, sesuatu yang tidak dimiliki dua checkbox tanpa tombol reset.

### Hal-hal kecil yang sengaja dipilih

- **Enter di kotak taxonomy menambah tag, bukan mengirim formulir.** Kalau mengirim, tag yang baru diketik justru tidak ikut tersimpan.
- **Duplikat tag dibandingkan tanpa peduli besar-kecil huruf**, di klien dan di server: "Politik" dan "politik" adalah tag yang sama bagi yang membacanya, dan menyimpan keduanya membuat filter taxonomy nanti menghitung dua kali.
- **Author dikatakan belum ada**, bukan diisi nama karangan. Nama palsu yang lolos ke demo akan disangka akun betulan (alasan yang sama dengan placeholder identitas di T-048).
- **Teks galat memakai token teks biasa**; yang merah adalah garis tepi field dan titik penandanya. Merek merah sebagai warna teks cuma 3,22:1 di mode gelap (catatan T-057).
- **Daftar dan formulir digabung di satu komponen** (`admin-topic.tsx`) dengan penghitung generasi. Kalau masing-masing memegang state sendiri, topic yang baru dibuat tidak muncul di daftar sampai halaman dimuat ulang.

**Deviasi:** Taxonomy Type radio alih-alih checkbox (alasan di atas). Perubahan yang belum disimpan hilang tanpa konfirmasi kalau topic lain dipilih — keadaannya ditandai lencana "belum disimpan", dan dialog konfirmasi ditahan sampai ada bukti orang benar-benar kehilangan isian; menambahkannya sekarang berarti menambah satu klik ke setiap perpindahan topic demi kasus yang belum terbukti. `is_active` tidak bisa diubah dari tab ini karena referensi juga tidak punya kontrolnya. Acceptance FR-103 "topic dengan hanya Twitter terpilih tidak menarik data platform lain; biaya ikut turun" tidak bisa diverifikasi di sini — itu butuh collector jalan dan pelacakan biaya FR-701, jadi yang dibuktikan T-059 baru bahwa pilihannya tersimpan dan platform tanpa adapter ditolak.

**Dampak biaya:** tidak menyentuh ingestion maupun NLP sekarang, tapi field yang disimpan di sini yang nanti menentukannya — daftar platform per topic adalah pengali biaya paling langsung di seluruh sistem, dan `filter_ads` membuang post yang sudah dibayar (buang di enricher, bukan di collector, supaya tidak menarik ulang).

**Next:** T-060

---

## T-058 · Halaman Topic & Account (daftar) — 2026-09-13

**FR:** FR-101

**Dikerjakan:** Panel kiri halaman Topic & Account: daftar kartu topic beserta boolean query-nya, dengan pencarian, urutan, dan paginasi yang dikerjakan di Postgres. Termasuk endpoint `GET /api/v1/topics` yang belum ada sebelumnya, dependency session database pertama di API, dan entri menu admin di header. Topic akhirnya bisa dipilih tanpa mengetik UUID di URL.

**File:** `services/api/sma_api/topics/{__init__,repo,router}.py`, `services/api/sma_api/{clients,main}.py`, `apps/web/lib/api/topics.ts`, `apps/web/app/admin/topic/page.tsx`, `apps/web/components/admin/daftar-topic.tsx`, `apps/web/lib/nav.ts`, `apps/web/components/shell/app-header.tsx`, `apps/web/app/globals.css`, plus test di kedua sisi

**Verifikasi:** 967 test Python lolos di 40 berkas (dari 925/38); 426 test web lolos di 18 berkas (dari 379/16); ruff, `ruff format --check`, mypy (89 berkas), eslint, `tsc --noEmit`, dan `next build` bersih (`/admin/topic` 4,32 kB).

### Task UI ini ternyata memuat satu API yang belum ada

FR-101 di tabel traceability cuma memetakan ke T-058, dan tidak ada task mana pun di E1 s/d E9 yang membuat API admin topic. Jadi separuh task ini sebenarnya pekerjaan backend: endpoint daftar, plus `get_sesi` — dependency session database pertama di API, yang sampai sekarang hanya menyentuh OpenSearch dan Redis.

Pencarian, urutan, dan paginasi sengaja dikerjakan Postgres, bukan dikirim semua lalu disaring di browser. 108 topic memang masih cukup kecil untuk dikirim sekaligus; yang membuat pola itu salah adalah arah gagalnya — halaman jadi makin lambat seiring topic bertambah tanpa ada yang mengubah apa pun, dan tidak ada satu titik yang bisa ditunjuk sebagai penyebabnya.

### Bug yang mahal: anotasi di bawah TYPE_CHECKING membuat SETIAP request 422

Router ini ditulis dengan pola yang sama seperti modul lain di repo: `from __future__ import annotations` plus impor tipe di bawah `if TYPE_CHECKING`. Untuk `Session` di parameter `Depends`, pola itu merusak endpoint-nya secara total.

Karena anotasi jadi string dan `Session` tidak ada di namespace runtime, FastAPI gagal me-resolve-nya dan `Depends(get_sesi)` di metadata `Annotated` ikut hilang. Akibatnya `sesi` diperlakukan sebagai **query parameter wajib**, dan setiap request dijawab:

```
422 {"detail":[{"type":"missing","loc":["query","sesi"],"msg":"Field required"}]}
```

Yang membuat ini mahal: tidak ada error impor, tidak ada peringatan, dan aplikasinya start normal. Kalau test router-nya cuma memeriksa "tidak 500", bug ini lolos ke produksi dan muncul sebagai halaman admin yang selalu kosong. Perbaikannya satu baris — impor `Session` saat runtime — dan alasannya ditulis di tempatnya supaya tidak ada yang "merapikan"-nya kembali ke bawah TYPE_CHECKING.

### Tipe respons mewarisi model schema, bukan menyusun ulang fieldnya

`ItemTopic` mewarisi `Topic` dari `packages/schema`, dan `QueryTopic` mewarisi `Query`. Tipe TypeScript untuk keduanya sudah di-generate (`make schema`), jadi yang ditulis tangan di klien cuma pembungkus paginasinya — kebalikan dari panel analytics, yang keluarannya `dict[str, Any]` sehingga seluruh tipenya ditulis tangan (utang yang masih tercatat di TASK.md). Arah ini yang seharusnya dipakai panel juga.

Efek sampingnya satu hal kecil yang perlu diingat: Pydantic `from_attributes` menolak **kelas** sebagai masukan dan hanya menerima instance, jadi baris ORM palsu di test dibuat dengan `SimpleNamespace`, bukan `type(...)`.

### Urutan yang stabil adalah syarat paginasi, bukan hiasan

Setiap pilihan urutan diakhiri `topic.id`. Tanpa pemecah seri, dua topic dengan nama atau `created_at` yang sama bisa bertukar posisi antar permintaan — dan paginasi di atas urutan yang tidak stabil menampilkan satu topic di dua halaman sekaligus sementara topic lain tidak pernah muncul. Bug seperti itu tidak terlihat sebagai error; kelihatannya cuma "daftarnya aneh".

Dua detail lain di query yang sama:

- **Wildcard pengguna di-escape.** `%` dan `_` adalah wildcard SQL; mencari "100%" tanpa escape cocok dengan apa pun yang dimulai "100", dan hasilnya terbaca sebagai pencarian yang salah.
- **Query hitung tidak mengurutkan, dan query daftar memakai `selectinload`.** Tanpa yang kedua, halaman berisi 10 topic menembak 11 query (N+1).

### Tiga sebab "kosong" yang berbeda

Daftar kosong bisa berarti belum ada topic, pencarian tanpa hasil, atau halaman di luar jangkauan karena tautan lama. Ketiganya butuh langkah berbeda, jadi ketiganya mengatakan hal berbeda — lengkap dengan tombol "Hapus pencarian" dan "Ke halaman 1". Menggabungkannya jadi satu "tidak ada data" sudah jadi pelajaran di T-050.

Berbeda dari panel dashboard di T-057, kegagalan di sini **tidak** mempertahankan daftar lama: daftar topic yang salah membuat orang mengedit topic yang salah, dan tidak ada apa pun di layar yang menandainya.

### Pencarian menunggu orang berhenti mengetik

Satu request per ketikan berarti delapan request untuk kata "koperasi", tujuh di antaranya sudah tidak relevan sebelum jawabannya tiba. Jeda 300 ms menahannya, request yang masih berjalan dibatalkan begitu ada yang lebih baru, dan state daftar (kata, urutan, halaman) tinggal di URL dengan alasan yang sama seperti filter dashboard di T-049 — tampilan yang sedang dilihat harus bisa dibagikan dan dibuka lagi lewat tombol Back.

### Menu admin dipisah dari modul analitik

`MODUL` menampilkan data; halaman ini mengubah konfigurasi yang menghasilkan data itu. Di referensi pun tempatnya terpisah — tombol tersendiri di kanan header, bukan salah satu modul di tengah. Masih satu halaman, jadi ditulis sebagai tautan langsung dan labelnya menyebut tujuannya ("Topic & Account") alih-alih "Administrator" yang tidak mengatakan apa yang akan terbuka. Begitu halaman admin kedua ada (T-064), ini berubah jadi dropdown yang memakai NavMenu seperti modul lain.

**Deviasi:** 10 kartu per halaman, bukan 5 seperti referensi — dengan 5, 108 topic jadi 22 halaman klik. Acceptance "108+ topic tanpa masalah kinerja" dipenuhi lewat desain (paginasi Postgres, urutan stabil, `selectinload`), bukan diukur terhadap 108 topic sungguhan; pengukurannya butuh Postgres jalan dan masuk verifikasi manual Docker/VPS. Perlu diingat untuk nanti: pencarian memakai `ILIKE %kata%` yang tidak bisa memakai indeks — tidak masalah di ratusan baris, tapi butuh indeks trigram kalau daftar topic tumbuh ke puluhan ribu. Panel kanan (tab General, Query Lists, Demography Filter) masih placeholder sampai T-059 s/d T-061, dan pemilih topic di filter bar — utang T-049 — belum dibuat; sekarang tidak terhalang lagi karena endpoint-nya sudah ada.

**Dampak biaya:** n/a. Tidak menyentuh ingestion maupun NLP; endpoint ini satu query Postgres kecil per pemuatan halaman.

**Next:** T-059

---

## T-057 · Auto-refresh & sinkronisasi state URL — 2026-09-13

**FR:** FR-402, FR-401

**Dikerjakan:** Auto-refresh dijadwalkan dari pemuatan terakhir dan ditunda selama tab tersembunyi; refresh yang gagal tidak lagi membuang data yang masih sah; feed Sentiment menahan post baru di balik tombol "N post baru" alih-alih menggantinya; dan tombol salin tautan mengunci rentang waktu ke jendela yang benar-benar dipakai server.

**File:** `apps/web/lib/auto-refresh.ts`, `apps/web/lib/api/use-dashboard.ts`, `apps/web/lib/filter-state.ts`, `apps/web/lib/api/analytics.ts`, `apps/web/components/filter/filter-bar.tsx`, `apps/web/components/sentiment/{sentiment-client,feed-sentimen}.tsx`, `apps/web/components/dashboard/dashboard-client.tsx`, `apps/web/app/globals.css`, `apps/web/vitest.setup.ts`, plus test di masing-masingnya

**Verifikasi:** 379 test web lolos di 16 berkas (dari 316 di 14 berkas); eslint, `tsc --noEmit`, dan `next build` bersih (`/conversation/sentiment` 5,9 kB). Tidak ada perubahan di sisi Python, jadi suite Python tidak dijalankan ulang.

### `setInterval` menjawab pertanyaan yang salah

T-049 memasang `setInterval(muatUlang, interval)` dan menganggap FR-402 selesai. Tiga hal baru terlihat waktu acceptance T-057 dibaca dengan serius:

- **Tab yang tidak dilihat siapa pun tetap menembak API.** Dashboard ini ditinggal terbuka sepanjang hari kerja, sering di beberapa tab sekaligus. Refresh sekarang ditunda selama `visibilityState === "hidden"` dan langsung menyusul saat tabnya terlihat lagi — kalau memang sudah jatuh tempo.
- **Jadwalnya tidak peduli kapan data terakhir dimuat.** Pengguna yang menekan refresh di menit ke-14 tetap mendapat refresh otomatis di menit ke-15. Sekarang jadwal dihitung dari pemuatan terakhir, jadi "tiap 15 menit" berarti data tidak pernah lebih tua dari 15 menit — bukan "tiap kelipatan 15 menit sejak halaman dibuka".
- **Acuannya harus percobaan terakhir, bukan keberhasilan terakhir.** Ini yang paling halus. Kalau jadwal diacukan ke pemuatan yang BERHASIL, satu kegagalan membuat acuannya diam di tempat — dan karena jadwal cuma dipasang ulang saat acuannya berubah, auto-refresh berhenti untuk selamanya setelah satu gangguan jaringan. Dashboard tetap terbuka, angkanya tidak pernah berubah lagi, dan tidak ada apa pun di layar yang mengatakannya. Karena itu `useDashboard` mengembalikan dua cap waktu: `terakhirDimuat` untuk indikator, `terakhirDicoba` untuk jadwal.

### Refresh yang gagal tidak boleh menghapus data yang masih benar

Aturan T-051 "kegagalan request mengalahkan kegagalan per panel" benar untuk pemuatan pertama, tapi salah untuk refresh: data di layar masih milik filter yang sama, cuma lebih tua. Menggantinya dengan panel error di seluruh halaman membuang informasi yang masih benar, dan tinggi panel yang runtuh ikut melempar posisi gulir — persis yang dilarang acceptance task ini.

Sekarang kegagalan dipisah dua. `galat` untuk "tidak ada data yang bisa ditampilkan", `galatPembaruan` untuk "yang tampil masih sah, pembaruannya yang gagal". Yang kedua muncul di filter bar sebagai "gagal memperbarui · data 14:32" — dengan jam datanya, karena "gagal" tanpa jam tidak mengatakan seberapa tua yang sedang dibaca.

Pembedanya `filterData`: filter yang MENGHASILKAN data di layar, bukan filter yang sedang dipilih. Kalau yang gagal adalah filter baru, data lama tetap dibuang — angka filter lama di bawah filter baru bukan jawaban atas pertanyaan yang sedang diajukan.

### Feed: post baru ditahan, bukan disisipkan

T-056 mengganti feed dengan halaman pertama yang baru setiap kali data dimuat ulang, dan halaman-halaman yang sudah dimuat ikut terbuang. Auto-refresh membuat feed menyusut ke halaman pertama; analis yang sedang membaca di halaman ketiga terlempar.

Perbaikan yang tampak jelas — menyisipkan post baru di atas dan mengandalkan scroll anchoring — dicoba dulu, lalu dibuang karena dua hal:

- **Tiga kolom bertambah dengan jumlah berbeda.** Scroll anchoring browser cuma menahan satu elemen; dua kolom lain tetap bergeser di bawah mata pembaca.
- **Celah yang tidak terlihat.** Kalau post baru lebih banyak dari satu halaman, halaman pertama yang baru tidak bersambung dengan feed lama. Post di antaranya tidak pernah tampil, dan tidak ada apa pun di layar yang menandainya — persis jenis kebohongan diam yang dilarang CLAUDE.md.

Jadi dipakai pola linimasa media sosial: halaman pertama yang baru ditahan, feed menampilkan "N post baru", dan penggantian terjadi saat analis memintanya. Angkanya ditandai "+" kalau satu kolom seluruhnya baru dan belum habis — artinya post baru tidak muat di satu halaman dan jumlah pastinya tidak diketahui; angka telanjang di situ akan terbaca sebagai jumlah pasti.

Tombolnya melayang di wadah setinggi nol, bukan mendorong feed ke bawah — tombol yang memakan tempat justru menghasilkan pergeseran yang ingin dicegah. Yang tetap diperbarui diam-diam cuma angka engagement post yang sudah tampil: angkanya berubah, tinggi kartunya tidak. Ganti filter tetap mengganti feed seketika, karena post filter lama tidak boleh bertahan di bawah filter baru.

### Bug: halaman lanjutan feed memakai filter yang salah

Ditemukan waktu memisahkan "filter terpilih" dari "filter milik data". Antara ganti filter dan datangnya data baru, feed di layar masih milik filter lama, tapi `muatLagi` menyusun requestnya dari filter yang sedang dipilih. Klik "muat lebih banyak" di jendela itu mengirim kursor feed lama bersama filter baru — kursor hanya bermakna untuk filter yang menghasilkannya, jadi post dua filter bisa tercampur di satu kolom. Sekarang halaman lanjutan selalu memakai `filterData`, dan hasilnya ditolak kalau feed sudah berganti.

### Tautan berbagi mengunci rentangnya

Acceptance "URL bisa dibagikan dan mereproduksi tampilan yang sama" tidak terpenuhi oleh preset relatif: `rentang=hari` berarti 24 jam terakhir DARI SAAT DIBUKA, jadi tautan yang disalin pukul 10.00 dan dibuka pukul 16.00 menampilkan jendela yang bergeser enam jam — lonjakan yang ingin ditunjukkan pengirimnya bisa sudah keluar dari layar.

`mulai`/`selesai` di URL menguncinya, dan tombol salin mengisinya dari echo filter milik respons (T-039 sengaja mengembalikannya untuk ini). URL di bilah alamat pengirim tetap preset, supaya tampilannya sendiri tetap hidup. Rentang tetap yang tidak masuk akal — cuma satu sisi, tanggal tak terbaca, urutan terbalik — jatuh ke preset alih-alih menghasilkan halaman penuh error dari tautan yang terpotong aplikasi chat.

### Indikator gagal tidak memakai teks merah

Warna merek `#d92121` cuma 3,22:1 di atas panel mode gelap — lolos ambang grafis 3:1 (WCAG 1.4.11), gagal ambang teks 4,5:1 (1.4.3). Indikator "gagal memperbarui" karena itu memakai warna teks biasa dengan titik merah kecil sebagai penanda: titiknya grafis, teksnya tetap terbaca. Teks merah yang sudah telanjur ada di `.feed-galat` dan `.panel-gagal strong` punya masalah yang sama dan belum disentuh di sini — itu utang tersendiri, bukan bagian T-057.

**Deviasi:** acceptance "posisi scroll terjaga" diverifikasi secara struktural — test memastikan tidak ada panel atau post yang dilepas atau diganti saat refresh, dan tinggi panel dikunci sejak T-050 — bukan dengan mengukur posisi gulir di browser sungguhan. Pengukuran itu butuh stack yang jalan dan masuk daftar verifikasi manual Docker/VPS. Interval refresh juga masih tersimpan per browser, belum per user, sampai auth T-064 ada.

**Dampak biaya:** menunda refresh di tab tersembunyi menghapus permintaan yang tidak dibaca siapa pun, dan tiap permintaan dashboard adalah satu pencarian OpenSearch (T-039). Tidak menyentuh ingestion maupun NLP.

**Next:** T-058

---

## T-056 · Halaman Sentiment lengkap — 2026-09-10

**FR:** FR-501 s/d FR-507

**Dikerjakan:** Route `/conversation/sentiment` dengan ketujuh panel: timeline, proporsi, feed tiga kolom berkursor, timeline dan pie berbobot engagement (dengan tabel selisih post-versus-engagement), serta empat panel per polaritas — timeline, text cloud, akun, hashtag cloud — untuk positif dan negatif.

**File:** `apps/web/app/conversation/sentiment/page.tsx`, `apps/web/components/sentiment/{panel-sentimen,feed-sentimen,panel-polaritas,sentiment-client}.tsx`, `apps/web/lib/api/analytics.ts`, `apps/web/app/globals.css`, `services/api/sma_api/analytics/panels/{sentiment,feed}.py`, plus test di kedua sisi

**Verifikasi:** 316 test komponen lolos (dari 265); 925 test Python lolos (dari 905); ruff, mypy, eslint, `tsc --noEmit`, dan `next build` bersih.

### Referensinya sendiri meleset, dan ternyata meleset secara sistematis

Dua screenshot yang dirujuk T-056 ternyata bukan halaman Sentiment. Kali ini polanya terlihat: setiap nomor di dokumen bergeser tepat +6 dari nama berkasnya. Koreksinya dikerjakan sebagai commit terpisah sebelum task ini, dengan entrinya sendiri di bawah. Referensi yang benar untuk halaman ini: `Screenshot_8` (timeline, proporsi, feed), `Screenshot_3` (versi berbobot engagement), `Screenshot_10` (panel per polaritas).

### FR-504 punya dua panel, API cuma punya satu

FR-504 berbunyi "timeline dan pie, tapi berbobot engagement". T-045 membuat pie-nya saja (`sentiment_engagement`). Ditambah `sentiment_engagement_timeline` dengan bentuk keluaran yang **sama persis** dengan `sentiment_timeline` — `kategori`, `titik[].per_sentimen`, `titik[].total` — hanya satuannya engagement, ditandai `dasar`. Hasilnya satu komponen UI menggambar keduanya, dan tidak ada jalur render kedua yang bisa menyimpang dari yang pertama.

### Bug di feed T-046: kolom yang habis diulang dari halaman pertama

Kursor gabungan T-046 hanya memuat kolom yang halamannya penuh. Kolom yang sudah habis tidak punya entri, jadi saat "muat lebih banyak" dia dicari tanpa `search_after` — dari halaman **pertama** lagi — dan post yang sama muncul dua kali di kolom yang sama. Tidak ada error; kolomnya cuma berulang setiap kali tombolnya ditekan.

Tidak tertangkap di T-046 karena test-nya menguji satu halaman pada satu waktu. Baru terlihat waktu merancang konsumennya dan menelusuri halaman kedua dengan satu kolom yang sudah habis.

Perbaikannya penanda `HABIS` di kursor gabungan. Kolom habis tetap dikirim ke msearch, dengan `match_none` dan `size: 0` — nyaris tanpa biaya — supaya urutan respons tetap sejajar dengan urutan kolom; melewatkannya akan menggeser pemetaan respons ke kolom yang salah. Test regresinya memutar ulang alur dua halaman persis yang dulu menggandakan post.

### Selisih post versus engagement ditampilkan berdampingan

Catatan FR-504 di PRD: di data referensi negatif adalah 82% dari post tapi cuma 11% dari engagement — dan selisih itu insight-nya. Kalau kedua pie berjauhan di halaman, selisihnya hilang. Jadi pie berbobot engagement menerima pie jumlah-post sebagai pembanding dan menampilkan tabel kecil: sentimen, persen post, persen engagement.

Kedua persennya dari server. Menghitung persen post di klien akan memakai pembulatan berbeda dari metode sisa terbesar T-045, dan dua angka berbeda untuk hal yang sama di layar yang sama tidak boleh ada. Kategori yang cuma ada di satu sisi ditandai "—", bukan dianggap nol.

### Feed tiga kolom

- **Urutan kolom Netral–Negatif–Positif**, seperti referensi, walau API mengirim negatif lebih dulu. Alasan yang sama dengan urutan menu T-048: pengguna hafal di mana kolom negatif berada.
- **Kepala kolom bergaris warna, bukan berlatar penuh seperti referensi.** Teks putih di atas `sentiment-positive` mode terang cuma sekitar 3,2:1 — lolos ambang grafis T-050, tapi gagal ambang teks 4,5:1 (WCAG 1.4.3).
- **Seluruh kartu bisa diklik lewat satu tautan** di cap waktu, dengan area klik diperluas CSS. Membungkus seluruh kartu dengan `<a>` membuat pembaca layar membacakan seluruh isi post sebagai nama tautannya.
- **URL dari provider disaring**: hanya http dan https yang boleh jadi tautan atau sumber gambar. URL post dan avatar datang dari pihak ketiga; `javascript:` di `href` akan dieksekusi di dashboard analis saat diklik. Teks post dirender sebagai teks, dan ada test yang memastikan `<b>` di dalamnya tidak jadi elemen.
- **Gambar memakai `<img>` biasa dengan `referrerPolicy="no-referrer"`**, bukan `next/image`: avatar datang dari CDN provider mana pun, dan `next/image` butuh setiap host didaftarkan lalu mem-proxy gambarnya lewat server kita. `no-referrer` supaya CDN platform tidak menerima URL dashboard ini.
- **Waktu post dalam WIB eksplisit**, konsisten dengan bucket dashboard (T-040). Aman dari hydration mismatch karena feed hanya dirender setelah data dimuat di browser.

### Infinite scroll, tapi dengan tombol

Halaman berikutnya dimuat otomatis waktu ujung feed terlihat, tapi tombol "Muat lebih banyak" tetap ada. Infinite scroll murni tidak bisa dipakai dari keyboard, dan kalau satu pemuatan gagal, pengulangan otomatis akan menembak server terus-menerus selama ujung feed masih terlihat. Setelah gagal, pemuatan otomatis berhenti dan tombolnya berubah jadi "Coba lagi".

### Halaman yang memuat, bukan panel

Aturan T-051 tetap berlaku: tujuh panel agregasi plus halaman pertama feed dilayani satu request. Halaman feed berikutnya dimuat oleh `SentimentClient`, bukan komponen feed. Callback-nya stabil lewat ref, karena komponen feed memasang IntersectionObserver berdasarkan fungsi itu — fungsi yang berganti tiap render membuat pengamatnya dipasang ulang tiap render.

Halaman tambahan dibuang setiap kali halaman pertama berganti. Kalau tidak, setelah filter diganti, halaman kedua milik filter lama tertumpuk di bawah halaman pertama filter baru, dan post dari dua filter berbeda tercampur di kolom yang sama. Post ganda dibuang berdasarkan id sebagai pertahanan kedua.

### Panel per polaritas

- **Timeline per kutub tidak butuh request baru** — dia satu deret dari `sentiment_timeline` yang sudah dimuat. Memuatnya terpisah bisa membuat dua panel di halaman yang sama menampilkan angka berbeda untuk sentimen yang sama.
- **Tiap panel menyebut penyebutnya** ("dari 30 post"), dengan alasan yang sama dengan T-046: 20 frasa dari 30 post dan 20 frasa dari 3.000 post tidak setara.
- **Frasa bisa diklik, hashtag tidak.** Frasa menyaring halaman lewat dimensi `isu` (T-052); hashtag tidak punya dimensi filter, dan elemen yang terlihat bisa diklik tapi tidak melakukan apa-apa lebih buruk daripada yang jelas pasif.
- **Daftar akun sebagai tabel**: handle, jumlah post, engagement (FR-507). Pembaca mencari nama akun, yang terbaca jauh lebih cepat di tabel daripada di chart batang.

**Deviasi:**

1. **Perubahan menyentuh sisi Python walau T-056 ada di epic UI** — panel API baru untuk FR-504 dan perbaikan kursor feed T-046. Keduanya tidak bisa disiasati di sisi klien tanpa menghasilkan angka yang salah.

2. **Kepala kolom feed tidak berlatar penuh seperti referensi** — alasan kontrasnya di atas.

3. **Posisi gulir saat auto-refresh belum dijaga.** Itu acceptance T-057. Untuk sekarang, pemuatan ulang data membuang halaman feed tambahan dan kembali ke halaman pertama.

**Dampak biaya:** n/a. Satu request per pembukaan halaman seperti Dashboard; halaman feed berikutnya satu `msearch`, dan kolom yang habis tidak lagi memicu pencarian sungguhan.

**Next:** T-057 (auto-refresh & sinkronisasi state URL) — task terakhir E6.

---

## Koreksi rujukan screenshot — 2026-09-10

**Merujuk:** PRD, TASK, ROADMAP, COST-MODEL, komentar kode, dan entri T-051, T-053, T-054, T-055 di bawah.

**Apa yang salah:** setiap nomor screenshot yang ditulis di sesi awal proyek bergeser **tepat +6 (mod 13)** dari nama berkasnya. Dokumen menyebut `Screenshot_8` untuk Exposure, berkasnya `Screenshot_1`; dokumen menyebut `Screenshot_2` untuk feed Sentiment, berkasnya `Screenshot_8`; dan begitu seterusnya untuk ketiga belasnya, tanpa pengecualian.

Buktinya tabel inventaris di ROADMAP.md: deskripsi tiap baris benar, nomornya yang bergeser. Diverifikasi dengan membuka ketiga belas berkas satu per satu. Riwayat git memperlihatkan ketiga belasnya masuk di commit pertama `ef00fbb` dengan nama sekarang dan tidak pernah di-rename — jadi pergeserannya terjadi sebelum commit pertama, kemungkinan besar waktu berkas dipindah ke `docs/screenshots/`.

**Diagnosis saya sebelumnya keliru.** Di entri T-053 saya menulis bahwa rujukan di TASK.md "salah" dan menyebutnya kelas kesalahan yang sama dengan "34 provinsi" — dokumen yang ditulis tanpa membaca sumbernya dengan teliti. Itu salah menebak sebabnya. Yang terjadi adalah satu pergeseran sistematis, dan saya menambalnya satu per satu di tiga task tanpa melihat polanya. Polanya baru terlihat waktu T-056 menunjuk dua screenshot yang lagi-lagi bukan halaman Sentiment, dan tabel ROADMAP dibandingkan langsung dengan isi berkasnya.

**Pemetaan (nomor lama di dokumen → berkas sebenarnya):**

| Di dokumen | Berkas | Isi |
|---:|---:|---|
| 1 | 7 | Filter bar, dropdown Conversation terbuka |
| 2 | 8 | Halaman Sentiment: timeline, proporsi, feed tiga kolom |
| 3 | 9 | Sentiment by gender dan age range (Fase 3) |
| 4 | 10 | Age range lanjutan; panel positif: timeline, text cloud, akun, hashtag |
| 5 | 11 | Topic & Account — tab General |
| 6 | 12 | Topic & Account — tab Query Lists |
| 7 | 13 | Dashboard, dropdown refresh interval terbuka |
| 8 | 1 | Dashboard atas: Exposure, Issues, Engagements History, Issue Engagement |
| 9 | 2 | Dashboard tengah: Total Posts, Total Replies, Topic Location |
| 10 | 3 | Dashboard bawah: Sentiment, proporsi, versi berbobot engagement |
| 11 | 4 | Perception stream, radar, emotion by engagement (Fase 2) |
| 12 | 5 | Hashtag treemap, user created time, posts comparison, most retweeted |
| 13 | 6 | Top accounts comment/reply, top retweet, active accounts |

Rumusnya: berkas = ((dokumen − 1 + 6) mod 13) + 1.

**Kenapa ini bukan sekadar kerapian dokumen:** E7 (Topic Admin UI) menunjuk `Screenshot_5` dan `Screenshot_6` — yang ternyata berisi chart Audience Fase 3, bukan form admin. Tanpa koreksi ini, T-058 sampai T-060 akan dibangun dengan referensi yang salah, dan tidak ada yang akan menyadarinya sampai hasilnya dibandingkan dengan produk aslinya.

**Yang diubah:**

- **Geser mekanis** (seluruh rujukannya dari sesi awal): PRD.md, docs/ROADMAP.md (tabel inventarisnya sekalian diurutkan ulang per nomor berkas), docs/COST-MODEL.md, komentar di `sma_schema/{enums,topic}.py`, `sma_core/geo/provinsi.py`, `sma_core/query/boolean.py`, `sma_worker/nlp/issues.py`, panel API `exposure`, `issues`, `feed`, `polaritas`, dan komponen web `panel-exposure`, `panel-issues`, `refresh-interval`.
- **Ganti eksplisit** (rujukan dari sesi ini, sebagian sudah memakai nomor berkas): baris TASK.md T-048 sampai T-060, panel API `totals` dan `lokasi` (keduanya saya tulis `Screenshot_8` — salah bahkan menurut penomoran lama), serta `panel-totals` dan `panel-lokasi` di web (`Screenshot_3` hanya memperlihatkan ekor panelnya; yang lengkap `Screenshot_2`).
- **`apps/web/lib/schema.generated.ts` di-generate ulang** dari `enums.py`, tidak diedit tangan.

**Membaca entri lama:** entri PROGRESS tidak diedit (aturan file ini). Entri dari sesi awal — misalnya estimasi biaya yang mengutip "porsi platform dari `Screenshot_9`" — memakai penomoran dokumen; terjemahkan lewat tabel di atas (9 → berkas 2). Entri E6 memakai nomor berkas, kecuali **T-051** yang menyalin "`Screenshot_8`" untuk Exposure dari PRD (berkasnya 1). Entri T-054 dan T-055 menyebut `Screenshot_3`; panel lengkapnya ada di `Screenshot_2`.

**Verifikasi:** `rg "Screenshot_\d+"` di seluruh repo setelah koreksi, dicocokkan dengan isi tiap berkas; ruff, mypy, tsc, dan test web tetap hijau.

---

## T-055 · Panel Topic Location (peta skematik) — 2026-09-10

**FR:** FR-408

**Dikerjakan:** Peta ubin skematik 38 provinsi plus daftar provinsi yang tersinkron dua arah, dengan porsi post tanpa lokasi ditulis di kepala panel.

**File:** `apps/web/lib/geo/peta-ubin.ts`, `apps/web/components/dashboard/{panel-lokasi,dashboard-client}.tsx`, `apps/web/components/chart/choropleth.tsx`, `apps/web/app/globals.css`, plus test untuk ketiganya

**Verifikasi:** 265 test komponen lolos (dari 231); eslint, `tsc --noEmit`, dan `next build` bersih.

### Peta skematik, atas keputusan user

Pilihannya diajukan ke user dengan tiga opsi — GeoJSON publik, peta skematik, atau menunda — dan user memilih skematik. Satu ubin berukuran sama per provinsi, diletakkan kira-kira di posisi geografisnya: Sumatra di kiri, Jawa dan Nusa Tenggara di bawah, Kalimantan di tengah atas, Sulawesi di kanannya, Maluku dan Papua di paling kanan.

Dua alasan yang membuat pilihan ini lebih dari sekadar jalan pintas:

1. **Batas provinsi adalah data, dan data tidak boleh dikarang.** Bentuk provinsi karangan akan terlihat seperti peta betulan dan salah di setiap detailnya — di dashboard yang dibaca sebagai sumber fakta.
2. **Di peta geografis, luas tidak ada hubungannya dengan jumlah post.** Papua dan Kalimantan menguasai layar, sementara DKI Jakarta — yang biasanya menyumbang percakapan terbanyak — cuma sebutir titik yang hampir mustahil di-hover. Di peta ubin tiap provinsi punya luas yang sama, jadi warnanya yang bicara, bukan ukuran pulaunya.

`Choropleth` menerima path SVG apa pun, jadi geometri geografis sungguhan bisa menggantikan peta ubin nanti tanpa menyentuh komponen maupun panelnya.

### Bug di choropleth T-050: nol dan ramai diwarnai sama

`tingkat()` memasukkan nilai nol **dan** nilai positif kecil ke jenjang yang sama. Jenjangnya dibagi rata dari maksimum, jadi dengan maksimum 1.000, provinsi dengan 150 post (di bawah seperlimanya) diwarnai persis sama dengan provinsi yang tidak punya post sama sekali. Dua kesimpulan yang berlawanan, satu warna.

Ketahuan karena acceptance T-055 meminta provinsi tanpa post tampil abu-abu — dan ternyata tidak ada kelas yang bisa diwarnai abu-abu tanpa ikut mewarnai provinsi yang ramai. Sekarang ada tiga keadaan, bukan dua:

    tanpa data   wilayahnya tidak ada di data sama sekali   ubin kosong bergaris putus
    nol          dihitung, dan hasilnya nol                  abu-abu padat
    jenjang 0-4  dihitung, dan ada post-nya                  skala biru

"Tanpa data" tetap dipisah dari "nol". T-044 selalu mengembalikan ke-38 provinsi, jadi di panel ini "tanpa data" hanya muncul kalau nama di peta dan di gazetteer T-028 tidak sinkron — dan itu justru yang harus terlihat, bukan tersamarkan jadi nol.

Test regresinya menguji kasus persisnya: `kelasWilayah(150, jenjang(1000))` harus berbeda dari `kelasWilayah(0, …)`.

### Nama provinsi dibaca langsung dari berkas Python

Ubin dicocokkan ke data lewat nama, dan gazetteer T-028 menulis **"Dki Jakarta"** — bukan "DKI Jakarta" seperti yang akan ditulis siapa pun dengan tangan. Beda satu huruf itu membuat ubinnya tampil kosong selamanya, tanpa satu pun error.

Jadi test-nya membaca tuple `PROVINSI` langsung dari `packages/core/sma_core/geo/provinsi.py` dan membandingkannya dengan daftar ubin. Ini pola yang sama dengan test CSS-versus-palet di T-050: dua sumber yang harus sama, diuji supaya tidak bisa berbeda diam-diam. Kalau gazetteer mengganti ejaan satu provinsi nanti, test web yang gagal — bukan peta yang diam-diam kosong.

Ada juga test posisi relatif: Papua harus di timur Sumatra, Jawa di selatan Kalimantan, DKI di pesisir utara Jawa, DIY di pesisir selatan. Peta skematik boleh tidak presisi, tapi susunan yang teracak membuatnya tidak terbaca oleh orang yang hafal bentuk Indonesia.

### Yang paling penting di panel ini bukan petanya

Sebagian besar post tidak punya lokasi yang bisa di-resolve. Peta yang tidak menyebut itu terlihat mewakili seluruh percakapan padahal mungkin cuma mewakili seperlimanya — jadi "6rb tanpa lokasi (78,6%)" ditulis tebal di kepala panel, bukan disembunyikan di tooltip, dan tetap ditulis walau angkanya nol.

Kalau **semua** post tidak berlokasi, panel ini tetap "siap", bukan "kosong". Ada post, hanya tidak ada yang bisa dipetakan; "tidak ada data" di situ memberi kesimpulan salah bahwa topic itu sepi.

Nama provinsi di luar peta — T-044 meneruskan nama yang tidak dikenal alih-alih membuangnya — tetap muncul di daftar dengan tanda "tidak di peta". Membuangnya membuat daftar tidak menjumlah ke totalnya.

### Sinkronisasi dua arah, termasuk dari keyboard

Hover di ubin menyorot barisnya, hover di baris menyorot ubinnya. Hover saja membuat sinkronisasi tidak bisa dipakai tanpa mouse, dan 38 ubin sebagai tab stop terlalu banyak — jadi baris daftar yang bisa difokus, dan fokus keyboard ikut menyorot peta.

Label singkatan di atas ubin memakai halo warna panel (`paint-order: stroke`), jadi terbaca di atas jenjang warna mana pun, termasuk biru tergelap, di kedua tema. Singkatannya yang lazim dipakai (SUMUT, JABAR, KALTARA), bukan karangan, dan dibatasi tujuh karakter supaya muat di ubin 40px.

Panelnya membentang dua kolom grid: 38 ubin di separuh lebar layar terlalu kecil untuk labelnya.

**Deviasi:**

1. **Peta skematik, bukan peta geografis seperti `Screenshot_3.png`.** Diputuskan user; alasannya di atas dan di TASK.md.

2. **Komponen `Choropleth` T-050 diubah.** Bug nol-dan-ramai-sewarna ada di sana, bukan di panel ini. Ditambah dukungan label dan pusat label per wilayah untuk peta ubin.

3. **Dua test saya sendiri yang salah, bukan kodenya.** Persentase yang saya hitung di kepala (78,7%) meleset dari yang benar (6.000 / 7.630 = 78,64% → 78,6%). Dan `tab()` pertama mendarat di ikon info panel, bukan di daftar — ikon itu memang dibuat bisa difokus di T-051 supaya keterangannya terbaca tanpa mouse. Test-nya sekarang menekan Tab dua kali dan menegaskan fokusnya di baris pertama.

**Dampak biaya:** n/a. Panel keenam di request yang sama.

**Next:** T-056 (halaman Sentiment lengkap).

---

## T-054 · Panel Total Posts & Replies — 2026-09-09

**FR:** FR-407

**Dikerjakan:** Kartu angka per platform dengan rincian per tipe, seperti kartu "Count - <platform>" di `Screenshot_3.png`.

**File:** `apps/web/components/dashboard/{panel-totals,dashboard-client}.tsx`, `apps/web/app/globals.css`, `apps/web/components/dashboard/totals.test.tsx`

**Verifikasi:** 231 test komponen lolos (dari 216); eslint dan tsc bersih.

### Kartu angka, bukan bar chart

Angkanya sedikit, tidak berubah bentuk, dan yang dicari pembaca adalah nilainya — bukan perbandingan visualnya. Bar chart untuk enam angka memaksa mata membandingkan panjang batang untuk membaca sesuatu yang bisa ditulis langsung, dan tetap butuh label angkanya juga.

Produk referensi memakai kartu untuk panel ini, dan alasannya masuk akal.

### Tipe yang tidak ada tidak ditulis sebagai nol

Ini pasangan sisi UI dari keputusan di T-043. Daftar tipe memang berbeda per platform: Threads sering cuma punya post, Twitter punya post dan reply. Menulis "Reply 0" pada platform yang tidak punya konsep reply menyiratkan sesuatu yang salah — seolah ada reply yang seharusnya ada tapi hilang.

Berbeda dengan Exposure, yang justru **mengisi** platform absen dengan nol supaya lapisan area chart-nya tidak putus. Bedanya: di sana bucket-nya ada dan isinya dihitung; di sini kategorinya memang tidak berlaku.

### Kategori `unknown` tetap punya kartunya

T-043 mengembalikan tipe `unknown` justru supaya rincian menjumlah ke totalnya. Kalau UI menyaringnya, selisih itu muncul kembali — kali ini di layar, dan tanpa penjelasan.

Hal yang sama berlaku untuk platform di luar palet: kartunya tetap dibuat dengan warna `unknown`. Melewatinya membuat jumlah kartu tidak menjumlah ke total panel.

### Urutan kartu stabil

Diurutkan menurun, dengan nama sebagai pemecah seri. Dua platform berjumlah sama yang bertukar tempat tiap refresh membuat pembaca kehilangan posisi setiap lima belas menit — masalah yang sama dengan word cloud acak di T-050 dan legend peta di T-044.

### Warna platform jadi garis, bukan latar kartu

Latar berwarna penuh membuat angkanya sulit dibaca dan memaksa warna teks ikut berubah per platform — dan palet platform sengaja berjenjang luminansinya (T-050), jadi sebagian butuh teks putih dan sebagian teks hitam. Garis tipis di tepi kiri memberi identitas warna tanpa menyentuh keterbacaan.

**Deviasi:** tidak ada.

**Dampak biaya:** n/a. Panel kelima di request yang sama.

**Next:** T-055 (panel Topic Location, peta Indonesia).

---

## T-053 · Panel Engagements History & Issue Engagement — 2026-09-09

**FR:** FR-405, FR-406

**Dikerjakan:** Dua panel bagian bawah dashboard: total engagement sepanjang waktu, dan word cloud frasa berbobot engagement.

**File:** `apps/web/components/dashboard/{panel-engagements,dashboard-client}.tsx`, `apps/web/components/dashboard/engagements.test.tsx`

**Verifikasi:** 216 test komponen lolos (dari 204); eslint, tsc, dan build bersih.

### Referensi screenshot di TASK.md ternyata salah

T-053, T-054, dan T-055 sama-sama menunjuk `Screenshot_9.png`. Waktu dibuka, isinya panel demografi Fase 3 — sentiment by gender dan sentiment by age range — bukan satu pun dari ketiga panel itu.

Yang benar: Engagements History dan Issue Engagement ada di `Screenshot_1.png` bagian bawah, Total Posts adalah kartu "Count - <platform>" di `Screenshot_3.png`, dan Topic Location adalah peta plus daftar provinsi di kanan atas `Screenshot_3.png`. Ketiga referensinya sudah dikoreksi di TASK.md.

Ini kelas kesalahan yang sama dengan "34 provinsi" di T-055 dan urutan menu di T-048: dokumen perencanaan yang ditulis sebelum sumbernya dibaca ulang dengan teliti.

### Ukuran kata mengikuti engagement, bukan jumlah post

Ini satu-satunya hal yang membuat panel Issue Engagement berbeda dari panel Issues, dan gampang salah karena `PanelIssues` membawa **kedua** angka: `jumlah` dan `engagement`. Memakai `jumlah` menghasilkan panel yang kembar persis dengan tetangganya — dua panel yang menampilkan hal yang sama, di halaman yang sengaja menampilkan keduanya berdampingan supaya selisihnya terlihat.

Test-nya memakai pola data yang sama dengan T-041: "harga beras naik" (500 kali disebut, 12rb engagement) versus "pungli parkir bandara" (40 kali, 900rb engagement), dan memeriksa ukuran fontnya terbalik dari panel Issues. Kalau ada yang menukar fieldnya nanti, itu yang gagal.

### Garis, bukan area, untuk satu deret

Engagements History cuma punya satu deret. Area di bawah garis untuk satu deret menambah tinta tanpa menambah informasi — dan pada mode gelap, area besar berwarna penuh justru menutupi grid sumbunya.

### Word cloud yang semua nilainya nol tetap "kosong"

Frasa bisa ada sementara engagement-nya nol semua — post terkumpul tapi belum ada yang bereaksi. Word cloud dengan semua kata seukuran tidak menyampaikan apa pun, jadi lebih jujur bilang tidak ada data daripada menampilkan sepuluh kata sama besar yang terlihat seperti hasil.

**Deviasi:** tidak ada, selain koreksi referensi screenshot di atas.

**Dampak biaya:** n/a. Kedua panel ikut ke request yang sama — daftar `PANEL` bertambah dua nama, jumlah request tetap satu.

**Next:** T-054 (Total posts & replies).

---

## T-052 · Panel Issues word cloud — 2026-09-09

**FR:** FR-404

**Dikerjakan:** Word cloud frasa isu yang bisa diklik untuk menyaring seluruh dashboard, plus dimensi filter `isu` di API yang dibutuhkannya.

**File:** `apps/web/components/dashboard/{panel-issues,dashboard-client}.tsx`, `apps/web/lib/filter-state.ts`, `apps/web/lib/api/analytics.ts`, `services/api/sma_api/analytics/{filters,router,cache}.py`, plus test di kedua sisi

**Verifikasi:** 204 test komponen lolos (dari 189); test Python bertambah 7; ruff, mypy, eslint, tsc, dan build semuanya bersih.

### Acceptance-nya menuntut dimensi filter yang belum ada

"Klik frasa memfilter tampilan" tidak bisa dipenuhi dengan apa pun yang ada di `FilterDashboard`: filter global punya topic, rentang, platform, bahasa, sentimen, dan provinsi — tidak ada frasa isu. Jadi dimensinya ditambahkan di API, bukan disiasati dengan penyaringan di sisi klien.

Penyaringan di klien akan salah dengan cara yang tidak terlihat: word cloud hanya memuat dua puluh frasa teratas, dan panel lain di halaman yang sama tidak punya informasi frasa sama sekali. Yang bisa dilakukan klien cuma menyaring apa yang sudah dia terima — dan yang diminta adalah menyaring apa yang diambil.

**Klik frasa menyaring SELURUH halaman, bukan cuma panel Issues.** Analis yang melihat "penanganan bencana" besar di word cloud berikutnya ingin tahu kapan ramainya, di platform mana, sentimennya apa. Menyaring cuma panel itu sendiri tidak menjawab satu pun.

### `terms`, bukan beberapa `term`

Klausanya `{"terms": {"nlp.issues": [...]}}` — artinya ATAU. Beberapa klausa `term` terpisah berarti DAN, dan memilih dua frasa dari word cloud hampir selalu memberi nol post: satu post jarang memuat dua frasa isu teratas sekaligus. Hasilnya panel kosong yang terlihat seperti kesalahan sistem, padahal query-nya memang mustahil.

### Kunci cache harus ikut berubah, dan ini yang paling mudah terlupa

Menambah dimensi filter tanpa menambahkannya ke `sidik_permintaan` (T-047) membuat dua permintaan berbeda berbagi satu entri cache — yang kedua menerima hasil filter yang bukan miliknya. Tidak ada error; angkanya cuma milik orang lain.

Ditambah test penjaga umum yang membandingkan sidik untuk **setiap** dimensi filter sekaligus. Kalau ada yang menambah dimensi lagi nanti dan lupa memasukkannya, test itu yang gagal dengan menyebut nama dimensinya.

### Frasa isu tidak bisa divalidasi terhadap daftar tetap

Berbeda dengan platform dan sentimen yang punya enum, isi frasa ditemukan dari data (T-034). Yang bisa dijaga cuma bentuknya: panjang maksimum 120 karakter dan paling banyak lima frasa sekaligus, supaya URL karangan tidak membuat query raksasa.

Frasa dipisah koma di URL web. Aman karena frasa isu adalah n-gram token hasil T-034 dan tokenisasinya sudah membuang tanda baca — tidak ada frasa yang memuat koma. Ke API dikirim sebagai parameter berulang, karena FastAPI membaca `list[str]` begitu.

### Klik kedua melepas filternya

Tanpa itu, satu-satunya cara membatalkan pilihan adalah mengedit URL. Word cloud adalah tempat orang menjelajah, jadi membatalkan pilihan sama seringnya dengan memilih.

Pilihannya ditulis ke URL seperti filter lain, bukan disimpan di state lokal. Konsekuensinya: ikut waktu link dibagikan, dan tombol Back membatalkannya.

### Sisa daftar tidak disembunyikan

T-041 mengembalikan `di_luar_daftar` justru supaya angkanya terlihat. Panel menampilkannya sebagai "+5rb lainnya" — dua puluh frasa dari korpus lima ribu tanpa menyebut sisanya terlihat seperti seluruh isinya.

**Deviasi:**

1. **Perubahan menyentuh sisi Python, padahal T-052 ada di epic UI.** Acceptance-nya tidak bisa dipenuhi tanpa itu. Yang ditambahkan minimal: satu field di `FilterDashboard`, satu parameter di router, satu klausa di query, satu entri di kunci cache.

**Dampak biaya:** klausa `terms` tambahan pada query yang sudah ada — tidak menambah pencarian, tidak menambah panggilan provider.

**Next:** T-053 (Engagements history & Issue engagement).

---

## T-051 · Panel Exposure — 2026-09-09

**FR:** FR-403

**Dikerjakan:** Panel Exposure sesuai `Screenshot_8.png`, plus lapisan pemuatan data yang dipakai bersama seluruh sisa E6.

**File:** `apps/web/lib/api/{analytics,use-dashboard}.ts`, `apps/web/lib/chart/waktu.ts`, `apps/web/components/dashboard/{panel-exposure,dashboard-client}.tsx`, `apps/web/app/page.tsx`, plus test

**Verifikasi:** 189 test komponen lolos (dari 166); eslint bersih; `tsc --noEmit` bersih; `next build` sukses.

### Yang memanggil API adalah halaman, bukan panel

Ini keputusan yang menentukan apakah seluruh rancangan E5 terpakai atau terbuang. Endpoint `/analytics/dashboard` sengaja dibuat melayani banyak panel dalam satu pencarian (T-039, FR-401). Kalau tiap komponen panel memanggil sendiri — cara yang paling wajar ditulis di React — tujuh panel jadi tujuh kali mengeksekusi filter yang identik di OpenSearch, dan pekerjaan T-039 sampai T-046 tidak menghasilkan apa-apa.

Jadi `DashboardClient` yang memanggil, sekali, dengan daftar panel yang dia butuhkan. Komponen panel menerima potongannya lewat props dan tidak tahu apa-apa soal jaringan. T-052 sampai T-055 tinggal menambah nama ke daftar `PANEL`; jumlah request tetap satu.

### Tiga jenis kegagalan yang tidak boleh disamakan

    jaringan   permintaannya tidak sampai
    http       sampai, tapi ditolak (422 filter salah, 5xx)
    panel      request berhasil, satu panel tidak bisa dibaca

Yang ketiga datang dari `gagal` di respons (T-039) dan hanya mengenai panel bersangkutan. Menyamakan ketiganya berarti satu agregasi yang bentuknya berubah mengosongkan seluruh halaman — persis yang dihindari waktu merancang sisi servernya.

Urutan penggabungannya juga disengaja: kegagalan seluruh request mengalahkan kegagalan per panel, karena kalau requestnya sendiri gagal, tidak ada informasi per panel sama sekali.

Pesan 422 dibaca dari `detail`, bukan ditampilkan sebagai "HTTP 422". T-039 sudah menyusun pesan yang menyebut field mana yang salah; membuangnya berarti menyia-nyiakan yang sudah disediakan server.

### Request lama dibatalkan, bukan dibiarkan selesai

Auto-refresh berjalan tiap 5 sampai 60 menit dan pengguna mengganti filter di antaranya. Tanpa `AbortController`, dua permintaan bisa beredar bersamaan dan yang lebih **lambat** bisa datang belakangan — dashboard lalu menampilkan data filter lama sesudah filter baru diterapkan. Tidak ada error, cuma angka yang tidak cocok dengan filter di layar.

`AbortError` diperlakukan bukan sebagai kegagalan. Menampilkannya sebagai error membuat halaman berkedip merah setiap kali filter diganti.

### Label waktu memakai offset dari server

`key_as_string` OpenSearch membawa offset zona yang dipakai saat agregasi — Asia/Jakarta (T-040). Memformat ulang lewat objek `Date` akan menampilkannya di zona browser: bergeser satu jam untuk pengguna di WITA, tujuh jam untuk yang membuka dari luar negeri, sementara datanya tetap dikelompokkan per hari WIB. Labelnya lalu tidak cocok dengan isi bucketnya, dan tidak ada yang salah di layar.

Jadi ISO-nya diurai dengan regex dan komponennya dipakai apa adanya, tanpa melewati `Date` sama sekali.

### Data lama tetap ditampilkan saat memuat ulang

`tentukanKeadaan` mengembalikan "siap", bukan "memuat", kalau sudah ada data sebelumnya. Mengosongkan panel tiap auto-refresh membuat dashboard berkedip tiap lima belas menit — dan lima belas menit adalah default-nya.

Panel yang gagal juga tidak pernah tampil sebagai "tidak ada data": urutan pemeriksaannya menaruh kegagalan lebih dulu, dan ada test untuk itu.

### Platform di luar daftar tetap digambar

Kalau server mengembalikan platform yang belum ada di palet Fase 1, seri-nya tetap digambar dengan warna `unknown`. Melewatinya membuat total tiap bucket tidak cocok dengan panel Total Posts (T-043), dan tidak ada yang bisa menjelaskan selisihnya.

**Deviasi:**

1. **Lapisan pemuatan data tidak ada di daftar task.** Sama seperti Vitest di T-048: dia prasyarat untuk enam task berikutnya, dan menundanya berarti menempelkan pemanggilan API ke enam panel yang sudah jadi.

2. **Tipe respons panel ditulis tangan, dan itu celah.** Panel di sisi Python mengembalikan `dict[str, Any]`, bukan model Pydantic, jadi `make schema` tidak bisa menurunkan tipe TS-nya seperti model domain lain. Artinya kedua sisi bisa melenceng tanpa ada yang menggagalkan build. Pembacaan di TS dibuat defensif (field hilang jadi nilai kosong, bukan crash), dan celahnya dicatat di TASK.md — menutupnya berarti menjadikan keluaran ketiga belas panel model Pydantic, dan itu pekerjaan tersendiri.

3. **Bug ditemukan test: ikon info panel diberi `role="img"`.** Itu salah dua kali — ikon itu menyampaikan keterangan, bukan gambar, dan role-nya bertabrakan dengan chart di panel yang sama yang memang ber-role img. Diganti `role="note"`.

**Dampak biaya:** n/a langsung. Tapi rancangan "halaman yang memanggil, bukan panel" adalah yang menjaga beban OpenSearch tetap satu pencarian per pembukaan halaman — asumsi yang dipakai anggaran infra di [COST-MODEL.md](docs/COST-MODEL.md).

**Next:** T-052 (panel Issues word cloud).

---

## T-050 · Chart primitives — 2026-09-09

**FR:** — (fondasi panel T-051 s/d T-056)

**Dikerjakan:** Palet chart per-tema yang kontrasnya dihitung, skala dan tick sumbu, pembungkus panel berikut keadaan-keadaannya, dan lima primitif gambar: area bertumpuk, garis, donut, word cloud, treemap, choropleth.

**File:** `apps/web/lib/chart/{kontras,palet,skala}.ts`, `apps/web/components/chart/{panel,area-chart,pie-chart,word-cloud,choropleth}.tsx`, `apps/web/app/globals.css`, plus test untuk semuanya

**Verifikasi:** 166 test komponen lolos (dari 60); eslint bersih; `tsc --noEmit` bersih; `next build` sukses.

### Palet T-009 gagal WCAG di mode gelap, dan tidak ada yang menyadarinya

Acceptance-nya "warna lolos kontras WCAG AA" — itu angka, bukan penilaian. Waktu benar-benar dihitung, **enam dari sepuluh** warna gagal ambang 3:1 di mode gelap:

| Token | Rasio | Keterangan |
|---|---:|---|
| `platform-threads` #1c1c1c | 1,06:1 | hitam di atas hampir-hitam |
| `platform-tiktok` #363636 | 1,34:1 | |
| `sentiment-neutral` #3a3a3a | 1,42:1 | |
| `platform-facebook` #1a3d8f | 1,62:1 | |
| `sentiment-positive` #1a3fd4 | 2,08:1 | |
| `sentiment-negative` #b32000 | 2,40:1 | |

Sebabnya sederhana: palet itu menyalin warna produk referensi apa adanya dan dipakai untuk kedua tema. Yang membuatnya tidak tertangkap adalah chart-nya tetap "terlihat gelap dan rapi" — bentuknya ada, warnanya yang hilang.

Sekarang ada dua palet, dan yang gelap dihitung, bukan ditaksir.

### Ambangnya 3:1, bukan 4,5:1

WCAG 2.1 punya dua ambang yang sering tertukar: 1.4.3 (teks, 4,5:1) dan 1.4.11 (objek grafis, 3:1). Isi chart adalah objek grafis. Memakai 4,5:1 terdengar lebih aman tapi memaksa seluruh palet jadi gelap dan justru membuat kategori sulit dibedakan **satu sama lain** — kegagalan aksesibilitas tersendiri.

### Luminansi platform berjenjang, bukan cuma hue-nya yang berbeda

Enam platform di satu area chart bertumpuk harus terbedakan oleh pembaca buta warna dan pada cetakan hitam-putih. Hue saja tidak cukup: biru Twitter dan teal TikTok punya luminansi hampir sama, dan keduanya jadi abu-abu identik begitu warnanya dilepas — terukur 1,01:1 antar keduanya di percobaan pertama.

Paletnya disusun sebagai deret geometris kontras: tiap seri minimal 1,25x lebih terang dari seri sebelumnya, sambil mempertahankan hue merek. Test memeriksa **setiap pasangan**, bukan cuma terhadap latar.

Palet sentimen sengaja tidak seketat itu. Cuma tiga kategori, selalu berlabel, dan "merah = negatif" adalah sifat paling penting dari seluruh dashboard — memaksa jenjang penuh membuat negatif jadi maroon gelap yang tidak lagi terbaca sebagai merah. Ada test yang menjaga kanal merahnya tetap mendominasi.

### CSS dan modul palet diuji supaya tidak berbeda

Chart merender lewat `var(--color-...)` supaya pergantian tema murni CSS — tidak ada deteksi tema di JavaScript, jadi tidak ada risiko hydration mismatch (pelajaran T-049). Konsekuensinya nilai warna hidup di dua tempat: modul TypeScript yang diuji, dan CSS yang dirender.

Ada test yang membandingkan keduanya. Tanpa itu, yang diuji bukan yang dirender — dan test kontras yang menguji angka yang tidak dipakai lebih buruk daripada tidak ada test sama sekali.

### Keadaan panel ada tiga, bukan dua

Acceptance menyebut "kosong dan loading". Ditambahkan yang ketiga:

    memuat   sedang menunggu jawaban
    kosong   jawabannya datang, isinya memang tidak ada
    gagal    jawabannya tidak datang

Menggabungkan dua yang terakhir adalah kesalahan paling mahal di dashboard monitoring. Panel yang gagal dimuat lalu ditampilkan sebagai "tidak ada data" memberi tahu analis bahwa **tidak ada percakapan** tentang suatu isu, padahal yang terjadi adalah sistemnya tidak menjawab. Kesimpulannya berlawanan, dan tidak ada apa pun di layar yang membedakan.

T-039 sudah menyiapkan sisi servernya — panel yang gagal masuk ke `gagal` di respons, bukan dikosongkan. Ini pasangannya di sisi UI.

Tinggi panel dikunci di semua keadaan, supaya panel tidak melompat waktu data datang dan menggeser panel di bawahnya persis saat analis sedang membaca.

### Digambar sendiri, bukan memakai pustaka chart

Bukan karena menghindari dependensi demi menghindarinya:

1. Warna harus lewat CSS variable. Sebagian besar pustaka chart menghitung warna di JavaScript dan menuliskannya sebagai nilai literal, yang berarti tema harus dideteksi di JS — kembali ke masalah hydration yang sudah diselesaikan di T-049.
2. Word cloud, treemap, dan peta 38 provinsi Indonesia tetap harus digambar sendiri. Menambah pustaka untuk separuh kebutuhan berarti dua sistem gambar di satu halaman.
3. Bentuk yang dibutuhkan sederhana.

Responsif lewat `viewBox` + `width: 100%`, bukan ResizeObserver: mengukur elemen berarti render pertama selalu memakai ukuran salah lalu menggambar ulang — terlihat sebagai kedipan di setiap panel setiap kali halaman dibuka.

### Bug yang ditemukan test sendiri

**Sumbu Y tidak mencakup data.** `batasAtas(6847)` mengembalikan 6000 dan `batasAtas(7)` mengembalikan 6. Penyebabnya batas atas dihitung sebagai kelipatan terakhir yang **≤** maksimum, bukan yang pertama **≥**. Akibatnya puncak grafik terpotong tanpa satu pun tanda bahwa ada yang hilang.

**Warna `unknown` dipilih dengan melihat layar dan gagal keduanya** — 2,3:1 di terang, 2,2:1 di gelap. Kategori `unknown` justru yang paling harus terlihat (aturan CLAUDE.md).

### Keputusan kecil yang punya alasan

- **Word cloud tidak memakai tata letak acak.** Susunan yang berubah tiap refresh membuat analis kehilangan tempat setiap lima belas menit. Urutannya deterministik, dan ukuran font memakai akar kuadrat frekuensi supaya **luas** kata yang sebanding dengan frekuensi — bukan tingginya, yang membuat frasa dua kali lebih sering terlihat empat kali lebih besar.
- **Treemap slice-and-dice, bukan squarified.** Squarified menghasilkan kotak lebih persegi tapi urutannya berubah banyak untuk perubahan data kecil.
- **Choropleth berjenjang, bukan gradien.** Tidak ada yang bisa menyebut angka dari sebuah rona biru; yang bisa dilakukan adalah membandingkan dengan legend.
- **Wilayah tanpa data berwarna sendiri**, bukan warna terendah skala — "nol post dari sana" dan "kami tidak punya datanya" berbeda.
- **Donut memakai persen dari server**, tidak menghitung ulang. T-045 sudah memakai metode sisa terbesar; menghitung ulang dengan pembulatan biasa memberi 99,9% di legend sementara servernya bilang 100%.
- **Word cloud jadi `<span>`, bukan `<button>`, kalau tidak ada yang menanggapi kliknya.** Elemen yang terlihat bisa diklik tapi tidak melakukan apa-apa lebih buruk daripada yang jelas pasif.

**Deviasi:**

1. **Palet T-009 diganti, bukan ditambal.** Nilai lamanya tidak dipertahankan di mode terang pun — beberapa juga bermasalah di sana (twitter #4aa8e8 = 2,61:1 terhadap putih), dan threads/tiktok praktis sewarna di kedua tema.

2. **Geometri peta Indonesia tidak ada di sini.** `Choropleth` menerima path sebagai data; bentuk 38 provinsinya bagian dari T-055. Keduanya berubah karena alasan berbeda: skala warna adalah keputusan visualisasi, batas wilayah adalah data.

**Dampak biaya:** n/a.

**Next:** T-051 (panel Exposure).

---

## T-049 · Filter bar global & refresh interval — 2026-09-09

**FR:** FR-401, FR-402

**Dikerjakan:** Filter bar mengikuti `Screenshot_7.png`, dengan state filter di URL dan interval refresh di penyimpanan browser.

**File:** `apps/web/lib/{filter-state,refresh-interval}.ts`, `apps/web/components/filter/filter-bar.tsx`, `apps/web/app/{page,globals.css}`, plus test untuk ketiganya

**Verifikasi:** 60 test komponen lolos (dari 22); eslint bersih; `tsc --noEmit` bersih; `next build` sukses.

### URL adalah sumber kebenaran, bukan salinannya

FR-401 minta state filter tersimpan di URL supaya halaman bisa di-bookmark dan dibagikan. Cara yang salah — dan yang paling sering dipakai — adalah menyimpan state di React lalu menyalinnya ke URL. Dua sumber kebenaran akan berbeda begitu pengguna menekan Back, dan yang muncul bukan tampilan yang diminta URL-nya.

Jadi tidak ada state filter di React sama sekali. Nilainya dibaca dari `useSearchParams` dan ditulis lewat router; `lib/filter-state.ts` menyediakan kedua arahnya sebagai fungsi murni, jadi bisa diuji tanpa merender apa pun.

**`replace`, bukan `push`.** Mengubah filter bukan berpindah halaman. Dengan `push`, pengguna yang mengganti platform lima kali harus menekan Back lima kali untuk meninggalkan halaman. Ada test khusus untuk ini karena keduanya sama-sama "bekerja" dan bedanya cuma terasa saat dipakai.

**`scroll: false`.** Analis yang sedang membaca panel di bawah tidak boleh terlempar ke atas tiap kali mengganti filter.

### URL ditulis supaya bisa dibaca manusia

Link ini akan ditempel di grup WhatsApp dan tiket, lalu dibuka lagi berbulan-bulan kemudian. `?topic=kdmp&rentang=minggu&platform=twitter,tiktok` bisa dimengerti sekilas; `?t=..&r=2&p=1,3` tidak — dan angka yang artinya bergeser antar rilis membuat link lama membuka tampilan berbeda tanpa ada yang sadar.

Dua aturan lain yang menyusul dari sana:

- **Nilai default tidak ditulis.** URL yang memuat semua parameter meski isinya default jadi panjang, dan dua URL yang menampilkan hal yang sama akan terlihat berbeda — langsung jadi masalah begitu hasilnya di-cache berdasarkan URL (T-047).
- **Daftar platform diurutkan.** Alasan yang sama: dua pilihan yang sama harus menghasilkan URL yang sama.

**Nilai tak dikenal dibuang, bukan menggagalkan halaman.** URL datang dari luar — disalin sebagian, dipotong aplikasi chat, atau dibuat rilis lama dengan daftar platform berbeda. `platform=twitter,friendster,tiktok` menghasilkan dua platform yang sah, bukan error.

### Interval refresh tidak ikut ke URL

Interval adalah **preferensi**, bukan bagian dari tampilan. Kalau ikut di URL, orang yang membagikan link ikut memaksakan kebiasaan refresh-nya ke penerima — dan penerima yang membukanya di jaringan lambat mendapat halaman yang menyegarkan diri tiap lima menit tanpa pernah memintanya.

Yang di URL adalah apa yang dilihat; yang disimpan adalah bagaimana seseorang suka bekerja.

### Dua tempat yang memicu hydration mismatch, dan keduanya dijaga

Ini kelas bug yang tidak muncul di test biasa, jadi keduanya diuji dengan `renderToStaticMarkup` — render tanpa efek, persis seperti server:

1. **Indikator "diperbarui HH:MM".** Waktu di server berbeda dari waktu di klien; selisih milidetik saja sudah cukup membuat React membuang seluruh hasil render server.
2. **Interval yang dibaca dari localStorage.** Server tidak punya localStorage, jadi membacanya saat render pertama menghasilkan HTML yang berbeda antara keduanya.

Keduanya dipasang setelah mount. Test-nya memeriksa HTML server benar-benar tidak memuat jam maupun nilai tersimpan — kalau penjaganya dilepas, test yang gagal.

`localStorage` juga bisa **melempar**, bukan cuma mengembalikan null: browser dengan penyimpanan situs dimatikan melempar `SecurityError`. Preferensi kecil tidak boleh menjatuhkan halaman, jadi kegagalan apa pun jatuh ke nilai awal.

**Deviasi:**

1. **`onRefresh` sengaja tidak diisi di halaman Dashboard.** Mengisinya dengan fungsi yang cuma memperbarui stempel waktu akan membuat indikator menampilkan "diperbarui 14:32" padahal tidak ada yang dimuat. Indikator yang berbohong lebih buruk daripada indikator yang belum berfungsi. Penyambungan sungguhannya di T-057, setelah panel-panelnya ada.

2. **Pemilih topic belum berupa dropdown.** Daftar topic yang bisa dipilih datang dari API admin (T-058). Mengarangnya sekarang berarti dropdown berisi topic yang tidak ada. Chip-nya menampilkan nilai dari URL, dan "belum dipilih" kalau kosong.

3. **`[~]`, bukan `[x]`.** Acceptance "pilihan interval tersimpan per user" baru bisa berarti per akun setelah T-064. Sekarang per browser — pendekatan terdekat yang jujur selama belum ada konsep user, dan sudah ditulis di kodenya supaya tidak terlupa saat auth datang.

**Dampak biaya:** n/a.

**Next:** T-050 (chart primitives).

---

## Koreksi T-048 · urutan menu Conversation — 2026-09-09

**Merujuk:** entri T-048 di bawah.

**Apa yang salah:** urutan item dropdown Conversation saya karang sendiri (Sentiment lebih dulu, lalu Perception, Chronology, dan seterusnya). Produk referensi memakai urutan Chronology, Gallery, Issues, Engagement, **Emotion**, Sentiment, Contributors, Issues Comparison — terlihat jelas di `Screenshot_7.png`, yang baru saya buka saat mulai T-049.

**Kenapa ini bukan hal kecil:** entri T-048 sendiri berargumen bahwa item Fase 2 ditampilkan nonaktif justru supaya posisi menu tidak bergeser dan hafalan pengguna tetap benar. Menulis argumen itu lalu memakai urutan karangan sendiri membatalkan seluruh alasannya.

Sekalian: labelnya "Emotion", bukan "Perception". ROADMAP menulis "Perception / Emotion", dan saya memilih sisi yang tidak dipakai menu referensi.

**Perbaikan:** urutan dan label disamakan persis, plus test yang membandingkan daftar label dengan urutan referensi — supaya kalau ada yang menyusun ulang menu nanti, yang gagal adalah test, bukan hafalan pengguna.

**Verifikasi:** 22 test komponen lolos.

---

## T-048 · Shell layout & navigasi — 2026-09-09

**FR:** — (fondasi E6)

**Dikerjakan:** Header aplikasi dengan navigasi modul mengikuti `Screenshot_1.png`, plus Vitest sebagai test runner untuk sisa E6.

**File:** `apps/web/lib/nav.ts`, `apps/web/components/shell/{app-header,nav-menu,nav.test}.tsx`, `apps/web/app/{layout,page}.tsx`, `apps/web/app/globals.css`, `apps/web/vitest.config.mts`, `apps/web/vitest.setup.ts`, `Makefile`, `.github/workflows/ci.yml`

**Verifikasi:** 21 test komponen lolos; eslint bersih; `tsc --noEmit` bersih; `next build` sukses. Python tetap 898 lolos, ruff dan mypy bersih.

### Item Fase 2 ditampilkan nonaktif, bukan disembunyikan

Acceptance-nya meminta ini, dan alasannya layak ditulis karena mudah terbaca sebagai kemalasan. Pengguna produk referensi sudah hafal posisi tiap menu. Kalau item yang belum jadi dihilangkan, dua hal terjadi:

1. Mereka menyimpulkan produk ini **tidak bisa** melakukannya, bukan bahwa fiturnya belum tiba.
2. Posisi menu bergeser waktu fiturnya datang, dan hafalan mereka jadi salah.

Ditampilkan nonaktif dengan label "segera hadir" menjawab keduanya, dan sekalian membuat roadmap terlihat tanpa dokumen terpisah. Tiap item nonaktif juga membawa satu baris keterangan yang muncul sebagai `title` — item nonaktif tanpa penjelasan cuma memberi tahu bahwa sesuatu hilang, bukan apa. Ada test yang gagal kalau ada item nonaktif tanpa keterangan.

### Navigasi ditulis sebagai data, bukan JSX

Daftar yang sama nanti dipakai header, menu mobile, dan breadcrumb. Dua salinan JSX akan berbeda perlahan, dan menu yang isinya berbeda antar ukuran layar adalah bug yang cuma terlihat di satu ukuran layar.

Efek sampingnya: `modulAktif` jadi fungsi murni yang bisa diuji tanpa merender apa pun. Yang dijaganya satu hal spesifik — `/` adalah awalan dari **semua** path, jadi tanpa pengecualian, Dashboard akan ikut menyala di setiap halaman. Ada test yang memastikan tepat satu modul aktif pada satu waktu.

### Item nonaktif dirender `<span>`, bukan `<a>` yang dilumpuhkan

Anchor tanpa `href` tetap bisa diaktifkan lewat Enter di sebagian pembaca layar, dan tetap terbaca sebagai tautan. `<span aria-disabled="true">` mengatakan yang sebenarnya.

### Keyboard, karena menu ini dibuka sepanjang hari kerja

- Escape menutup **dan mengembalikan fokus ke tombol pemicunya**. Tanpa itu fokus terbuang ke `body` dan Tab berikutnya melompat ke awal halaman.
- Panah atas/bawah melewati item Fase 2. Berhenti di item yang tidak bisa diapa-apakan membuat navigasi terasa macet.
- Fokusnya berputar di ujung daftar, bukan berhenti.

**Deviasi:**

1. **Vitest ditambahkan, tidak ada di rencana task.** E6 punya sepuluh task UI. Memasang test runner belakangan berarti menulis test untuk sepuluh panel setelah semuanya jadi — dan test yang ditulis setelah fakta cenderung menguji apa yang kodenya lakukan, bukan apa yang seharusnya. Sudah disambungkan ke `make test` dan job `web` di CI.

2. **Test saya sendiri yang salah, bukan kodenya.** Tiga test gagal mencari `getByRole("link")` di dalam menu. Sebabnya benar: `role="menuitem"` **menimpa** role implisit anchor, jadi di dalam `role="menu"` tidak ada elemen ber-role `link`. Query-nya diperbaiki ke `menuitem` lalu disaring berdasarkan `tagName`, dan alasannya ditulis di test supaya tidak diulang di panel berikutnya.

3. **Placeholder identitas pengguna tidak memakai nama karangan.** Auth baru datang di T-064. Nama palsu yang terlihat seperti data nyata akan disangka akun betulan kalau layar ini masuk demo, jadi yang ditampilkan "Belum masuk" berikut nomor task-nya.

4. **Halaman dashboard sengaja kosong, bukan diisi grafik contoh.** Alasan yang sama: data karangan di dashboard monitoring gampang disangka data betulan, dan sekali disangka betulan dia akan dikutip.

5. **Acceptance T-055 dikoreksi dari 34 jadi 38 provinsi** — kekeliruan yang sama yang sudah diperbaiki di T-028. Ditemukan saat membaca task E6 berikutnya, bukan saat mengerjakan T-055.

**Dampak biaya:** n/a.

**Next:** T-049 (filter bar global & refresh interval).

---

## E5 SELESAI · T-047 · Caching & pre-computed rollup — 2026-09-09

**FR:** NFR-01

**Dikerjakan:** Cache hasil dashboard dengan invalidasi berbasis generasi, dan perencana plus perhitungan rollup inkremental berikut penyimpanannya.

**File:** `services/api/sma_api/analytics/{cache,router,filters}.py`, `packages/core/sma_core/rollup/{planner,store}.py`, `tests/api/test_cache.py`, `tests/core/test_rollup.py`

**Verifikasi:** 65 test baru, total 898 lolos; ruff dan mypy bersih (86 file).

### TTL saja melanggar acceptance dengan cara yang tidak kentara

"Simpan lima menit lalu selesai" gagal memenuhi "cache ter-invalidasi saat data baru masuk": post masuk pukul 10:01, dashboard tetap menampilkan angka pukul 10:00 sampai TTL habis. Tidak ada yang salah di layar — angkanya cuma tertinggal, dan monitoring isu justru tempat di mana tertinggal lima menit itu penting.

Yang dipakai **generasi per topic**: kunci cache memuat nomor generasi, dan collector menaikkannya setiap kali batch post baru masuk. Kunci lama otomatis tidak pernah ditanya lagi — tidak perlu memindai atau menghapus kunci, dan tidak ada jendela di mana data lama masih terlayani. TTL tetap ada tapi perannya cuma penyapu supaya kunci generasi lama tidak menumpuk.

Generasinya per topic, bukan global. Di produksi ada 30 sampai 108 topic, dan post baru untuk satu topic tidak boleh membuang cache 107 topic lainnya.

Dinaikkan sekali per batch ingestion, bukan sekali per post — menaikkan per post membuat cache tidak pernah kena selama collector berjalan, dan collector berjalan terus.

### Jebakan yang membuat cache bekerja sempurna sambil tidak berguna

Rentang preset diselesaikan jadi timestamp di server (T-039). Kalau `selesai` diisi `datetime.now()` apa adanya, **tiap request punya rentang yang berbeda beberapa milidetik**, jadi tiap request punya kunci yang berbeda dan hit rate-nya nol. Cache-nya jalan, kodenya benar, dan tidak pernah kena sekali pun.

Batas rentang preset karena itu dibulatkan ke bawah ke kelipatan lima menit — interval refresh terkecil yang dijanjikan FR-402, jadi tidak ada kesegaran yang hilang. Pembulatannya terjadi saat filter dirakit, bukan saat kunci dibuat, supaya rentang yang dikembalikan ke klien adalah rentang yang benar-benar dipakai.

### Yang sengaja tidak dicache

- **Halaman feed yang dalam.** Tiap pengguna menggulir ke kedalaman berbeda, jadi kuncinya hampir tidak pernah dipakai ulang; yang tersisa cuma memori Redis yang terpakai.
- **Hasil yang ada panel gagalnya.** Menyimpannya berarti kegagalan sesaat — satu shard yang sedang pulih — terkunci di cache sampai TTL habis atau ada post baru masuk.

Redis mati tidak menjatuhkan dashboard: setiap operasi cache menelan kegagalannya dan berlanjut sebagai cache miss. Menyajikan halaman lambat jauh lebih baik daripada tidak menyajikan halaman.

### Rollup: tiga hal yang membuat watermark polos salah

CLAUDE.md menyebut "menghitung ulang agregat dari nol" sebagai kesalahan yang baik-baik saja pada 100 ribu post dan bencana pada 10 juta. Perencananya fungsi murni, dan tiga hal yang dijaganya:

1. **Bucket berjalan belum selesai.** Bucket 10:00-11:00 pada pukul 10:30 baru terisi separuh. Memajukan watermark melewatinya membekukan setengah jam itu selamanya. Jadi bucket berjalan selalu dihitung ulang dan watermark tidak pernah melewatinya.
2. **Data telat.** Post bisa masuk dengan `created_at` di masa lalu — backfill, provider tertinggal, reply lama. Bucket yang sudah ditutup bisa bertambah isinya, jadi tiga bucket terakhir selalu dihitung ulang.
3. **Backfill menyisipkan data jauh di belakang.** Lihat-balik tiga jam tidak menolong untuk post tiga bulan lalu, jadi ada `mundurkan_ke()` yang dipanggil backfill (FR-109) dan reindex bobot (T-036). Tanpa itu angka historis tetap salah tanpa ada yang tahu — tidak ada error, dan grafiknya tetap tergambar.

Ditambah batas 500 bucket per jalan: rollup yang tertinggal seminggu tidak boleh mengejar semuanya sekaligus, itu mengunci klaster berjam-jam. Watermark ikut dipotong bersamanya — kalau melompat ke akhir padahal cuma sebagian dihitung, bucket yang dilewati tidak akan pernah dihitung sama sekali.

### Idempotensi penyimpanan bukan pilihan

Jendela lihat-balik **sengaja** menghitung ulang bucket yang sama. Kalau penyimpanannya menambah alih-alih mengganti, jumlah post berlipat tiap kali job berjalan — naik terus tanpa satu pun error, dan baru ketahuan waktu ada yang membandingkannya dengan Exposure. Karena itu bulk memakai `index` dengan `_id` dari kunci baris, bukan `create` dan bukan increment.

Watermark ditulis **setelah** barisnya berhasil ditulis, dan urutan itu tidak boleh dibalik: kalau watermark maju lebih dulu lalu penulisan gagal, bucket itu dianggap selesai padahal isinya tidak pernah tersimpan — dan tidak ada jalan berikutnya yang akan menghitungnya.

### Kunci bucket composite adalah epoch milidetik

Bukan string. Memperlakukannya sebagai detik menggeser semua bucket ke tahun 1970 — tidak ada error, cuma rollup yang tidak pernah cocok dengan post aslinya. Ada test khusus untuk itu.

**Deviasi:**

1. **Kuantisasi rentang preset mengubah perilaku T-039.** `rentang_dari_preset` sekarang membulatkan batasnya. Ini perlu untuk cache, dan efek sampingnya positif: dua panel di halaman yang sama dijamin memakai rentang identik.

2. **Panel belum MEMBACA rollup.** Rollup dihitung dan disimpan, tapi panel masih bertanya ke post mentah. Keputusan kapan panel memakai rollup dan kapan memakai post mentah bergantung pada pengukuran p95 yang sedang terblokir — menebaknya sekarang berarti menambah jalur kode kedua yang mungkin tidak perlu, dan jalur kedua yang bisa menyimpang dari jalur pertama adalah cara baru untuk membuat dua panel tidak cocok. Dicatat sebagai penundaan sadar di TASK.md, bukan sebagai selesai.

3. **`[~]`, bukan `[x]`.** p95 di bawah 2 detik pada 1 juta post butuh klaster berisi data. Dua acceptance lainnya — invalidasi saat data baru masuk, dan rollup inkremental — sudah terverifikasi test.

**Dampak biaya:** tidak langsung, tapi nyata. Cache dan rollup mengurangi beban OpenSearch, dan itu yang menentukan apakah satu VPS OpenSearch cukup atau perlu naik kelas. Anggaran infra $85/bulan di [COST-MODEL.md](docs/COST-MODEL.md) mengasumsikan dashboard tidak memindai post mentah tiap kali halaman dibuka.

**Next:** T-048 (setup Next.js & design system, awal E6).

---

## T-046 · Panel Sentiment feed, cloud, & akun — 2026-09-09

**FR:** FR-503, FR-505, FR-506, FR-507

**Dikerjakan:** Feed sentimen tiga kolom berpaginasi kursor, text/hashtag cloud per polaritas, dan daftar akun per polaritas. Sekalian mengisi jalur eksekusi panel dokumen yang di T-039 baru disediakan tempatnya.

**File:** `services/api/sma_api/analytics/panels/{feed,polaritas,base}.py`, `services/api/sma_api/analytics/query.py`, `tests/api/test_panel_feed.py`

**Verifikasi:** 33 test baru, total 833 lolos; ruff dan mypy bersih (82 file).

### Kursor bukan pilihan gaya API

Tiga alasan, dan yang ketiga yang paling sering terlupa:

1. **`from`/`size` membaca lalu membuang semua yang mendahului offset.** Halaman ke-100 dari feed berukuran 20 berarti OpenSearch mengurutkan 2.000 dokumen untuk mengembalikan 20 terakhirnya. Biayanya naik terus selama pengguna menggulir, dan FR-503 minta infinite scroll.
2. **Ada batas keras.** `index.max_result_window` di template kita 50.000. Feed yang di-scroll melewatinya bukan melambat — dia gagal.
3. **Offset bergeser waktu data baru masuk.** Post baru masuk terus selama pengguna membaca, dan tiap post baru menggeser seluruh feed satu posisi ke bawah. Dengan offset, post yang tadi di posisi 20 muncul lagi di halaman berikutnya. Kursor menunjuk ke posisi dalam urutan, bukan ke nomor urut.

`search_after` butuh urutan yang benar-benar unik, jadi sortnya `created_at desc` **plus `_id` desc**. Tanpa pemecah seri, post dengan timestamp identik bisa terlewat atau muncul dua kali di batas halaman — dan timestamp identik lumrah, karena banyak provider cuma memberi presisi detik. Post yang terlewat tidak menimbulkan error; dia cuma tidak pernah dibaca siapa pun.

**Kursornya per kolom, dikemas jadi satu string.** Satu kursor bersama akan memaksa ketiga kolom maju bersamaan, padahal kolom negatif habis jauh lebih lambat daripada kolom positif — di korpus referensi negatif 82% dari post. Dikemas jadi satu string supaya UI cukup menyimpan satu nilai "posisi feed" dan tidak bisa tanpa sengaja memajukan satu kolom saja.

Kursor berikutnya hanya diberikan kalau halamannya penuh. Halaman yang tidak penuh berarti kolomnya habis, dan memberi kursor untuk itu membuat UI memuat halaman kosong selamanya.

### Panel dokumen dapat jalur eksekusi sendiri

T-039 menyediakan bendera `butuh_dokumen` tapi belum ada yang menjalankannya. Sekarang ada `PanelDokumen` dengan `pencarian()`/`baca_dokumen()`, dan `jalankan_dokumen()` menggabungkan semua pencarian dokumen ke **satu `msearch`** — feed tiga kolom sendirian sudah tiga pencarian.

Pencarian dokumen tetap terpisah dari pencarian agregasi, dan itu disengaja: menggabungkannya berarti sepuluh panel agregasi ikut membayar ongkos mengangkut dokumen yang tidak mereka pakai. Jadi satu halaman penuh = dua perjalanan jaringan, bukan dua belas.

Query global disusun di `query.py`, bukan di panel. Kalau panel yang menyusunnya, satu panel bisa lupa satu klausa dan diam-diam menampilkan post di luar topic yang sedang dipilih — kesalahan yang baru terlihat kalau ada yang membaca post yang tidak dia harapkan. `Pencarian` karena itu memuat `body` tanpa `query`, plus `filter_tambahan` yang digabungkan pemanggil.

msearch melaporkan kegagalan per pencarian, bukan menggagalkan seluruh batch, jadi satu kolom feed yang error tidak mengosongkan dua kolom lainnya.

### Cloud memakai `filters`, bukan `terms` bersarang

Panel-panel polaritas cuma menampilkan positif dan negatif; netral tidak digambar. `terms` sentimen akan menghitung ketiga kelas lalu dua pertiganya dibuang di klien, dan `shard_size` untuk frasa dibayar tiga kali. `filters` dengan dua keranjang bernama membayar tepat yang dipakai.

Netral yang tidak digambar di sini bukan penyembunyian kategori yang dilarang CLAUDE.md — proporsi lengkap termasuk netral dan `unknown` sudah disajikan panel T-045 di halaman yang sama.

**Tiap sisi membawa `jumlah_post`-nya sendiri.** Cloud positif dengan 40 frasa dan cloud negatif dengan 40 frasa terlihat setara padahal yang satu bisa berasal dari 30 post dan yang lain dari 3.000. Tanpa penyebut, perbandingan dua kutub tidak berarti apa-apa.

### Daftar akun diurutkan jumlah post, bukan engagement

Pertanyaan yang dijawab FR-507 adalah "siapa yang paling banyak bicara di sisi ini". Itu yang menandai akun kampanye dan buzzer — dan justru akun seperti itu sering punya engagement rendah per post, jadi mengurutkan berdasarkan engagement akan menyembunyikannya. Engagement tetap ikut supaya kontribusinya bisa dibaca berdampingan.

**Deviasi:** tidak ada.

**Dampak biaya:** n/a.

**Next:** T-047 (caching & pre-computed rollup) — task terakhir E5.

---

## T-045 · Panel Sentiment (timeline, proporsi, by engagement) — 2026-09-09

**FR:** FR-409, FR-501, FR-502, FR-504

**Dikerjakan:** Tiga panel dari satu field `nlp.sentiment` — timeline, proporsi, dan proporsi berbobot engagement.

**File:** `services/api/sma_api/analytics/panels/sentiment.py`, `tests/api/test_panel_sentiment.py`

**Verifikasi:** 28 test baru, total 800 lolos; ruff dan mypy bersih (80 file).

### Post yang belum diklasifikasi adalah kebohongan yang paling rapi di sistem ini

`terms` melewati dokumen tanpa field yang diagregasi. Post yang belum lewat enrich — antrean NLP tertinggal, atau klasifikasinya gagal — tidak punya `nlp.sentiment`, jadi mereka hilang dari ketiga panel ini **sambil tetap terhitung** di Exposure dan Total Posts.

Akibatnya pie chart yang berjumlah 100% dan mewakili, katakanlah, 70% post. Ini lebih berbahaya daripada provinsi `unknown` yang hilang, karena di sini angkanya tetap terlihat rapi dan tidak ada yang janggal: 30 post negatif dari 100 post yang 70-nya belum diklasifikasi akan tampil sebagai **100% negatif**.

Jadi `unknown` adalah kategori yang terlihat, ikut di penyebut, dan muncul di grafik. Kalau porsinya besar, itu bukan noise — itu berarti pipeline NLP tertinggal dan dashboard sedang menampilkan sentimen dari sebagian kecil percakapan.

### Persentase dijamin berjumlah 100 lewat metode sisa terbesar

Acceptance-nya menyebut "persentase totalnya 100%", dan pembulatan biasa per kategori tidak memenuhinya: tiga kategori sama besar memberi 33,3 tiga kali = 99,9. Itu langsung terbaca di legend pie chart.

Yang dipakai: bulatkan ke bawah, lalu bagikan sisa persepuluhnya ke kategori dengan pecahan terbesar, dengan nama kategori sebagai pemecah seri supaya hasilnya deterministik. Tiap kategori paling jauh satu persepuluh dari nilai sebenarnya, dan totalnya selalu tepat 100,0. Diuji pada empat sebaran termasuk kasus ekstrem 999.999 versus 1.

### Definisi kategori dipakai bersama, bukan disalin

`_terms_sentimen()` dipakai ketiga panel. Kalau `missing` dipasang di dua panel dan tertinggal di panel ketiga, penyebut panel itu berbeda dan ketiganya berhenti konsisten — tanpa error apa pun. Test membandingkan fragmen agregasi ketiganya secara langsung.

### FR-504 ada justru karena hasilnya berbeda

Panel berbobot menjawab pertanyaan lain: bukan "berapa banyak post yang negatif" tapi "berapa besar perhatian yang tertuju ke post negatif". Test-nya memakai 3 post negatif viral versus 97 post netral sepi — 3% dari jumlah post, 90% dari engagement. Kalau kedua panel selalu memberi angka yang sama, salah satunya tidak perlu ada.

Panel berbobot ikut mengembalikan jumlah post per kategori, karena selisih antara kedua angka itulah informasinya.

**Deviasi:** tidak ada.

**Dampak biaya:** n/a.

**Next:** T-046 (Sentiment feed, cloud, & akun).

---

## T-044 · Panel Topic Location — 2026-09-09

**FR:** FR-408

**Dikerjakan:** Sebaran post per provinsi untuk peta Indonesia, memakai `location_province` hasil resolusi T-028.

**File:** `services/api/sma_api/analytics/panels/lokasi.py`, `tests/api/test_panel_lokasi.py`

**Verifikasi:** 14 test baru, total 772 lolos; ruff dan mypy bersih (79 file).

### Panel yang paling gampang berbohong

Sebagian besar post **tidak** punya lokasi yang bisa di-resolve: pengguna mengisi lokasi profil dengan apa saja, atau mengosongkannya. Kalau yang tidak ter-resolve diam-diam dibuang, petanya terlihat mewakili seluruh percakapan padahal mungkin cuma mewakili 15%-nya — dan tidak ada apa pun di layar yang memberi tahu.

Jadi `unknown` tidak masuk daftar provinsi (dia bukan provinsi dan tidak bisa digambar) tapi dilaporkan sebagai angkanya sendiri, ikut dihitung di total, dan persentasenya disediakan langsung. Analis yang melihat "unknown 85%" tahu petanya harus dibaca hati-hati.

Persentasenya dihitung di server, bukan diserahkan ke klien, supaya tidak ada dua klien yang membaginya dengan pembagi berbeda.

### Provinsi bernilai nol tetap dikembalikan

Provinsi yang tidak muncul di respons tidak bisa dibedakan dari provinsi yang nol, dan keduanya berbeda arti di peta: "tidak ada post dari sana" versus "kami tidak tahu". Ke-38 provinsi selalu ada, diisi nol kalau perlu.

Urutannya menurun dengan nama sebagai pemecah seri. Provinsi bernilai nol jumlahnya banyak, dan tanpa urutan kedua posisinya berubah tiap request sehingga legend peta ikut berkedip.

### Nilai asing tidak dibuang

Kalau agregasi mengembalikan nilai yang bukan salah satu dari 38 provinsi, itu berarti gazetteer T-028 dan data di index tidak sinkron. Nilainya tetap dikembalikan, bukan disaring — membuangnya membuat total tidak cocok tanpa petunjuk apa pun tentang penyebabnya.

**Deviasi:** tidak ada.

**Dampak biaya:** n/a.

**Next:** T-045 (panel Sentiment: timeline, proporsi, by engagement).

---

## T-043 · Panel Total Posts & Replies — 2026-09-09

**FR:** FR-407

**Dikerjakan:** Jumlah post dipisah per platform dan per tipe, lewat `terms` platform bertingkat `terms` post_type.

**File:** `services/api/sma_api/analytics/panels/totals.py`, `tests/api/test_panel_totals.py`

**Verifikasi:** 13 test baru, total 758 lolos; ruff dan mypy bersih (78 file).

### `missing: "unknown"` adalah keseluruhan isi task ini

`terms` diam-diam melewati dokumen yang tidak punya field yang diagregasi. Post tanpa `post_type` — data lama, atau platform yang tidak membedakan post dan reply — akan hilang dari rincian per tipe tapi **tetap terhitung** di total platform.

Hasilnya rincian yang tidak menjumlah ke totalnya: `post` 10 + `reply` 4 di panel yang totalnya 17. Tidak ada error, tidak ada kategori mencurigakan, cuma tiga post yang menguap. Itu persis kesalahan yang dilarang CLAUDE.md — menyembunyikan kategori `unknown` membuat grafik lebih rapi dan membuat datanya bohong.

Jadi keduanya (`platform` dan `post_type`) diberi `missing: "unknown"`, dan kalau jumlah `unknown`-nya besar, itu memang temuan yang perlu dilihat.

### `size` di sini bukan "berapa yang ditampilkan"

Panel top-N memakai `limit` dari `OpsiPanel`; panel ini tidak. `size`-nya adalah "berapa platform yang mungkin ada", dan memotongnya akan membuang satu platform dari hitungan sehingga total panel ini tidak lagi cocok dengan Exposure — yang justru acceptance-nya. Ada test yang memastikan `limit=1` tidak mempengaruhi panel ini.

### Tipe yang tidak ada tidak dipaksa jadi nol

Berbeda dengan Exposure, yang mengisi platform absen dengan 0 supaya lapisan grafiknya tidak putus. Di sini daftar tipe memang berbeda per platform — Threads sering cuma punya post — dan memaksa `reply: 0` akan menyiratkan platform itu punya konsep reply yang kebetulan kosong.

**Deviasi:** tidak ada.

**Dampak biaya:** n/a.

**Next:** T-044 (Topic location).

---

## T-042 · Panel Engagements History — 2026-09-09

**FR:** FR-405

**Dikerjakan:** Total engagement per bucket waktu, memakai konfigurasi histogram yang sama persis dengan Exposure.

**File:** `services/api/sma_api/analytics/panels/{engagements,waktu,exposure}.py`, `tests/api/test_panel_engagements.py`

**Verifikasi:** 15 test baru, total 745 lolos; ruff dan mypy bersih (77 file).

### Konsistensi dijadikan struktural, bukan kebetulan

Acceptance-nya "konsisten dengan Exposure pada rentang yang sama". Cara yang gampang adalah menyalin konfigurasi `date_histogram` ke panel ini dan mengandalkan keduanya tetap sama. Cara itu gagal perlahan: satu panel diberi `time_zone`, satu tertinggal, dan hasilnya dua grafik bersebelahan dengan batas bucket berbeda yang tidak bisa dibandingkan — tanpa satu pun error muncul.

Jadi konfigurasinya pindah ke `panels/waktu.py` dan dipakai kedua panel. Test-nya membandingkan `date_histogram` keduanya pada empat panjang rentang, jadi kalau nanti ada yang menyisipkan opsi ke salah satunya, test itu yang gagal lebih dulu.

Panel ini juga mengembalikan `jumlah_post` per bucket, bukan cuma engagement. Itu yang membuat konsistensinya bisa **dicek dari respons** alih-alih dipercaya: kalau suatu saat tidak cocok dengan Exposure, selisihnya terlihat sebagai angka, bukan sebagai grafik yang terasa aneh.

### Bucket kosong bernilai nol, bukan null

`sum` mengembalikan `null` untuk bucket tanpa dokumen. Membiarkannya null akan memutus garis grafik di tengah. Ini nol yang sah dengan alasan yang sama seperti di Exposure: bucket-nya ada, isinya dihitung seluruhnya, dan hasilnya memang nol.

**Deviasi:** tidak ada.

**Dampak biaya:** n/a.

**Next:** T-043 (Total posts & replies).

---

## T-041 · Panel Issues & Issue Engagement — 2026-09-09

**FR:** FR-404, FR-406

**Dikerjakan:** Dua panel dari satu field `nlp.issues` — satu diurutkan frekuensi, satu diurutkan total engagement. Kontrak `Panel` diperluas dengan `OpsiPanel` supaya jumlah item bisa dikonfigurasi.

**File:** `services/api/sma_api/analytics/panels/issues.py`, `services/api/sma_api/analytics/{filters,query,router}.py`, `panels/base.py`, `tests/api/test_panel_issues.py`

**Verifikasi:** 20 test baru, total 730 lolos; ruff dan mypy bersih (75 file).

### Dua panel, bukan satu dengan sakelar

Keduanya menjawab pertanyaan berbeda: Issues menjawab apa yang paling **sering** dibicarakan, Issue Engagement menjawab apa yang paling banyak **direaksi**. Justru selisihnya yang berguna — isu yang sering disebut tapi sepi engagement adalah keluhan rutin, sedangkan isu yang jarang disebut tapi viral adalah sesuatu yang sedang meledak.

Dashboard menampilkan keduanya berdampingan, jadi keduanya harus bisa diminta bersamaan dalam satu request. Panel terpisah yang membuat itu mungkin; satu panel dengan parameter mode akan memaksa dua request untuk satu halaman, persis yang dihindari FR-401.

### Ketidakpastian terms agg tidak disembunyikan

`terms` mengambil top-N per shard lalu menggabungkannya, jadi frasa yang peringkat 21 di setiap shard bisa hilang meski totalnya masuk sepuluh besar. Post disimpan satu index per bulan, jadi rentang tiga bulan berarti tiga shard dan tiga kali kesempatan salah. Untuk Issue Engagement perkiraannya berlapis: urutan berbasis sub-agregasi tidak punya jaminan akurasi sama sekali.

Mitigasinya `shard_size` lima kali `size` dengan lantai 100. Yang juga dilakukan: `doc_count_error_upper_bound` dan `sum_other_doc_count` ikut dikembalikan kalau bukan nol. Ini semangat yang sama dengan aturan "jangan sembunyikan kategori unknown" di CLAUDE.md — word cloud 20 frasa dari korpus 5.000 frasa yang tidak menyebutkan sisanya terlihat seperti seluruh isinya.

### Data uji dibangun supaya kesalahan T-034 tidak terulang

Acceptance-nya "dua mode mengembalikan hasil yang jelas berbeda", dan itu yang paling mudah diuji secara palsu. Di T-034 percobaan pertama memakai frasa langka yang juga viral, dan frasa itu menang di kedua panel — kelangkaannya sendiri sudah cukup memenangkan TF-IDF, jadi kontribusi bobot engagement tidak teruji sama sekali.

Data di sini memakai "harga beras naik" (sering, sepi reaksi) versus "pungli parkir bandara" (lebih jarang, viral), dan test-nya menegaskan pemenang keduanya memang berbeda.

**Deviasi:**

1. **Kontrak `Panel` diperluas: `agregasi(f)` jadi `agregasi(f, o)`.** Acceptance menuntut jumlah item bisa dikonfigurasi, dan itu opsi per-panel yang tidak muat di `FilterDashboard`. Menaruhnya di filter juga salah secara konsep: filter menentukan post MANA yang dihitung, opsi menentukan berapa banyak hasil yang ditampilkan — dan menggabungkannya langsung jadi masalah begitu hasilnya di-cache di T-047, karena dua `limit` berbeda akan terlihat seperti dua filter berbeda.

   Dikerjakan sekarang selagi baru satu panel yang ada. Menundanya berarti mengubah tujuh panel sekaligus nanti.

2. **`limit` divalidasi di `Query`, bukan cuma di Pydantic.** Kalau hanya di model, `limit=99999` melewati endpoint dan baru gagal di lapisan yang pesan error-nya kurang menunjuk.

**Dampak biaya:** n/a.

**Next:** T-042 (Engagements history).

---

## T-040 · Panel Exposure timeline — 2026-09-09

**FR:** FR-403

**Dikerjakan:** Panel Exposure sebagai `date_histogram` bertingkat `terms` platform, didaftarkan ke registry T-039. `panels.py` dijadikan package supaya panel T-041 s/d T-046 punya tempat.

**File:** `services/api/sma_api/analytics/panels/{__init__,base,exposure}.py`, `services/api/sma_api/analytics/filters.py`, `tests/api/test_panel_exposure.py`

**Verifikasi:** 17 test baru, total 710 lolos; ruff dan mypy bersih (74 file).

### Bucket kosong adalah keseluruhan masalah panel ini

`date_histogram` secara default melewati periode tanpa post. Pada area chart bertumpuk, bucket yang hilang **tidak** digambar sebagai lembah — dia hilang dari sumbu, dan garisnya menyambung langsung dari kiri ke kanan. Jeda tiga hari tanpa post jadi terlihat persis seperti volume yang stabil.

Tidak ada error, tidak ada bucket kosong yang mencurigakan di respons, cuma grafik yang salah. Karena itu `min_doc_count: 0` plus `extended_bounds` sepanjang rentang filter, dan platform yang absen di satu bucket diisi `0` di pembacaan.

Pengisian nol itu **pengecualian yang disengaja** dari aturan `null` versus `0` di CLAUDE.md. Aturan itu tentang metrik platform yang tidak tersedia — TikTok punya view, Twitter tidak. Di sini bucket-nya ada, isinya sudah dihitung seluruhnya, dan hasilnya nol. Itu nol yang nyata.

### Legend dihitung dari seluruh rentang, bukan per bucket

Kalau daftar platform diambil per bucket, platform yang sepi akan muncul dan hilang dari legend saat pengguna menggeser rentang atau mengganti ukuran bucket. Daftarnya sekarang dikumpulkan dari semua bucket lebih dulu, baru dipakai mengisi tiap titik.

**Deviasi:**

1. **Ukuran bucket diubah dari interval tetap ke interval kalender, dan ini mengubah keluaran T-039.** `ukuran_bucket` sebelumnya mengembalikan `1h`/`1d`/`1w`; sekarang `hour`/`day`/`week`.

   Sebabnya zona waktu. Semua pengguna Fase 1 ada di Indonesia dan membaca dashboard dalam WIB, tapi interval **tetap** membagi waktu dari epoch UTC dan mengabaikan `time_zone`. Akibatnya "hari" berjalan 07:00–07:00 WIB: lonjakan pukul 03:00 WIB masuk ke hari sebelumnya, dan analis yang mencocokkan lonjakan dengan peristiwa nyata akan salah satu hari. Interval kalender menghormati `time_zone`, jadi `FilterDashboard` sekarang punya field `zona` dengan default `Asia/Jakarta`.

   Ini bukan sesuatu yang muncul di acceptance criteria mana pun — dia muncul waktu menulis agregasinya dan bertanya bucket "hari" itu hari siapa.

2. **`panels.py` jadi package `panels/`.** Satu modul berisi registry plus tujuh panel akan jadi file seribu baris. Registry pindah ke `panels/base.py`; `panels/__init__.py` mengimpor tiap modul panel untuk memicu registrasinya, karena registry diisi lewat efek samping dekorator dan modul yang belum pernah di-import tidak ada isinya di mata Python.

**Dampak biaya:** n/a.

**Next:** T-041 (panel Issues & Issue engagement).

---

## T-039 · Query layer & filter global — 2026-09-09

**FR:** FR-401

**Dikerjakan:** Lapisan analytics di `services/api/sma_api/analytics/`: filter global tervalidasi, registry panel, eksekutor pencarian, dan endpoint `/api/v1/analytics/dashboard`.

**File:** `services/api/sma_api/analytics/{filters,panels,query,router}.py`, `services/api/sma_api/main.py`, `tests/api/test_analytics_query.py`

**Verifikasi:** ruff bersih, mypy bersih (72 file), pytest 693 lolos (43 test baru).

### Panel adalah agregasi, bukan endpoint

FR-401 berbunyi "ganti filter maka semua panel update dari satu kali fetch, bukan satu request per panel". Itu keputusan arsitektur, bukan optimasi yang bisa ditunda sampai nanti — tujuh panel berarti tujuh kali pekerjaan yang sama (mencari post yang cocok topic, rentang, dan platform), dan cuma bagian agregasinya yang berbeda.

Jadi panel didaftarkan sebagai **potongan agregasi bernama**, lalu digabung ke satu `_search`:

```
GET /analytics/dashboard?panels=exposure,sentiment,location
  -> satu _search, size=0, tiga agregasi bernama
```

T-040 sampai T-046 tinggal mendaftarkan panelnya; tidak ada endpoint baru yang perlu dibuat, dan jumlah panggilan ke OpenSearch tetap satu berapa pun jumlah panelnya.

Panel yang mengambil dokumen (feed sentimen, T-046) ditandai `butuh_dokumen` dan dikeluarkan dari pencarian agregasi. Menggabungkannya berarti enam panel lain ikut membayar ongkos mengangkut dokumen yang tidak mereka pakai.

### Rentang waktu memilih index, bukan cuma memfilter

Post disimpan satu index per bulan. Mencari lewat alias `posts` menyentuh **semua** bulan yang pernah ada lalu membuang sebagian besarnya lewat filter tanggal. `indeks_untuk()` menyusun daftar index dari rentangnya, jadi rentang satu hari cuma menyentuh `posts-2026-09*`.

Pada korpus 12 bulan selisihnya sekitar dua belas kali lipat kerja shard — perbedaan antara memenuhi NFR-01 dan tidak. Polanya memakai wildcard, bukan nama persis, karena OpenSearch menolak nama index yang tidak ada tapi menerima pola yang tidak cocok apa pun; bulan tanpa post memang belum punya index.

### Kenapa injeksi tidak mungkin

Tidak ada nilai dari pengguna yang pernah masuk ke query sebagai sintaks. Semua field difilter lewat `term`/`terms`/`range` dengan nilai yang sudah divalidasi Pydantic jadi UUID, enum, atau datetime; yang tersisa cuma query boolean topic, dan itu sudah dikompilasi jadi `bool` DSL dari AST di T-024. Test-nya mengirim `'*" OR platform:*'` sebagai nama provinsi dan memastikan dia tetap muncul sebagai **nilai** di klausa `terms`.

Semua klausa masuk ke `filter`, bukan `must`: tidak ada kriteria filter global yang butuh skor relevansi, dan klausa `filter` bisa dipakai ulang dari cache antar panel dan antar request.

### Kegagalan yang tidak boleh menular

Satu panel yang bentuk agregasinya berubah tidak boleh mengosongkan enam panel lain di halaman yang sama, jadi `baca()` tiap panel dibungkus dan kegagalannya masuk ke `gagal` di respons — dilaporkan, bukan didiamkan. Panel kosong yang diam terlihat persis seperti "tidak ada data", dan di dashboard monitoring itu kesalahan yang mahal.

Alasan yang sama membuat panel salah ketik ditolak 422 dengan menyebut nama yang tersedia, bukan dilewati diam-diam.

**Deviasi:**

1. **Bug ditemukan test: respons 422 berubah jadi 500.** `ValidationError.errors()` menyertakan field `input` berisi objek asli — UUID dan datetime — dan FastAPI gagal men-serialisasinya. Akibatnya rentang terbalik ditolak sebagai "kesalahan server" dan klien tidak diberi tahu field mana yang salah. Detail error sekarang diringkas jadi `loc`/`msg`/`type`; sekalian tidak memantulkan balik nilai mentah pengguna.

2. **`track_total_hits` dimatikan.** Jumlah total dibaca dari agregasi panel, bukan dari `hits.total`. Membiarkannya menyala berarti membayar penghitungan yang tidak ada pembacanya.

3. **Default rentang satu hari, bukan "semua waktu".** Rentang penuh pada korpus jutaan post adalah cara termahal untuk membuka halaman.

4. **`[~]`, bukan `[x]`.** p95 di bawah 2 detik pada 1 juta post tidak bisa diverifikasi tanpa klaster berisi data. Yang sudah dipasang: query yang melewati 2 detik dicatat sebagai warning berikut rentang dan index yang disentuh, supaya pelanggaran NFR-01 terlihat dari log dan bukan dari keluhan pengguna.

**Dampak biaya:** n/a — hanya membaca dari OpenSearch, tidak ada panggilan provider.

**Next:** T-040 (panel Exposure timeline).

---

## E4 SELESAI · T-029 s/d T-038 — 2026-09-09

**FR:** FR-301 s/d FR-307, FR-405, FR-504

**Dikerjakan:** Pipeline NLP lengkap — preprocessing Bahasa Indonesia, kontrak provider dan pemilihannya lewat config, klasifier sentimen via Claude Haiku, label store sebagai korpus training Fase 4, routing low-confidence, ekstraksi isu, ekstraksi hashtag/mention/entity, bobot engagement yang bisa dikonfigurasi, jalur Batch API untuk backfill, dan harness evaluasi macro-F1.

**File:** `services/worker/sma_worker/nlp/{preprocess,provider,factory,claude,labels,issues,entities,batch,evaluate}.py`, `packages/schema/sma_schema/post.py`, `packages/core/sma_core/config.py`, `tests/worker/test_nlp_{preprocess,pipeline,entities,eval}.py`

**Verifikasi:**

```
python -m ruff check .          All checks passed!
python -m mypy packages services  Success: no issues found in 67 source files
python -m pytest tests            650 passed in 12,85s
```

124 test baru untuk E4 (526 → 650).

---

### T-029 — satu teks, dua keluaran, dan alasannya bukan kerapian

`preprocess()` menghasilkan **dua** hasil yang berbeda dari satu post:

```
teks_sentimen   slang dinormalisasi, noise dibuang, TIDAK di-stem
token_isu       di-stem, stopword dibuang
```

Godaannya adalah membuat satu saja. Stemming dan penghapusan stopword sangat menolong word cloud — "penanganan" dan "menangani" jadi satu entri, jadi isu tidak terpecah jadi dua. Tapi keduanya menghancurkan sentimen:

```
"tidak bagus"  --stopword-->  "bagus"
```

Sentimennya persis berbalik, dan **tidak ada error yang muncul**. Post-nya tetap terklasifikasi, angkanya tetap masuk dashboard, cuma nilainya salah. Karena itu daftar stopword sengaja tidak memuat kata negasi, jalur sentimen tidak melewati stopword sama sekali, dan ada test berparameter khusus untuk empat bentuk negasi (`tidak`, `gk`, `bukan`, `belum`) yang gagal kalau salah satunya hilang.

Stemming juga merusak frasa: "penanganan bencana" jadi "tangan bencana", dan model sentimen membaca kalimat yang bukan bahasa manusia.

`DetectorFactory.seed = 0` dipatok. langdetect memakai sampling acak secara default — tanpa seed, post yang sama bisa terdeteksi `id` pada satu run dan `unknown` pada run berikutnya, artinya dia masuk topic hari ini dan hilang besok tanpa ada yang berubah.

---

### T-030 — provider dipilih dari config, bukan di-import langsung

Registry saja belum cukup untuk memenuhi acceptance "ganti provider hanya lewat config": tanpa satu titik pemilihan, nama provider akan tersebar sebagai import langsung di seluruh pipeline enrich, dan switchover Fase 4 berubah dari satu baris `.env` jadi pencarian ke semua pemanggil. Jadi ditambah `nlp/factory.py` (`buat_provider`) dan setting `SMA_NLP_PROVIDER`.

`buat_provider()` tetap menerima nama eksplisit — bukan untuk kenyamanan test, tapi karena jalur audit Fase 4 memang menjalankan dua provider berdampingan pada teks yang sama untuk membandingkan hasilnya.

Biaya per juta token adalah atribut kelas dan **default-nya nol**, supaya model self-host tidak perlu berpura-pura punya harga. Di sana sumber daya langkanya CPU, bukan uang.

---

### T-031 — tiga keputusan biaya, dan satu peringatan yang menjaganya

Batching 25 post per panggilan, prompt caching pada system prompt, dan format output ringkas (`{"i":1,"s":"neg","c":0.92}`). Yang ketiga bernilai lima kali lipat dibanding keringkasan input: output $5/MTok versus input $1/MTok.

Yang tidak terduga: **cache miss tidak punya gejala selain tagihan.** Sistemnya tetap jalan, hasilnya tetap benar, biayanya naik ~10x untuk bagian system prompt. Jadi `classify_batch` mencatat `cache_read_input_tokens` dan memunculkan warning kalau nol. Ini satu-satunya cara kesalahan itu terlihat sebelum akhir bulan.

Pemetaan hasil memakai indeks eksplisit (`[0]`, `[1]` di prompt; `"i"` di respons), bukan urutan. Model bisa melewatkan atau menukar item, dan memetakan berdasarkan posisi respons akan menempelkan sentimen ke post yang salah — tanpa error apa pun. `parse_respons` toleran terhadap teks pembungkus: menggagalkan seluruh batch karena model menambah satu kalimat penjelasan berarti membuang 25 klasifikasi yang sudah dibayar.

Post yang tidak dikembalikan model dilaporkan sebagai gagal, bukan didiamkan. Kalau didiamkan, post itu tidak akan pernah punya sentimen dan hilang dari semua panel tanpa jejak.

---

### T-032 — teks disalin ke `nlp_labels`, bukan dirujuk

Redundansi yang disengaja. Post kena retensi 12 bulan (FR-208); label harus hidup lebih lama karena dia korpus training Fase 4, dan label tanpa teks tidak berguna untuk training.

Aturannya tidak bisa ditawar karena satu sifat: **data training tidak bisa dibuat surut.** Inference yang tidak tercatat hilang selamanya. Kalau pencatatan baru dipasang tiga bulan setelah produksi jalan, tiga bulan pertama harus dilabeli ulang dari nol — biayanya sama dengan menjalankan ulang seluruh klasifikasi.

---

### T-033 — low-confidence ditandai, bukan dibuang

Membuang hasil low-confidence membuat post itu hilang dari semua panel sentimen. Post yang ambigu sering justru post yang menarik — sarkasme, kritik terselubung, campur kode. Jadi hasilnya tetap dipakai dan ditandai untuk antrean review.

Label hasil review manusia adalah data training paling berharga: dia mengoreksi justru pada kasus yang paling sulit bagi model.

`pilah_confidence` sekarang mengambil ambang dari config kalau tidak diberi eksplisit (`SMA_NLP_CONFIDENCE_THRESHOLD`), memenuhi acceptance "ambang bisa dikonfigurasi" — sebelumnya ambang hanya bisa diubah dengan mengedit tiap pemanggil.

Ada warning kalau rasio review melewati 30%. Itu bukan kondisi normal; biasanya berarti topic baru memuat kosakata yang belum dikenal, atau prompt berubah dan kalibrasinya bergeser.

---

### T-034 — test-nya sempat tidak membuktikan apa pun

Panel Issues (TF-IDF) dan Issue Engagement (TF-IDF berbobot engagement) harus terlihat berbeda — itu inti FR-406. Percobaan pertama memakai frasa langka yang juga viral, dan frasa itu menang di **kedua** panel: kelangkaannya sendiri sudah cukup untuk memenangkan TF-IDF, jadi kontribusi bobot engagement tidak teruji sama sekali. Test-nya hijau dan tidak membuktikan apa-apa.

Data test dibangun ulang: frasa yang sering muncul tapi sepi engagement versus frasa yang lebih jarang tapi viral. Sekarang peringkat keduanya memang berbeda, dan test-nya gagal kalau bobot engagement dilepas.

---

### T-035 — NER berbasis aturan, dan tiga salah tebak yang membentuknya

Tidak ada model NER Bahasa Indonesia siap pakai yang bagus untuk teks media sosial, dan menjalankan transformer per post menambah beban CPU di jalur panas. Yang dipakai: gazetteer (38 provinsi + ~250 alias dari T-028) plus pola yang memanfaatkan sifat bahasanya — organisasi hampir selalu berakronim atau berawalan kata jenis ("Kementerian", "Dinas", "PT"), orang hampir selalu didahului gelar.

**Presisi diutamakan di atas recall**, karena entitas palsu muncul di layar sebagai fakta dan membuat analis menelusuri sesuatu yang tidak ada, sedangkan entitas yang terlewat cuma membuat panelnya lebih pendek. Konsekuensinya: nama tanpa gelar tidak ditebak sama sekali. "Prabowo menang" tidak menghasilkan entitas orang — nama Indonesia tidak punya penanda ortografis yang membedakannya dari kata berkapital lain, jadi menebak berarti memungut tiap kata berkapital di tengah kalimat.

Tiga aturan lahir dari salah tebak yang benar-benar muncul saat diuji pada contoh nyata, bukan dari kekhawatiran teoretis:

| Salah tebak | Sebab | Aturan yang lahir |
|---|---|---|
| "Gubernur Jawa Barat Dedi Mulyadi" → orang bernama **"Jawa Barat Dedi"**; "Menteri Sosial" → orang bernama **"Sosial"** | Gelar jabatan sering diikuti wilayah atau portofolio sebelum namanya | Gelar dipisah dua: sapaan (Pak, Bu, Prof) langsung diikuti nama; jabatan (Menteri, Gubernur) melewati wilayah dulu dan butuh minimal dua kata berkapital |
| "PT Kereta Api Indonesia" → organisasi kedua bernama **"PT"**; "Polda Metro Jaya" → lokasi **"Metro"** (kota di Lampung) | Entitas bersarang di entitas lain | Yang terpanjang menang |
| "BANJIR LAGI DI JAKARTA PEMERINTAH KEMANA" → empat "organisasi" | Kapitalisasi adalah sinyal utama, dan pada teks yang diteriakkan sinyal itu tidak ada | Aturan akronim dimatikan kalau ≥70% hurufnya kapital; gazetteer lokasi tetap jalan karena tidak bergantung kapitalisasi |

Pengecualian untuk aturan kedua ditambahkan setelah pengukuran: **wilayah di ekor nama organisasi tetap dikeluarkan sebagai lokasi.** "Dinas Pendidikan DKI Jakarta" memang organisasi utuh, tapi wilayahnya juga informasi nyata, dan membuangnya berarti post itu kehilangan satu-satunya petunjuk lokasi yang dia punya. Posisi yang membedakannya dari "Metro" tadi: wilayah di ekor nama organisasi hampir selalu wilayah sungguhan, yang di tengah biasanya kebetulan.

Hashtag dan mention **tidak** diimplementasikan ulang di sini — modul ini memakai `normalize/base.py` yang sudah menggabungkan hasil dari teks dengan field terpisah kiriman provider. Dua implementasi ekstraksi hashtag akan berbeda perlahan, dan panel hashtag akan tidak cocok dengan filter hashtag tanpa ada yang menyadarinya.

**Presisi terukur: 1,00; recall 0,86.** Angka ini dari sampel kedua yang ditulis setelah aturannya selesai dan sengaja tidak dipakai menyetel apa pun. Sampel pertama (15 post) dipakai selama pengembangan dan skornya sempurna — itu penjaga regresi, bukan bukti generalisasi, dan test-nya menyebut itu apa adanya.

Yang terlewat di sampel uji: "Kemenkeu" dan "Baznas" — nama lembaga bercampur huruf kecil yang bukan akronim kapital dan tidak berawalan kata jenis. Batas yang diketahui, ditulis sebagai test supaya terbaca sebagai keputusan dan bukan ditemukan lagi dari nol nanti. Menutupnya butuh gazetteer nama lembaga, dan daftar itu paling baik diisi dari data produksi.

---

### T-036 — bobot engagement bisa dikonfigurasi, dengan satu jebakan

Formula dipindah dari properti tertanam jadi fungsi `hitung_engagement(metrics, bobot=..., pembagi_view=...)` dengan `BOBOT_ENGAGEMENT` sebagai default. Metrik `None` tetap `None` — post tanpa data view **tidak** dihitung sebagai nol view, karena menyamakan keduanya membuat rata-rata salah tanpa ada yang menyadari.

**Jebakan yang perlu diingat:** `engagement_total` adalah `computed_field` yang ikut ter-index ke OpenSearch. Mengubah bobot **tidak** mengubah dokumen yang sudah tersimpan — perlu reindex, kalau tidak dashboard akan menampilkan campuran dua formula tanpa penanda apa pun.

---

### T-037 — batch dipakai untuk backfill, tidak pernah untuk realtime

Message Batches API memberi diskon 50% dengan turnaround sampai 24 jam. FR-402 menjanjikan data segar dalam 5 menit, jadi pembagiannya tegas: realtime pakai tarif penuh, backfill dan historis pakai jalur batch. Backfill adalah kasus yang tepat karena memang tidak punya tenggat — post lama sudah lewat, tidak ada yang menunggu sentimennya muncul dalam hitungan menit.

Dua hal yang harus dijaga identik dengan jalur realtime, dan keduanya punya test:

- **System prompt.** Kalau berbeda, label dari kedua jalur punya bias berbeda, dan korpus training T-032 jadi campuran dua distribusi tanpa penanda apa pun.
- **Ukuran batch** (25), dengan alasan yang sama.

`custom_id` membawa rentang indeks aslinya. Hasil batch datang sampai 24 jam kemudian dan **tidak berurutan**; tanpa peta indeks, satu-satunya cara mencocokkan hasil ke post adalah menebak dari urutan.

---

### T-038 — macro-F1, bukan akurasi, dan alasannya ada di korpusnya sendiri

Korpus referensi 82% negatif. Klasifier yang selalu menjawab "negatif" mendapat **akurasi 82%** sambil tidak pernah menemukan satu pun post positif. Itu angka yang terlihat bagus di laporan dan produk yang tidak berguna. Test-nya membuktikan tepat itu: akurasi 0,82, macro-F1 di bawah 0,35.

Harness memberi macro-F1, confusion matrix, dan breakdown per platform. Yang terakhir bukan hiasan — akurasi bisa sangat berbeda antar platform karena TikTok jauh lebih banyak bahasa gaul daripada YouTube, dan rata-rata tunggal menyembunyikan itu.

Pemuat gold set menyebutkan **nomor baris** pada baris yang rusak: gold set dilabeli manusia dan diedit tangan, jadi pesan error harus menunjuk baris mana yang perlu diperbaiki. Kalau berkasnya belum ada, pesannya mengatakan bahwa ini pekerjaan manusia — bukan sekadar "file not found".

---

**Deviasi:**

1. **T-035 sempat terlewat.** E4 dikerjakan T-029 → T-034 lalu langsung ke T-036, dan T-035 baru ketahuan belum ada saat memeriksa acceptance sebelum mencentang. Bagian hashtag/mention-nya memang sudah dipenuhi normalizer di E2, dan itu yang membuatnya tidak terasa hilang — tapi NER-nya belum ada sama sekali. Dikerjakan sekarang, sebelum E4 ditutup.

2. **Dua acceptance T-030 dan T-033 belum terpenuhi saat kodenya "selesai".** "Ganti provider hanya lewat config" dan "ambang bisa dikonfigurasi" keduanya butuh pembacaan config yang belum ada — registry dan parameter fungsi saja tidak cukup. Ditambahkan `nlp/factory.py` dan setting `SMA_NLP_PROVIDER`. Ini alasan acceptance criteria dibaca ulang satu per satu sebelum mencentang, bukan diingat-ingat.

3. **T-029, T-031, T-032, T-033, T-037, T-038 berhenti di `[~]`.** Sebabnya tiga jenis dan tercatat di tabel blocker TASK.md: butuh Postgres sungguhan (T-032), butuh panggilan API berbayar untuk mengukur throughput dan biaya nyata (T-031, T-037), atau butuh gold set 1.000 post berlabel manusia (T-029 untuk akurasi deteksi bahasa, T-033 untuk kalibrasi confidence, T-038 untuk baseline).

4. **Sampel presisi pertama untuk T-035 skornya sempurna, dan itu masalah.** Sampel yang dipakai selama menyetel aturan pasti dilewati aturan itu — ambang 0,85 di atasnya jadi tidak bisa gagal. Ditambah sampel kedua yang ditulis setelah aturannya beku dan tidak dipakai menyetel apa pun; angka yang dilaporkan di atas berasal dari sana.

**Dampak biaya:** NLP ~$0,20 per 1.000 post realtime (batching 25 + prompt caching + output ringkas), ~$0,10 lewat Batch API. Sesuai [COST-MODEL.md bagian 6](docs/COST-MODEL.md) — **lebih murah daripada menarik datanya** untuk semua platform selain X. Semua inference tertulis ke `nlp_labels`, yang menjadikannya juga investasi ke Fase 4: setelah ~100 ribu contoh terkumpul, fine-tune IndoBERT menurunkan komponen NLP dari ~$80 jadi ~$12 per bulan.

**Next:** T-039 (query layer & filter global, awal E5).

---

## E3 SELESAI · T-026, T-027, T-028 — 2026-09-09

**FR:** FR-109, FR-207, FR-208

**Dikerjakan:** Backfill topic baru, kebijakan retensi, dan resolusi lokasi ke provinsi.

**File:** `packages/core/sma_core/search/{backfill,retention}.py`, `packages/core/sma_core/geo/provinsi.py`, `tests/core/{test_backfill_retention,test_geo}.py`

**Verifikasi:** 60 test baru, total 526 lolos, ruff dan mypy bersih (57 file).

### T-026 — backfill memakai `update_by_query`, bukan percolate

Percolate menjawab "query mana yang cocok dokumen ini" — tepat untuk post baru yang masuk, karena ada **banyak query, satu dokumen**. Backfill kebalikannya: **satu query, banyak dokumen**. Itu pencarian biasa, dan `update_by_query` mengerjakan pencarian plus pembaruannya dalam satu panggilan tanpa memindahkan dokumen keluar dari klaster.

**Nol panggilan provider** terpenuhi karena post historis sudah ada di OpenSearch — termasuk yang dulu tidak cocok topic mana pun. Ini yang membuat keputusan di T-025 (menyimpan post tanpa `matched_topics`) terbayar: membuangnya akan memaksa backfill menarik ulang dari provider, dan itu berbayar.

Tiga detail yang menentukan apakah ini aman dijalankan di produksi:

- **Script painless idempoten.** Backfill bisa dijalankan ulang (topic diaktifkan ulang, query diperbaiki, task di-retry). Tanpa pengecekan `contains`, `matched_topics` memuat topic yang sama berkali-kali dan tiap agregasi menghitung post itu berlipat.
- **`conflicts=proceed`.** Post yang sedang ditulis pipeline ingestion akan bentrok versi. Menghentikan seluruh backfill karena satu bentrok berarti sebagian besar topic gagal ter-backfill justru di jam sibuk.
- **Throttle 500 req/s.** Ingestion punya jendela waktu dari provider; backfill tidak punya tenggat sama sekali. Yang punya tenggat harus menang.

### T-027 — retensi menghapus INDEX, bukan dokumen

Ini yang membuat partisi index bulanan (T-004) terbayar. Menghapus index adalah operasi instan yang membebaskan disk seketika; `delete_by_query` pada jutaan dokumen memakan berjam-jam, membebani klaster saat berjalan, dan meninggalkan segment tombstone yang baru hilang setelah merge.

`rencanakan_pembersihan()` dibuat sebagai fungsi murni supaya keputusan "index mana yang dihapus" bisa **diperiksa sebelum dijalankan**. Penghapusan data tidak boleh jadi efek samping yang tidak terlihat. Nama index yang tidak dikenali sengaja **tidak** dihapus — menebak-nebak pada operasi yang menghancurkan data adalah cara kehilangan index yang bukan milik kita.

### T-028 — koreksi: Indonesia punya 38 provinsi, bukan 34

TASK.md menulis 34. Itu jumlah **sebelum pemekaran Papua 2022**, yang menambahkan Papua Selatan, Papua Tengah, Papua Pegunungan, dan Papua Barat Daya. Acceptance-nya dikoreksi jadi 38.

Kalau angka lama dipakai, empat provinsi Papua baru tidak akan pernah muncul di peta berapa pun jumlah post-nya — dan itu tidak menimbulkan error, cuma wilayah yang hilang dari dashboard.

Dua keputusan yang menentukan kualitas panel Topic Location:

- **Kota dipetakan ke provinsinya.** Orang jauh lebih sering menulis "Bandung" daripada "Jawa Barat". Tanpa pemetaan kota, panel ini akan hampir kosong.
- **Alias dicocokkan dari yang terpanjang.** Tanpa itu, "papua barat daya" keburu cocok dengan "papua barat" — provinsi yang berbeda.

Ada test yang menjaga tiap provinsi punya minimal satu alias: provinsi tanpa alias tidak akan pernah muncul di peta, berapa pun jumlah post-nya.

**Mengapa `[~]` untuk T-026 dan T-027:** keduanya punya acceptance berupa perilaku runtime terhadap data nyata ("cocok dalam 10 menit", "kebijakan berjalan otomatis") yang cuma bisa dibuktikan terhadap OpenSearch hidup. T-028 `[x]` karena resolusi lokasi adalah fungsi murni.

**Dampak biaya:** backfill nol panggilan provider; retensi memangkas biaya storage tanpa menyentuh agregat.

**Next:** E4 (NLP Pipeline), mulai T-029

---

## T-023, T-024, T-025 · Percolator & translator query — 2026-09-03

**FR:** FR-102, FR-206

**Dikerjakan:** Translator boolean query ke DSL OpenSearch, pendaftaran query topic sebagai dokumen percolator, dan routing batch post ke topic.

**File:** `packages/core/sma_core/query/translate.py`, `packages/core/sma_core/search/percolator.py`, `tests/core/test_percolator.py`

**Verifikasi:** 30 test baru, total 466 lolos.

### Perubahan rencana: `bool` query dari AST, bukan `query_string`

ARCHITECTURE.md bagian 3.2 menyebut `query_string` karena sintaksnya memetakan hampir 1:1 ke boolean query di UI. Waktu mengerjakannya, dua masalah jadi jelas — dan keduanya hilang kalau DSL dibangun langsung dari AST yang sudah kita punya:

1. **Permukaan injeksi.** `query_string` mentah mengizinkan akses field (`author.username:x`), regex penghabis CPU, dan wildcard awalan. Semuanya harus disaring lewat daftar putih, dan daftar putih adalah jenis pengaman yang gampang bocor.

2. **Ambiguitas operator implisit — risiko yang saya flag sendiri di T-019.** Parser memperlakukan spasi sebagai AND; default `query_string` adalah OR. Perbedaan itu harus dijaga sinkron lewat `default_operator`, dan kalau lupa, preview dan pencocokan sungguhan memberi hasil berbeda **tanpa error apa pun**.

Membangun `bool` query menghapus keduanya sekaligus: tidak ada string yang diteruskan ke mesin query, dan struktur AND/OR/NOT dinyatakan eksplisit alih-alih diserahkan ke penafsiran default. **Peringatan coupling `default_operator` yang saya tulis di docstring parser jadi tidak berlaku lagi** — bukan karena dijaga, tapi karena penyebabnya dihapus.

### Keputusan lain

**Term tunggal cocok teks ATAU hashtag.** Orang menulis `banjir` dan berharap post ber-`#banjir` ikut terjaring. Memisahkannya membuat user harus menulis query dua kali untuk maksud yang sama.

**Frasa dicocokkan utuh pada jalur tanpa stemming.** Kalau dicocokkan per kata, `"Kopdes Merah Putih"` akan cocok dengan kalimat yang kebetulan memuat ketiganya berjauhan.

**Query yang hanya berisi negasi ditolak.** `must_not` sendirian cocok dengan hampir seluruh korpus — hampir pasti bukan yang dimaksud user, dan kalau lolos ke percolator dia akan menarik setiap post ke topic itu.

**`_id` dokumen percolator memakai `query_id`, bukan `topic_id`.** Satu topic bisa punya beberapa query (FR-102), dan masing-masing harus bisa didaftarkan serta dicabut sendiri-sendiri.

**Mencabut query tidak menghapus post yang sudah cocok.** `matched_topics` pada post lama tetap utuh — menghapus topic tidak boleh menghapus data historisnya (FR-101).

**Mengapa `[~]` untuk T-023 dan T-025:** keduanya punya acceptance yang berupa klaim kinerja (100 query terdaftar tanpa penurunan; latensi <50 ms per post) yang cuma bisa dibuktikan terhadap OpenSearch hidup. T-024 `[x]` karena translator adalah logika murni dan kemustahilan injeksinya bersifat struktural, bukan hasil penyaringan.

**Dampak biaya:** n/a langsung. Tapi percolator adalah yang membuat 108 topic tidak berarti 108 pencarian per post.

**Next:** T-026 (backfill topic baru)

---

## KOREKSI · Instagram mendukung pencarian teks — 2026-09-03

**Terkait:** T-014, dan catatan cakupan platform di entri T-014 s/d T-017

**Apa yang salah:** saya menulis bahwa Instagram tidak punya pencarian teks bebas dan hanya bisa dicari lewat hashtag, lalu membangun adapter yang menerjemahkan keyword topic jadi hashtag. Itu keliru.

**Penyebabnya:** batasan yang saya kutip benar untuk **Graph API resmi** Instagram, dan saya keliru menyimpulkan batasan itu berlaku juga untuk jalur pihak ketiga. Actor Apify tidak memakai Graph API — dia membaca antarmuka pencarian Instagram sendiri, yang mendukung pencarian konten. Ada juga actor khusus untuk itu (`crawlerbros/instagram-keyword-search-scraper`).

**Ketahuan karena** user mencobanya langsung dan melihat post muncul dari pencarian teks. Bukti pemakaian mengalahkan pembacaan dokumentasi saya.

**Dampaknya nyata, bukan kosmetik.** Dengan pemetaan ke hashtag, post yang menyebut sebuah isu di caption tanpa memakai tagarnya tidak akan terkumpul sama sekali. Angka Instagram di dashboard akan lebih rendah daripada kenyataan, dan tidak ada yang akan curiga karena angkanya tetap terlihat wajar.

**Perbaikan:** `InstagramAdapter` sekarang memakai `searchType: "search"` sebagai default dan mengirim keyword apa adanya. Mode hashtag masih tersedia lewat `InstagramAdapter(search_type="hashtag")` untuk topic berbasis kampanye tagar, di mana pencarian tagar memang lebih presisi. [DATA-SOURCES.md](docs/DATA-SOURCES.md) diperbaiki, dan pembedaan "batasan API resmi ≠ batasan pihak ketiga" ditulis eksplisit supaya tidak diputuskan salah lagi.

**Pelajaran yang dicatat:** untuk tiap platform, batasan jalur resmi dan jalur pihak ketiga harus diperiksa terpisah. Menyalin batasan yang satu ke yang lain memangkas cakupan tanpa alasan — dan kerugiannya berupa data yang tidak pernah terkumpul, yang jauh lebih sulit disadari daripada error.

---

## E2 SELESAI · T-019 s/d T-022 — 2026-09-02

**FR:** FR-202, FR-203, FR-204, FR-205, FR-402

**Dikerjakan:** Empat task penutup epic ingestion — dedup planner, adaptive polling, normalizer keenam platform, dan penulisan idempoten ke OpenSearch.

**File:**
- `packages/core/sma_core/query/boolean.py` — parser boolean (dipakai ulang T-024)
- `packages/core/sma_core/streams/{planner,scheduler}.py`
- `packages/core/sma_core/search/indexer.py`
- `packages/core/sma_core/storage/raw.py`
- `services/worker/sma_worker/normalize/{base,platforms}.py`
- Test: `tests/core/test_{boolean_query,planner,scheduler,indexer,raw_storage}.py`, `tests/worker/test_normalize.py`

**Verifikasi:** 434 test lolos, ruff dan mypy bersih (51 file source).

### Temuan desain terbesar: pemilihan cabang AND harus melihat rencana global

Test `test_kasus_tumpang_tindih_dari_dokumentasi_arsitektur` gagal di percobaan pertama — 4 stream, seharusnya 3. Penyebabnya nyata, bukan salah test.

Untuk `"banjir" AND "jakarta"`, versi pertama memilih term paling khusus (`jakarta`). Secara lokal itu masuk akal: term yang lebih jarang menarik lebih sedikit data. Tapi `banjir` **sudah dikumpulkan topic lain**, dan memakai ulang stream yang sudah ada berbiaya **nol** sementara membuka stream baru berbayar.

Pilihan terbaik ternyata bergantung pada apa yang sedang dikerjakan topic lain — jadi keputusan itu tidak boleh diambil di dalam parser. Ekstraksi diubah supaya **menunda** keputusan grup AND dan menyerahkan kandidatnya ke planner, yang lalu bekerja dua fase:

```
Fase 1  kumpulkan keyword yang tidak ada pilihannya (term tunggal, cabang OR)
Fase 2  baru putuskan grup AND, mengutamakan cabang yang sudah tercakup
```

Ini persis contoh di ARCHITECTURE.md bagian 3.1, dan versi pertama gagal memenuhinya.

**Bug lanjutan yang tertangkap dari situ:** di fase 2, `per_kunci` memakai kunci ternormalisasi (lowercase) sementara cabang kandidat masih term mentah. `"Banjir" AND "jakarta"` tidak mengenali stream `banjir` yang sudah ada, dan planner membuka stream kedua untuk keyword yang sama persis. Ditutup dengan normalisasi di sisi cabang plus test khusus.

### Keputusan lain yang berdampak

**Adaptive polling hanya boleh mempercepat.** Interval pilihan user adalah batas *paling basi*, bukan interval tetap. Scheduler boleh turun ke 5m saat ramai lalu kembali ke pilihan user saat sepi, tapi **tidak boleh lebih lambat** — kalau boleh, janji FR-402 ("refresh tiap 15 menit") jadi bohong tanpa ada yang memberi tahu. Yang boleh melewati batas itu hanya dua tekanan luar: rate limit provider dan cost guard (T-069).

**Penulisan memakai `update`, bukan `index`.** `index` mengganti seluruh dokumen. Saat post di-collect ulang karena metriknya berubah, itu akan **menghapus hasil NLP-nya** — dan post itu lalu diproses ulang, membayar biaya LLM untuk kedua kalinya, tanpa ada yang menyadari kecuali lewat tagihan. Field `nlp` tidak pernah ditulis dari jalur pengumpulan.

**Dedup lewat `_id` deterministik, bukan cek-lalu-tulis.** Cek-lalu-tulis punya lomba balapan: dua worker yang memproses batch tumpang tindih bisa sama-sama melihat "belum ada" lalu sama-sama menulis. Dengan `_id = platform:post_id`, idempotensi jadi sifat konstruksi, bukan sifat disiplin.

**Operator implisit adalah AND, berbeda dari default OpenSearch.** `banjir jakarta` diperlakukan sebagai `banjir AND jakarta` karena itu yang dimaksud orang. Konsekuensinya mengikat dan sudah ditulis di docstring parser: **T-024 wajib menyetel `default_operator: "AND"`**. Kalau tidak, preview dan pencocokan sungguhan memberi hasil berbeda untuk query yang sama, tanpa error apa pun.

**Payload mentah disimpan sebagai jaring pengaman, dan kegagalannya tidak menghentikan ingestion.** Kalau object storage bermasalah, `simpan()` mengembalikan `None` alih-alih melempar — menggagalkan ingestion demi menyelamatkan salinan berarti kehilangan data yang sudah dibayar.

**Mengapa `[~]` untuk T-021 dan T-022:** keduanya butuh infrastruktur hidup untuk pembuktian akhir. T-021 belum pernah menulis ke MinIO sungguhan; T-022 belum pernah membuktikan "jumlah dokumen tidak berubah setelah ingest kedua" terhadap OpenSearch. Job `integration` di CI yang menutup keduanya.

**Dampak biaya:** E2 sekarang memuat lengkap ketiga pengaman yang menopang model biaya — fetch inkremental (12,7x), stream bersama (1,35x pada 30 topic, 2,45x pada 108), dan pelestarian hasil NLP saat re-collect.

**Next:** E3, mulai T-023 (percolator index)

---

## T-018 · Adapter YouTube Data API v3 — KODE SELESAI `[~]` 2026-09-02

**FR:** FR-201, FR-204

**Dikerjakan:** Adapter YouTube plus `QuotaTracker` dengan dua backend penyimpanan. Fetch inkremental lewat `publishedAfter`, komentar video ikut terkumpul, dan habisnya quota ditangani tanpa exception.

**File:** `services/worker/sma_worker/adapters/youtube.py`, `tests/adapters/test_youtube.py`

**Verifikasi:** 34 test. Total suite 289 lolos.

**Dengan ini keenam platform Fase 1 punya adapter** — X, Instagram, TikTok, Facebook, Threads, YouTube.

**Yang berbeda dari platform lain: sumber daya langkanya bukan uang.** YouTube gratis, tapi dibatasi quota 10.000 unit/hari. `search.list` seharga 100 unit, jadi:

```
10.000 / 100 = 100 pencarian per hari untuk SELURUH platform

1 stream @ 15 menit = 96 pencarian/hari  -> hanya SATU stream yang muat
1 stream @ 1 jam    = 24 pencarian/hari  -> empat stream muat
```

Ini batas keras, bukan pilihan penyetelan. Untungnya YouTube cuma ~0,12% korpus. Matematika ini dikunci di test supaya tidak ada yang menyetel interval YouTube seagresif X tanpa sadar konsekuensinya.

Karena biayanya quota, `unit_cost_usd` bernilai 0 dan tekanan quota dilaporkan lewat `FetchResult.rate_limit` — jalur yang **sudah ada** dan sudah dibaca scheduler (FR-203). Tidak perlu field baru di schema bersama untuk satu platform.

**Keputusan: habisnya quota TIDAK melempar exception.** Adapter mengembalikan hasil kosong dengan penanda `rate_limit.is_exhausted`. Alasannya: exception akan membuat task di-retry sampai batas percobaan habis, padahal quota baru pulih tengah malam Pacific Time. Retry-nya tidak menolong sama sekali dan hanya memenuhi log alert dengan kegagalan yang penyebabnya sudah diketahui.

**Dua detail yang gampang salah dan sudah dikunci test:**

*Zona waktu reset.* Quota YouTube reset tengah malam **Pacific Time**, bukan UTC dan bukan WIB. Jam 06:00 UTC tanggal 2 September masih tanggal 1 di PT. Memakai tanggal UTC akan mereset penghitung 7–8 jam terlalu awal, dan gejalanya cuma "kok quota habis padahal baru pagi".

*403 punya dua arti.* Di YouTube, 403 bisa berarti quota habis **atau** API key ditolak. Penanganannya berlawanan: yang satu tunggu reset, yang satu perbaiki kredensial. Menyamakannya berarti key yang salah akan diperlakukan sebagai kondisi sementara — selamanya. Pembedanya dibaca dari body respons.

**Lubang yang ditutup sebelum menandai selesai.** Versi pertama hanya punya `InMemoryQuotaStore`. Itu membuat acceptance "pemakaian quota terlacak dan tidak melebihi batas harian" **tidak benar-benar terpenuhi**: quota YouTube berlaku per proyek, bukan per proses, jadi beberapa worker Celery yang jalan bersamaan masing-masing akan mengira punya 10.000 unit sendiri. Batas harian terlampaui tanpa satu pun menyadarinya.

Ditambahkan `RedisQuotaStore` dengan `INCRBY` atomik, dan dijadikan **default** — lupa menyuntikkan store di produksi harus menghasilkan perilaku yang benar, bukan penghitung per proses. `InMemoryQuotaStore` sekarang khusus test.

**Mengapa `[~]`:** belum pernah dipanggil ke YouTube Data API sungguhan (butuh API key).

**Dampak biaya:** nol rupiah. Yang perlu dijaga adalah quota, dan itu sekarang terlacak terpusat.

**Next:** T-019 (dedup planner)

---

## T-014 s/d T-017 · Empat adapter platform Apify — KODE SELESAI `[~]` 2026-09-02

**FR:** FR-201, FR-204

**Dikerjakan:** Adapter Instagram, TikTok, Facebook, dan Threads di atas `ApifyAdapter`. Masing-masing hanya perlu `actor_id`, `build_input()`, dan `extract_id()` — fondasi T-013 terbukti menahan beban seperti yang diharapkan.

**File:** `services/worker/sma_worker/adapters/{instagram,tiktok,facebook,threads}.py`, `tests/adapters/test_platform_apify.py`, `tests/adapters/helpers.py`

**Verifikasi:** 60 test baru, total suite 255 lolos. `KontrakAdapter` diwarisi keempatnya, jadi semua aturan biaya ikut teruji tanpa ditulis ulang — persis alasan kelas itu dibuat di T-011.

**Temuan produk yang mengubah pemahaman soal cakupan data.** Ini bukan detail implementasi; ini menentukan arti angka di dashboard:

| Platform | Pencarian teks bebas? | Arti angkanya |
|---|---|---|
| X, TikTok, Threads, YouTube | Ya | Semua post publik yang cocok |
| **Instagram** | **Tidak** | **Hanya post ber-hashtag** |
| **Facebook** | **Tidak** | **Hanya Page yang dikonfigurasi** |

**Instagram** tidak punya pencarian teks bebas untuk publik — dari jalur mana pun. Yang ada hanya hashtag, akun, atau lokasi. Adapter menerjemahkan keyword jadi hashtag (`"koperasi merah putih"` → `#koperasimerahputih`). Post yang menyebut isu di caption tanpa hashtagnya tidak akan terkumpul.

**Facebook** lebih berat lagi. Sejak CrowdTangle ditutup tidak ada pencarian keyword publik yang bisa diandalkan; actor pihak ketiga bekerja per-halaman. Adapter membaca daftar Page dari keyword berbentuk `facebook.com/...` atau `page:<nama>`, dan **melewati stream tanpa Page dengan biaya nol** alih-alih menjalankan run yang pasti sia-sia tapi tetap ditagih.

Keduanya sudah didokumentasikan di [DATA-SOURCES.md](docs/DATA-SOURCES.md#kemampuan-pencarian-per-platform). Dampaknya terbatas — Instagram 1,1% dan Facebook 0,24% korpus — tapi keterbatasan yang tidak dicatat akan berubah jadi salah baca di laporan.

**Dua keputusan penghematan biaya** yang masuk ke input actor, keduanya melindungi dari kejadian tunggal yang bisa menghabiskan anggaran sebulan:
- TikTok: `shouldDownloadComments=False` — satu video viral bisa punya ribuan komentar, masing-masing ditagih terpisah
- Threads: `includeReplies=False` — alasan sama

**Deviasi — bug isolasi test yang tertangkap.** Keempat adapter baru gagal terdaftar dengan pesan "instagram belum punya adapter" di file yang sama sekali tidak menyentuh registry. Penyebabnya `clear_registry()` di `test_contract.py`, yang mengosongkan registry global lalu hanya memulihkan twitter lewat `importlib.reload`.

Ini persis risiko yang sudah saya tulis sendiri sebagai komentar di test itu — dan tetap terjadi, karena pemulihan manual bergantung pada ingatan. Diganti context manager `temporary_registry()` yang menyimpan dan memulihkan seluruh isi registry, sehingga pemulihan tidak bisa terlupa. `clear_registry()` dihapus.

`KontrakAdapter` juga dipindah dari `test_contract.py` ke `helpers.py`, supaya bisa diwarisi lintas file tanpa relative import antar modul test.

**Mengapa `[~]`:** actor id dan skema input keempatnya disusun dari dokumentasi, belum diverifikasi terhadap akun Apify sungguhan.

**Dampak biaya:** Empat platform ini ~11% korpus tapi ~48% biaya data. Penegakan `maxItems` di sisi Apify plus mematikan komentar/reply adalah pengaman utamanya.

**Next:** T-018 (adapter YouTube Data API v3)

---

## T-013 · Klien dasar Apify — KODE SELESAI `[~]` 2026-09-01

**FR:** FR-201, FR-701

**Dikerjakan:** `ApifyClient` (mulai run, poll status, ambil dataset berpaginasi, tangani timeout dan run gagal) plus `ApifyAdapter` sebagai basis bersama. Empat adapter platform berikutnya — Instagram, TikTok, Facebook, Threads — cukup menyediakan `actor_id`, `build_input()`, dan `extract_id()`; seluruh logika biaya, cursor, dan penyaringan duplikat sudah di sini.

**File:** `services/worker/sma_worker/adapters/apify.py`, `tests/adapters/test_apify.py`

**Verifikasi:** 26 test. Total suite 195 test, lolos semua.

**Deviasi — mengapa `[~]`:** sama seperti T-012, semua acceptance lolos terhadap HTTP tiruan tapi belum pernah menjalankan actor Apify sungguhan (butuh akun berbayar).

**Perbedaan penting dari X, dan konsekuensinya ke biaya.** Apify tidak punya cursor sejati. Actor dijalankan, dan Apify menagih **setiap item yang dikembalikan** — termasuk yang sudah kita punya. Artinya penyaringan duplikat di sini **tidak menghemat uang sama sekali**; uangnya sudah keluar begitu actor mengembalikan hasil.

Ini kebalikan dari twitterapi.io, di mana `since_id` membuat run kedua berbiaya nol. Ada test khusus yang mengunci pembedaan ini (`test_penyaringan_duplikat_tidak_menghemat_uang`) supaya tidak ada yang kemudian "mengoptimalkan" dengan asumsi yang salah.

Yang benar-benar menghemat cuma dua, dan keduanya harus disetel **sebelum** run dimulai:
1. `maxItems` dikirim sebagai parameter Apify, bukan diterapkan setelah hasil datang — memotong di sisi kita berarti kita sudah membayar yang dipotong
2. Interval polling lebih longgar daripada X

Adapter juga memantau rasio duplikat: kalau lebih dari separuh item yang dibayar ternyata sudah dipunya, dia menulis warning berisi saran menurunkan frekuensi polling. Itu sinyal paling langsung bahwa sebuah stream sedang membuang uang.

**Keputusan lain:** run yang berstatus `FAILED` tetap diambil datasetnya. Run gagal bisa menghasilkan sebagian item dan Apify tetap menagihnya — membuangnya berarti membayar untuk data yang kita buang sendiri.

Daftar `seen_ids` di cursor dibatasi 500 entri. Cursor disimpan di kolom JSONB; tanpa batas dia tumbuh selamanya sampai membebani setiap penulisan stream.

**Catatan lingkungan (bukan masalah kode):** suite terasa lambat di mesin ini (25 detik) padahal durasi seluruh test dijumlah hanya ~2 detik. Sisanya adalah waktu import saat collection. Pengukuran berulang menunjukkan angka yang berayun 5x untuk paket yang sama (`httpx` 1094 ms lalu 6601 ms), jadi yang terukur adalah I/O mesin — sangat mungkin pemindaian antivirus atas `site-packages`, bukan biaya import sebenarnya. Di CI (Linux, tanpa AV) ini tidak akan muncul. Tidak ada perubahan kode yang dilakukan untuk ini.

**Dampak biaya:** Empat platform Apify menyumbang ~11% korpus tapi ~48% biaya data ($1,50–2,00/1K versus $0,15/1K untuk X). Penegakan `maxItems` di sisi Apify adalah pengaman utamanya.

**Next:** T-014 (adapter Instagram)

---

## T-012 · Adapter twitterapi.io — KODE SELESAI `[~]` 2026-09-01

**FR:** FR-201, FR-204

**Dikerjakan:** Adapter X/Twitter dengan fetch inkremental lewat operator `since_id:`, paginasi, penanganan rate limit dan auth, serta penghitungan biaya. 30 test dengan fixture respons provider.

**File:** `services/worker/sma_worker/adapters/twitterapi_io.py`, `packages/core/sma_core/http.py`, `tests/adapters/test_twitterapi_io.py`, `tests/adapters/fixtures/*.json`

**Verifikasi:** 30 test. Yang paling menentukan, `test_run_kedua_pada_stream_tak_berubah_nol_hasil_berbayar` — inti FR-204. Run pertama menarik data dan menyimpan cursor; run kedua memakai cursor itu dan biayanya **nol**. Tanpa ini, polling 5 menit membayar ulang jendela pencarian yang sama 288 kali sehari.

**Deviasi — mengapa `[~]`:** semua acceptance lolos, tapi fixture-nya **disusun dari dokumentasi provider, bukan direkam dari API sungguhan** (butuh API key berbayar). Bentuk endpoint dan nama field belum terbukti. Struktur adapter sengaja mengisolasi risiko ini: kalau bentuknya berbeda, yang berubah hanya konstanta di kepala modul dan `_parse_response` — logika biaya, cursor, dan paginasi tidak tersentuh.

**Deviasi — bug produksi yang tertangkap saat mengukur test lambat.** Suite melambat dari 4 detik jadi 52 detik setelah test adapter masuk. Penyebabnya diukur, bukan ditebak:

```
httpx.AsyncClient()                          1292 ms
httpx.AsyncClient(verify=<ctx dipakai ulang>)   0,3 ms
```

Konstruktor default httpx membangun SSLContext baru tiap kali dan memuat trust store sistem. Selisihnya ~4000x. Ini **bukan cuma masalah test**: `_make_client()` awalnya dipanggil sekali per fetch, jadi 1,3 detik terbuang di setiap siklus polling setiap stream — di produksi, terus-menerus. Diselesaikan dengan `sma_core.http.make_async_client()` yang memakai SSL context bersama. Suite turun ke 10,5 detik.

Dua keputusan penghematan biaya yang masuk ke query: `-is:retweet` (retweet adalah salinan teks yang sama, ditagih terpisah, nilainya untuk analisis isu hampir nol) dan keyword digabung `OR` alih-alih dipersempit (boolean logic sesungguhnya dikerjakan percolator, dan menyempitkan di sini merusak pemakaian stream bersama antar topic).

Perbandingan ID tweet memakai integer, bukan string. Snowflake ID panjangnya bisa berbeda, dan `"9" > "10"` secara leksikal — kalau salah, cursor mundur dan sistem membayar ulang data lama tanpa memunculkan error.

**Dampak biaya:** Ini adapter yang menanggung ~89% korpus. Fetch inkremental di sini adalah bagian terbesar dari penghematan 12,7x yang dijanjikan FR-204.

**Next:** T-013

---

## T-011 · Interface SourceAdapter & registry — SELESAI 2026-09-01

**FR:** FR-201

**Dikerjakan:** ABC `SourceAdapter` dengan kontrak `fetch(stream, cursor) -> FetchResult`, hierarki error yang membedakan retryable dari tidak, registry berbasis decorator, dan test kontrak yang bisa diwarisi adapter berikutnya.

**File:** `services/worker/sma_worker/adapters/{base,registry,__init__}.py`, `tests/adapters/test_contract.py`

**Verifikasi:** 12 test kontrak, dijalankan terhadap adapter tiruan.

**Deviasi:** `KontrakAdapter` dibuat sebagai kelas yang diwarisi, bukan sekadar test untuk adapter tiruan. Adapter Instagram/TikTok/Facebook berikutnya cukup mewarisinya dan aturan biaya langsung ikut teruji — supaya aturan itu tidak bergantung pada ingatan penulis adapter berikutnya.

`AuthError` ditandai **tidak** retryable. Mengulang request dengan kredensial yang sama akan gagal persis sama, sambil menghabiskan slot retry yang seharusnya dipakai kegagalan sementara.

Registry menolak pendaftaran ganda untuk satu platform. Dua adapter untuk platform yang sama berarti mana yang dipakai bergantung urutan import — dan itu berubah tanpa ada yang menyadarinya.

**Dampak biaya:** `FetchResult.cost` wajib, bukan opsional. Adapter yang tidak melaporkan biaya tidak lolos type check — kesalahan yang mungkin diubah jadi kesalahan yang mustahil. Ini yang membuat FR-701 bisa ditegakkan di seluruh adapter, bukan diandalkan pada disiplin.

**Next:** T-012

---

## E1 selesai · ringkasan — 2026-09-01

Sepuluh task fondasi. Tujuh `[x]`, empat `[~]` (menunggu Docker / GitHub Actions).

**Verifikasi menyeluruh yang dijalankan di akhir E1:**

```
ruff check          All checks passed
ruff format         49 files already formatted
mypy                Success: no issues found in 29 source files
pytest              127 passed in 4.49s
web: eslint         exit 0
web: tsc --noEmit   exit 0
web: next build     Compiled successfully
```

**Empat bug nyata ditemukan dan diperbaiki selama E1** — semuanya kelas "tidak menimbulkan error, cuma hasilnya salah", yang persis jenis paling mahal di sistem ini:

1. Predikat partial index ter-render jadi `IS 1` — SQL tidak valid di Postgres (T-003)
2. 13 varian bahasa gaul dipetakan ke dua bentuk baku sekaligus — Lucene akan mengekspansi ke keduanya dan mencemari word cloud (T-004)
3. ESLint diam-diam tidak pernah jalan saat `next build` (T-009)
4. Test config membaca env var dari conftest sehingga lolos secara palsu (T-006)

---

## T-010 · CI pipeline — KODE SELESAI `[~]` 2026-09-01

**FR:** —
**Dikerjakan:** Empat job GitHub Actions: `python` (ruff, format, mypy, pytest), `schema-drift` (regenerasi tipe TS lalu bandingkan — menegakkan acceptance T-005), `web` (eslint, tsc, build), dan `integration` (Postgres + OpenSearch + Redis sebagai service, menjalankan migrasi maju–mundur–maju lalu test bertanda `integration`).

**File:** `.github/workflows/ci.yml`

**Verifikasi:** Setiap perintah di dalam workflow dijalankan lokal dan lolos. Workflow-nya sendiri **belum pernah dieksekusi** — repo belum punya remote.

**Deviasi:** `schema-drift` sengaja dipisah jadi job sendiri, bukan digabung ke `python`. Kalau digabung, pesan kegagalannya terkubur di antara ratusan output test; sebagai job terpisah, judul job-nya langsung menyebut penyebabnya.

Job `integration` menjalankan `alembic downgrade base` lalu `upgrade head` lagi. Downgrade yang rusak biasanya baru ketahuan saat rollback produksi — waktu paling buruk untuk menemukannya.

**Dampak biaya:** n/a
**Next:** T-011

---

## T-009 · Skeleton Next.js 15 & design system — SELESAI 2026-09-01

**FR:** —
**Dikerjakan:** Next.js 15 App Router + React 19 + Tailwind v4. Design token untuk warna sentimen dan platform diambil dari screenshot referensi. Halaman sementara memakai tipe hasil generate dari model Pydantic, membuktikan jalur schema Python → TypeScript benar-benar terpakai.

**File:** `apps/web/` — `package.json`, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`, `postcss.config.mjs`, `app/{layout,page}.tsx`, `app/globals.css`

**Verifikasi:**
```
npx eslint .        exit 0
npx tsc --noEmit    exit 0
npm run build       Compiled successfully, 4/4 static pages
```

**Deviasi — bug yang tertangkap:** konfigurasi ESLint pertama mengimpor `eslint-config-next` langsung sebagai array flat config. Hasilnya `Failed to patch ESLint because the calling module was not recognized` — **dan `next build` tetap lanjut dan melaporkan sukses.** Artinya lint tidak pernah benar-benar jalan, tapi CI akan tampak hijau.

`eslint-config-next` versi ini masih eslintrc-only (tidak ada entry `flat`, tidak ada field `exports`). Diganti ke `FlatCompat` dari `@eslint/eslintrc`, jalur resmi Next 15. Setelah itu ESLint benar-benar jalan dan langsung menemukan 2 isu yang sebelumnya tak terlihat.

Warna sentimen dan platform diberi komentar "jangan diubah sembarangan": analis membaca dashboard tiap hari dan mengenali kategori dari warnanya sebelum membaca labelnya.

**Dampak biaya:** n/a
**Next:** T-010

---

## T-008 · Celery, Redis, & Beat scheduler — SELESAI 2026-09-01

**FR:** —
**Dikerjakan:** Aplikasi Celery dengan tiga antrean terpisah (`collect`, `enrich`, `aggregate`), `BaseTask` dengan retry exponential backoff + jitter dan logging kegagalan final, serta beat schedule untuk penjadwalan stream, pemeliharaan partisi, dan evaluasi cost guard. Modul task dibuat untuk keempat antrean; yang isinya menunggu epic lain melempar warning satu baris, bukan exception.

**File:** `services/worker/sma_worker/{app,base}.py`, `services/worker/sma_worker/tasks/{__init__,collect,enrich,aggregate,maintenance}.py`, `tests/worker/test_celery_config.py`

**Verifikasi:** 15 test. Yang paling penting: `test_semua_task_punya_routing_eksplisit` dan `test_semua_jadwal_menunjuk_task_yang_terdaftar` — dua kesalahan yang tidak memunculkan error apa pun sampai jauh kemudian.

**Deviasi:** Task yang belum diimplementasi sengaja **tidak** melempar `NotImplementedError`. Beat memanggilnya berulang; exception akan membanjiri log alert dengan kegagalan yang sudah diketahui, dan alert yang berisik akan diabaikan orang. Warning satu baris per interval cukup untuk mengingatkan tanpa menenggelamkan sinyal lain.

mypy strict menolak decorator Celery (Celery tidak menyertakan type stub), sehingga setiap fungsi task dianggap untyped dan efeknya menular ke pemanggil. Diselesaikan dengan override mypy yang dipersempit ke `sma_worker.base` dan `sma_worker.tasks.*` saja — melonggarkan seluruh `sma_worker` akan menyembunyikan bug tipe di logika adapter dan NLP, bagian yang justru paling rawan.

**Dampak biaya:** Pemisahan antrean adalah alasan backlog NLP tidak bisa menghentikan ingestion. Data yang belum di-NLP masih bisa diproses nanti; data yang tidak pernah terkumpul hilang permanen karena post keluar dari jendela pencarian provider.
**Next:** T-009

---

## T-007 · Skeleton FastAPI & healthcheck — SELESAI 2026-09-01

**FR:** FR-703
**Dikerjakan:** Aplikasi FastAPI dengan `/health` (readiness, mengecek Postgres/OpenSearch/Redis paralel) dan `/health/live` (liveness, sengaja tanpa cek dependensi). Middleware correlation ID menerima ID dari klien atau membuat baru. CORS dibatasi ke origin dashboard. Dokumentasi interaktif dimatikan di produksi.

**File:** `services/api/sma_api/{main,health,clients}.py`, `tests/api/test_health.py`

**Verifikasi:** 10 test, termasuk simulasi tiap dependensi mati satu-satu.

**Deviasi:** Kegagalan dependensi dibedakan jadi dua tingkat. Postgres dan OpenSearch kritis → 503 supaya load balancer menarik instance ini keluar rotasi. Redis hanya cache dan antrean → `degraded` tapi tetap 200, karena API masih bisa melayani, cuma lebih lambat. Menarik instance keluar rotasi karena cache mati justru memperparah keadaan.

`/health/live` sengaja tidak mengecek dependensi. Kalau liveness ikut gagal saat database putus, orchestrator akan me-restart semua instance beruntun alih-alih menunggu database pulih.

**Dampak biaya:** n/a
**Next:** T-008

---

## T-006 · Konfigurasi & manajemen secret — SELESAI 2026-09-01

**FR:** —
**Dikerjakan:** `Settings` berbasis pydantic-settings dengan prefix `SMA_`. Semua secret memakai `SecretStr`. Validator menolak startup produksi yang masih memakai kredensial contoh, DSN localhost, atau API key NLP kosong. `enabled_providers` melaporkan platform mana yang kredensialnya tersedia, supaya registry adapter bisa melewati yang belum dikonfigurasi.

**File:** `packages/core/sma_core/config.py`, `.env.example`, `tests/core/test_config.py`

**Verifikasi:** 15 test.

**Deviasi — bug yang tertangkap:** test "config wajib yang hilang harus ditolak" awalnya lolos secara palsu. `_env_file=None` hanya menutup file `.env`, sementara `conftest.py` menyetel variabel environment `SMA_*` untuk test lain — dan nilai itu menutupi field yang sengaja dihilangkan. Ditutup dengan `monkeypatch.delenv`. Kalau tidak ketahuan sekarang, test ini akan tetap hijau selamanya sambil tidak menguji apa pun.

Kredensial provider dibuat opsional secara sengaja: kehilangan satu platform tidak boleh mematikan ingestion platform lain, apalagi mematikan seluruh aplikasi.

**Dampak biaya:** Cost guard (`cost_cap_global_usd` default $400) sudah terpasang di config sejak sekarang, meski penegakannya menunggu T-069.
**Next:** T-007

---

## T-005 · Unified Post schema — SELESAI 2026-09-01

**FR:** FR-205
**Dikerjakan:** Model Pydantic sebagai satu-satunya sumber kebenaran bentuk data, plus generator tipe TypeScript. Aturan `None` versus `0` ditegakkan di schema dan diuji: field yang tidak tersedia di suatu platform bernilai `None`, bukan `0`.

**File:** `packages/schema/sma_schema/{__init__,enums,post,stream,topic,export_ts}.py`, `apps/web/lib/schema.generated.ts`, `tests/schema/{test_post,test_export_ts}.py`

**Verifikasi:** 37 test, termasuk cek drift yang meregenerasi tipe TS dan membandingkannya dengan yang ada di disk — inilah yang menegakkan acceptance "CI gagal kalau tipe generated tidak sinkron".

**Deviasi:** Generator awalnya menulis ke stdout dan di-redirect lewat `>`. Di Windows stdout memakai cp1252, dan em-dash di komentar hasil generate rusak jadi `?`. Diubah supaya generator menulis file langsung dengan encoding UTF-8 eksplisit.

`FetchResult.cost` dibuat wajib, bukan opsional. Kalau pencatatan biaya berupa efek samping, adapter yang lupa mencatat akan menghabiskan uang diam-diam dan baru ketahuan saat tagihan datang. Sebagai bagian dari nilai balik, adapter seperti itu tidak lolos type check — kesalahan yang mungkin diubah jadi kesalahan yang mustahil.

**Dampak biaya:** n/a langsung, tapi kontrak `cost` wajib inilah yang membuat FR-701 bisa ditegakkan.
**Next:** T-006

---

## T-004 · OpenSearch index template & analyzer Bahasa Indonesia — KODE SELESAI `[~]` 2026-09-01

**FR:** FR-205, FR-306
**Dikerjakan:** Kamus normalisasi bahasa gaul (162 bentuk baku, **659 varian** — target T-029 minimal 500), dua analyzer (`indonesian_text` untuk pencarian dan word cloud, `indonesian_exact` untuk frasa persis), mapping index post, dan index percolator untuk topic routing.

**File:** `packages/core/sma_core/search/{slang,analyzer,templates}.py`, `tests/core/{test_slang,test_templates}.py`

**Verifikasi:** 33 unit test. **Belum pernah dipasang ke OpenSearch hidup** — klaim "stem `penanganan` jadi `tangan`" dan uji 20 kalimat lewat API `_analyze` masih menunggu Docker.

**Deviasi — bug yang tertangkap:** kamus versi pertama punya **13 varian yang dipetakan ke dua bentuk baku sekaligus** (`parah` → `sangat` dan `jelek`; `kt` → `kami` dan `kota`; `oke` → `bagus` dan `ya`; dan sepuluh lainnya). Lucene mengekspansi input yang punya banyak output, jadi tiap kemunculan `parah` akan masuk index sebagai dua token berbeda — word cloud salah hitung, **tanpa error apa pun**.

Sebelas diselesaikan dengan memilih makna dominan. Dua (`parah`, `kesel`) dihapus dari normalisasi sama sekali karena benar-benar ambigu dalam pemakaian sehari-hari. Ditambah test yang menjaga supaya konflik seperti ini tidak bisa masuk lagi.

Ditemukan juga `test_semua_field_percolate_doc_ada_di_mapping`: kalau bentuk dokumen yang dikirim `to_percolate_doc()` tidak cocok dengan mapping percolator, query **tidak error — cuma tidak pernah cocok**. Gejalanya "topic saya kosong padahal datanya ada", dan penyebabnya ada di file yang berbeda. Test itu mengikat kedua sisi.

Stopword sengaja dibuat konservatif: `tidak`, `bukan`, `belum`, `jangan` **tidak** dimasukkan. Membuangnya akan membalik sentimen — "tidak bagus" jadi "bagus". Ada test khusus untuk itu.

**Dampak biaya:** n/a
**Next:** T-005

---

## T-003 · Skema PostgreSQL & migrasi awal — KODE SELESAI `[~]` 2026-09-01

**FR:** —
**Dikerjakan:** 10 tabel dari PRD bagian 8.2 sebagai model SQLAlchemy 2.0, setup Alembic, dan migrasi awal. `nlp_label` dipartisi per bulan dengan helper pemeliharaan partisi.

**File:** `packages/core/sma_core/db/{models,session,partitions,__init__}.py`, `alembic.ini`, `migrations/{env.py,script.py.mako}`, `migrations/versions/0001_initial_schema.py`, `tests/core/test_partitions.py`

**Verifikasi:** DDL terkompilasi benar untuk dialek PostgreSQL (10 tabel, 11 index, klausa `PARTITION BY RANGE` terbentuk). Migrasi lolos parse. 12 test batas partisi. **`alembic upgrade`/`downgrade` belum pernah dijalankan terhadap Postgres sungguhan.**

**Deviasi — dua bug yang tertangkap:**

1. **Predikat partial index ter-render jadi SQL tidak valid.** `postgresql_where=is_active.is_(True)` menghasilkan `WHERE is_active IS 1` — valid di dialek default, **ditolak Postgres**. Migrasinya akan gagal di eksekusi pertama. Diganti `sql_text("is_active")` untuk semua predikat boolean.

2. **`text` bentrok dengan nama kolom.** Import `sqlalchemy.text` tertutup oleh kolom `NlpLabel.text` di dalam class body, menghasilkan `TypeError: 'MappedColumn' object is not callable` saat import. Import di-rename jadi `sql_text`.

Migrasi awal **dibangkitkan dari metadata SQLAlchemy**, bukan diketik ulang — menghilangkan seluruh kelas kesalahan transkripsi antara model dan migrasi.

`nlp_label` sengaja **tidak** punya foreign key ke post: post kena retensi 12 bulan (FR-208) sementara label harus hidup lebih lama, dan teksnya disalin ke sini supaya tetap bisa dipakai training setelah post-nya dihapus.

**Dampak biaya:** n/a
**Next:** T-004

---

## T-002 · docker-compose untuk development — KODE SELESAI `[~]` 2026-09-01

**FR:** —
**Dikerjakan:** Compose file untuk PostgreSQL 16, OpenSearch 2.18, Redis 7, dan MinIO, lengkap dengan healthcheck dan volume persisten. Script `wait_for_services.py` menunggu semuanya siap lalu memasang index template dan index percolator.

**File:** `infra/docker-compose.yml`, `infra/wait_for_services.py`

**Verifikasi:** **Tidak ada.** Docker tidak terpasang di mesin development ini (dicek lewat Bash dan PowerShell). Compose file belum pernah dijalankan.

**Deviasi:** Rencana menyebut OpenSearch 3.x. Dipin ke `2.18.0` karena tag image itu bisa dipastikan ada, sementara tag 3.x tidak bisa diverifikasi tanpa Docker. `docs/ARCHITECTURE.md` dan TASK.md disesuaikan supaya konsisten — lebih baik dokumen menyebut versi yang benar-benar dipakai daripada versi yang terdengar lebih baru.

Healthcheck OpenSearch menerima status `yellow`, bukan `green`: single node tidak akan pernah green karena replica tidak punya tempat dialokasikan. Menunggu green akan menggantung selamanya.

`wait_for_services.py` menerima daftar service sebagai argumen. CI tidak menjalankan MinIO (belum ada test yang menyentuh object storage); tanpa argumen ini CI akan menunggu 120 detik lalu gagal untuk dependensi yang memang sengaja tidak dinyalakan.

**Dampak biaya:** n/a
**Next:** T-003

---

## T-001 · Inisialisasi monorepo & struktur folder — SELESAI 2026-09-01

**FR:** —
**Dikerjakan:** Struktur monorepo sesuai CLAUDE.md, `pyproject.toml` tunggal yang menemukan paket dari empat direktori, Makefile, `.env.example`, dan setup lint/format/typecheck untuk Python maupun TypeScript.

**File:** `pyproject.toml`, `Makefile`, `.env.example`, struktur direktori `apps/`, `services/`, `packages/`, `infra/`, `tests/`

**Verifikasi:** `ruff check`, `ruff format --check`, dan `mypy` berjalan bersih di seluruh basis kode Python; `eslint` dan `tsc` bersih di sisi web.

**Deviasi:** Ditambahkan paket keempat yang tidak ada di rencana: `packages/core` (`sma_core`) untuk config, logging, akses database, dan klien pencarian. Rencana hanya menyebut `packages/schema`, tapi menaruh config dan session database di dalam paket schema akan mencampur "bentuk data" dengan "cara mengakses infrastruktur" — dua hal yang berubah karena alasan berbeda. `CLAUDE.md` perlu diperbarui untuk mencerminkan ini.

Catatan alat: heredoc di Bash tool berulang kali gagal untuk konten besar (satu kali menggantung sampai timeout 2 menit dan mengunci sesi shell). Sisa pekerjaan memakai Write tool dan PowerShell.

**Dampak biaya:** n/a
**Next:** T-002

---

## T-000 · Paket dokumentasi — SELESAI 2026-09-01

**FR:** —

**Dikerjakan:** Menyusun dokumentasi dasar sebelum implementasi: PRD dengan 46 requirement fungsional yang bisa diuji, TASK.md berisi 75 task terpetakan ke FR, dan dokumen pendukung untuk arsitektur, sumber data, model biaya, serta roadmap. Riset harga provider dilakukan terhadap kondisi pasar September 2026 — bukan dari asumsi lama — karena harga API sosial media berubah signifikan sepanjang 2025–2026.

**File:**
- `PRD.md`, `TASK.md`, `PROGRESS.md`
- `docs/ARCHITECTURE.md`, `docs/DATA-SOURCES.md`, `docs/COST-MODEL.md`, `docs/ROADMAP.md`
- `CLAUDE.md`, `README.md`, `.gitignore`
- `docs/screenshots/` — 13 screenshot referensi dipindah dari root

**Verifikasi:**
- Traceability: 46 FR di PRD, semuanya muncul di matriks TASK.md. Nol FR yatim.
- Dependency graph: 75 task, semua ID `Depends` merujuk ke task yang ada, tidak ada siklus.
- Coverage screenshot: 13 screenshot, semua panel terpetakan ke FR Fase 1 atau item roadmap Fase 2–4.
- Aritmatika biaya dicek ulang terhadap harga provider terpublikasi (tautan sumber ada di COST-MODEL.md).

**Deviasi:** Tidak ada terhadap rencana. Tapi tiga temuan riset mengubah desain secara substansial dibanding asumsi awal:

1. **API resmi bukan opsi yang layak.** Ini bukan soal mahal saja. Meta Graph API dan TikTok API sama sekali tidak menyediakan pencarian keyword publik, jadi fitur inti produk mustahil dibangun di atasnya. Third-party provider bukan pilihan penghematan — dia satu-satunya jalan.
2. **Polling tanpa cursor menyebabkan pembengkakan biaya 12,7x.** Provider menagih per hasil yang dikembalikan, bukan per hasil unik. Ini mengangkat fetch inkremental dari "optimasi" menjadi requirement kelas satu (FR-204).
3. **Biaya harus dipisahkan dari jumlah topic.** Produk referensi punya 108 topic. Desain per-topic-collector berbiaya 1,35x lipat pada 30 topic, naik jadi 2,45x pada 108 topic. Ini melahirkan FR-202 dan T-019.

**Koreksi terhadap estimasi awal:** perkiraan pertama menyebut stream bersama sebagai pengaman biaya terbesar (4,4x). Setelah perhitungan presisi memakai porsi platform sebenarnya dari `Screenshot_9.png`, urutannya terbalik: **fetch inkremental jauh lebih menentukan** (12,7x) dibanding stream bersama (1,35x pada 30 topic). Konsekuensi praktis: T-012 dan T-022 didahulukan sebelum T-019. Penurunan lengkapnya di [COST-MODEL.md bagian 5](docs/COST-MODEL.md).

**Koreksi kedua — estimasi effort.** Perkiraan kasar awal 71 hari kerja. Setelah tiap task diberi estimasi dan grafnya dihitung, hasilnya **92,5 hari** dengan critical path 17,5 hari. Selisih 30% ini muncul karena perkiraan awal tidak menghitung E9 (cost guard dan observability) sebagai pekerjaan tersendiri. Perlu dicatat bahwa E9 gampang tergoda untuk ditunda, padahal biaya sudah mulai berjalan begitu T-012 selesai.

**Dampak biaya:** Menetapkan baseline $345/bln untuk 30 topic (Rp 190 rb per topic).

**Next:** T-001 — inisialisasi monorepo
