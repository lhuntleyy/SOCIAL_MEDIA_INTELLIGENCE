-- Semua batas & jadwal diatur owner di Pengaturan (permintaan pemilik 2026-10-03):
-- 1) interval pengambilan per platform (NULL = bawaan sistem/plan); berlaku ke semua plan platform itu
-- 2) batas post per pengambilan dilonggarkan (≤ 10.000)
-- 3) pengaturan sistem global (scrape awal topik, komentar, …) sebagai key → jsonb
ALTER TABLE platforms ADD COLUMN crawl_interval_sec int NULL CHECK (crawl_interval_sec BETWEEN 60 AND 86400);
ALTER TABLE platforms DROP CONSTRAINT IF EXISTS platforms_max_items_per_run_check;
ALTER TABLE platforms ADD CONSTRAINT platforms_max_items_per_run_check CHECK (max_items_per_run BETWEEN 1 AND 10000);

CREATE TABLE system_settings (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_.]{1,63}$'),
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NULL
);
GRANT SELECT ON system_settings TO smip_app;
