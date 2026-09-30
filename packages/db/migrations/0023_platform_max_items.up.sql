-- Batas post per pengambilan (per run) per platform — diatur owner di Pengaturan → Sumber data (mis. YouTube terlalu banyak).
-- NULL = bawaan worker-dispatch (300). Berlaku untuk run incremental/backfill/stream; engagement refresh memakai jumlah target.
ALTER TABLE platforms ADD COLUMN max_items_per_run int NULL CHECK (max_items_per_run BETWEEN 1 AND 1000);
