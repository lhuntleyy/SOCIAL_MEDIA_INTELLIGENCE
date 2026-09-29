DROP INDEX IF EXISTS stream_topic_links_query_idx;
DROP INDEX IF EXISTS collection_streams_due_idx;
ALTER TABLE collection_streams DROP COLUMN consecutive_failures, DROP COLUMN priority, DROP COLUMN updated_at;
