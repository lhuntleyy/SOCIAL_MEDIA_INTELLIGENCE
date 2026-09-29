-- I-22: collection stream dijadwalkan seperti crawl_plans (backoff kegagalan & prioritas queue).
ALTER TABLE collection_streams
  ADD COLUMN consecutive_failures int NOT NULL DEFAULT 0,
  ADD COLUMN priority smallint NOT NULL DEFAULT 5,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX collection_streams_due_idx ON collection_streams (next_run_at) WHERE enabled;
CREATE INDEX stream_topic_links_query_idx ON stream_topic_links (topic_query_id);
