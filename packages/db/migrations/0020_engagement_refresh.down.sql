DROP INDEX IF EXISTS crawl_runs_refresh_active_idx;
DELETE FROM crawl_runs WHERE crawl_plan_id IS NULL AND collection_stream_id IS NULL;
ALTER TABLE crawl_runs DROP COLUMN refresh_target;
ALTER TABLE crawl_runs DROP CONSTRAINT crawl_runs_owner_ck;
ALTER TABLE crawl_runs ADD CONSTRAINT crawl_runs_owner_ck CHECK ((crawl_plan_id IS NULL) <> (collection_stream_id IS NULL));
