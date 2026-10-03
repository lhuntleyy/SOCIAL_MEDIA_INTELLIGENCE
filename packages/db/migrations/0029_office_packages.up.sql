-- Paket per kantor (keputusan pemilik 2026-10-04, COST_MODEL §12.6): jadwal pengambilan per platform disimpan di plans.limits
-- `platform_intervals` → kantor memilih paket (tenants.plan_id). Urutan interval efektif: interval eksplisit topik (API) → paket
-- kantor → jadwal bawaan owner (platforms.crawl_interval_sec) → bawaan topik.
INSERT INTO plans (id, code, name, limits) VALUES
  ('00000000-0000-7000-8000-0000000000a1', 'hemat', 'Hemat',
   '{"max_users":20,"max_topics":50,"retention_days":365,"min_interval_sec":300,"sort":1,"description":"Semua platform tiap 3 jam","platform_intervals":{"x":10800,"tiktok":10800,"instagram":10800,"threads":10800,"facebook":10800,"youtube":10800}}'),
  ('00000000-0000-7000-8000-0000000000a2', 'standar', 'Standar',
   '{"max_users":20,"max_topics":50,"retention_days":365,"min_interval_sec":300,"sort":2,"description":"Semua tiap 1 jam · YouTube tiap 3 jam","platform_intervals":{"x":3600,"tiktok":3600,"instagram":3600,"threads":3600,"facebook":3600,"youtube":10800}}'),
  ('00000000-0000-7000-8000-0000000000a3', 'plus', 'Plus',
   '{"max_users":20,"max_topics":50,"retention_days":365,"min_interval_sec":300,"sort":3,"description":"Semua tiap 30 menit · YouTube tiap 1 jam","platform_intervals":{"x":1800,"tiktok":1800,"instagram":1800,"threads":1800,"facebook":1800,"youtube":3600}}'),
  ('00000000-0000-7000-8000-0000000000a4', 'cepat', 'Cepat',
   '{"max_users":20,"max_topics":50,"retention_days":365,"min_interval_sec":300,"sort":4,"description":"Semua tiap 15 menit · YouTube tiap 1 jam","platform_intervals":{"x":900,"tiktok":900,"instagram":900,"threads":900,"facebook":900,"youtube":3600}}'),
  ('00000000-0000-7000-8000-0000000000a5', 'realtime', 'Real-time',
   '{"max_users":20,"max_topics":50,"retention_days":365,"min_interval_sec":300,"sort":5,"description":"Semua tiap 5 menit · YouTube tiap 1 jam","platform_intervals":{"x":300,"tiktok":300,"instagram":300,"threads":300,"facebook":300,"youtube":3600}}')
ON CONFLICT (code) DO NOTHING;
-- interval per topik tidak diatur dari UI sejak 0025: nilai tersimpan hanyalah salinan jadwal lama → dilepas agar paket berlaku
UPDATE topic_platforms SET interval_sec = NULL;
-- jadwal adaptif (scheduler pace.ts) membaca run terakhir per collection stream
CREATE INDEX IF NOT EXISTS crawl_runs_stream_idx ON crawl_runs (collection_stream_id, scheduled_for DESC) WHERE collection_stream_id IS NOT NULL;
