DROP TABLE IF EXISTS system_settings;
ALTER TABLE platforms DROP CONSTRAINT IF EXISTS platforms_max_items_per_run_check;
ALTER TABLE platforms ADD CONSTRAINT platforms_max_items_per_run_check CHECK (max_items_per_run BETWEEN 1 AND 1000);
ALTER TABLE platforms DROP COLUMN IF EXISTS crawl_interval_sec;
