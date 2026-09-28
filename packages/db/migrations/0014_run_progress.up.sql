-- I-14/I-15: penutupan run tanpa race. pending_batches = pesan hilir yang belum selesai (pipeline.items → ai.enrich/
-- sink.analytics). Dispatch +1 per pipeline.items; pipeline mengganti dirinya dgn N batch anak (+N−1); sink −1.
-- Run ditutup (succeeded/partial + watermark) saat status = processing DAN pending_batches = 0 — dicek oleh
-- siapa pun yang terakhir mengubah counter, di bawah row lock (crawl_runs FOR UPDATE).
ALTER TABLE crawl_runs
  ADD COLUMN pending_batches int NOT NULL DEFAULT 0 CHECK (pending_batches >= 0),
  ADD COLUMN min_published_at timestamptz,   -- batas bawah item diterima → gap_window run partial (CONNECTOR_SPEC §7)
  ADD COLUMN max_published_at timestamptz;   -- kandidat high_watermark (hanya diterapkan bila succeeded)
