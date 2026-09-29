-- I-20 engagement refresh (FR-I06, QUEUE_SPEC §4.8): run system-owned tanpa plan/stream, target = daftar post.
ALTER TABLE crawl_runs DROP CONSTRAINT crawl_runs_owner_ck;
ALTER TABLE crawl_runs ADD CONSTRAINT crawl_runs_owner_ck CHECK (
  (crawl_plan_id IS NULL) <> (collection_stream_id IS NULL)
  OR (crawl_plan_id IS NULL AND collection_stream_id IS NULL AND tenant_id IS NULL AND kind = 'engagement_refresh')
);
-- {platform, post_ids[]} — hanya untuk kind = engagement_refresh
ALTER TABLE crawl_runs ADD COLUMN refresh_target jsonb;
CREATE INDEX crawl_runs_refresh_active_idx ON crawl_runs ((refresh_target->>'platform'))
  WHERE kind = 'engagement_refresh' AND status IN ('queued', 'dispatching', 'fetching', 'processing');
