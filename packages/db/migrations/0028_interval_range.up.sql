-- Interval pengambilan diatur owner per platform (Pengaturan → Batas & jadwal, 0025) dengan pilihan 5 menit … 24 jam →
-- daftar tetap (5/15/30/45/60 menit) diganti rentang 1 menit – 24 jam.
ALTER TABLE crawl_plans DROP CONSTRAINT crawl_plans_interval_sec_check;
ALTER TABLE crawl_plans ADD CONSTRAINT crawl_plans_interval_sec_check CHECK (interval_sec BETWEEN 60 AND 86400);
ALTER TABLE topic_platforms DROP CONSTRAINT topic_platforms_interval_sec_check;
ALTER TABLE topic_platforms ADD CONSTRAINT topic_platforms_interval_sec_check CHECK (interval_sec BETWEEN 60 AND 86400);
ALTER TABLE topics DROP CONSTRAINT topics_default_interval_sec_check;
ALTER TABLE topics ADD CONSTRAINT topics_default_interval_sec_check CHECK (default_interval_sec BETWEEN 60 AND 86400);
