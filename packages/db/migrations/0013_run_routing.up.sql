-- I-13: state routing per run (exclude connector/akun hasil failover, retry, recompile, policy) — dibaca
-- worker-dispatch saat fetch.result tiba, tanpa bergantung pada isi pesan (pesan bisa duplikat/terlambat).
ALTER TABLE crawl_runs ADD COLUMN routing jsonb NOT NULL DEFAULT '{}';
