DROP INDEX IF EXISTS cost_allocations_unapplied_idx;
ALTER TABLE cost_allocations DROP COLUMN requests, DROP COLUMN results, DROP COLUMN matches, DROP COLUMN applied_at;
ALTER TABLE crawl_runs DROP COLUMN tenant_matches;
