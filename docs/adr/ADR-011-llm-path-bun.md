# ADR-011 — Jalur LLM worker-ai di Bun; encoder lokal tetap Python

- Status: Accepted (2026-09-30)
- Konteks: AI_SPEC §4.1 = encoder lokal (Python) + LLM fallback. Untuk demo/dev (VPS 2 GB) encoder tidak bisa dijalankan,
  dan pemilik memilih LLM (Gemini tier gratis dulu) yang bisa diganti dari panel admin (Claude/OpenAI/OpenRouter/custom).
  Panggilan LLM = I/O-bound; adapter TS sudah dibutuhkan panel admin (daftar model, tes).
- Keputusan:
  1. **Jalur LLM** (`apps/worker-ai`, Bun) memakai paket bersama `@smip/llm` (adapter per protokol: gemini, openai_compatible,
     anthropic) + pengaturan DB (`llm_*`, migrasi 0021): provider, multi API key (rotasi, cooldown 429, invalid), tugas → model +
     cadangan, `params` (batch_size, max_rpm, max_output_tokens). Satu panggilan per batch (≤ 20 post) → hemat kuota/RPM.
  2. **Encoder lokal** (A-02, IndoBERT dsb.) tetap direncanakan di Python (`workers-py`) — kontrak `ai.enrich → sink.analytics`
     sama, sehingga jalur bisa digabung: encoder dulu, LLM hanya untuk confidence < τ (AI_SPEC §4.1).
  3. Setiap label LLM ditulis ke `nlp_labels` (source `llm`) + teks terpseudonim di bucket training (A-10) → korpus untuk
     fine-tune model sendiri (AI_SPEC §14). Gold set manusia (S-20) tetap terpisah sebagai alat ukur.
  4. LLM gagal di percobaan terakhir → post tetap mengalir dengan `model_version = unlabeled` (confidence 0) untuk di-reprocess
     (A-06, `reprocess.ai` → sink `relabel` −1/+1), bukan tebakan.
- Konsekuensi: satu bahasa lebih sedikit di jalur panas demo; Python worker-ai baru dibuat saat encoder siap. Tier gratis Gemini:
  data dapat dipakai Google untuk perbaikan produk (ketentuan unpaid) → gunakan tier berbayar untuk data klien.
