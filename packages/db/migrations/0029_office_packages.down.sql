DROP INDEX IF EXISTS crawl_runs_stream_idx;
UPDATE tenants SET plan_id = NULL WHERE plan_id IN (SELECT id FROM plans WHERE code IN ('hemat', 'standar', 'plus', 'cepat', 'realtime'));
DELETE FROM plans WHERE code IN ('hemat', 'standar', 'plus', 'cepat', 'realtime');
