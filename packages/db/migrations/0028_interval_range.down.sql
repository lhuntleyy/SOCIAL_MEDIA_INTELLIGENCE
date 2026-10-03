UPDATE crawl_plans SET interval_sec = 3600 WHERE interval_sec NOT IN (300, 900, 1800, 2700, 3600);
UPDATE topic_platforms SET interval_sec = NULL WHERE interval_sec NOT IN (300, 900, 1800, 2700, 3600);
UPDATE topics SET default_interval_sec = 3600 WHERE default_interval_sec NOT IN (300, 900, 1800, 2700, 3600);
ALTER TABLE crawl_plans DROP CONSTRAINT crawl_plans_interval_sec_check;
ALTER TABLE crawl_plans ADD CONSTRAINT crawl_plans_interval_sec_check CHECK (interval_sec IN (300, 900, 1800, 2700, 3600));
ALTER TABLE topic_platforms DROP CONSTRAINT topic_platforms_interval_sec_check;
ALTER TABLE topic_platforms ADD CONSTRAINT topic_platforms_interval_sec_check CHECK (interval_sec IN (300, 900, 1800, 2700, 3600));
ALTER TABLE topics DROP CONSTRAINT topics_default_interval_sec_check;
ALTER TABLE topics ADD CONSTRAINT topics_default_interval_sec_check CHECK (default_interval_sec IN (300, 900, 1800, 2700, 3600));
