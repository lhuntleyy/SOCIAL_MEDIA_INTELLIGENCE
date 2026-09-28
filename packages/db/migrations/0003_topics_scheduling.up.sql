-- F-04 · DATA_MODEL §3 topic & scheduling (+ collection stream ADR-009, celah partial success CONNECTOR_SPEC §7)
CREATE TABLE platforms (
  code text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{0,31}$'),
  name text NOT NULL,
  icon text NOT NULL,
  content_types text[] NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  sort_order int NOT NULL DEFAULT 0
);

CREATE TABLE taxonomies (
  id uuid PRIMARY KEY,
  tenant_id uuid REFERENCES tenants (id) ON DELETE CASCADE,   -- NULL = global
  type e_taxonomy_type NOT NULL,
  name text NOT NULL
);
CREATE UNIQUE INDEX taxonomies_uniq ON taxonomies (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'), type, lower(name));

CREATE TABLE topics (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  author_user_id uuid REFERENCES users (id),
  status e_topic_status NOT NULL DEFAULT 'active',
  filter_ads boolean NOT NULL DEFAULT false,
  language_hints text[] NOT NULL DEFAULT '{id}',
  default_interval_sec int NOT NULL DEFAULT 900 CHECK (default_interval_sec IN (300, 900, 1800, 2700, 3600)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX topics_name_uniq ON topics (tenant_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX topics_tenant_status_idx ON topics (tenant_id, status);
CREATE INDEX topics_name_trgm ON topics USING gin (name gin_trgm_ops);

CREATE TABLE topic_taxonomies (
  topic_id uuid NOT NULL REFERENCES topics (id) ON DELETE CASCADE,
  taxonomy_id uuid NOT NULL REFERENCES taxonomies (id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  PRIMARY KEY (topic_id, taxonomy_id)
);

CREATE TABLE topic_queries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  topic_id uuid NOT NULL REFERENCES topics (id) ON DELETE CASCADE,
  kind e_query_kind NOT NULL,
  label text,
  query_text text NOT NULL CHECK (length(query_text) <= 2000),
  query_ast jsonb NOT NULL,
  ast_hash bytea NOT NULL,
  keywords text[],
  media_tags text[],
  not_media_tags text[],
  languages text[] CHECK (languages <@ ARRAY['id', 'en', 'ms']),
  platforms text[],
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX topic_queries_topic_idx ON topic_queries (topic_id);
CREATE INDEX topic_queries_ast_hash_idx ON topic_queries (ast_hash);

CREATE TABLE topic_platforms (
  topic_id uuid NOT NULL REFERENCES topics (id) ON DELETE CASCADE,
  platform_code text NOT NULL REFERENCES platforms (code),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  interval_sec int CHECK (interval_sec IN (300, 900, 1800, 2700, 3600)),
  operations text[] NOT NULL DEFAULT '{search_keyword}',
  PRIMARY KEY (topic_id, platform_code)
);

CREATE TABLE crawl_plans (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  topic_id uuid NOT NULL REFERENCES topics (id) ON DELETE CASCADE,
  topic_query_id uuid NOT NULL REFERENCES topic_queries (id) ON DELETE CASCADE,
  platform_code text NOT NULL REFERENCES platforms (code),
  operation text NOT NULL,
  interval_sec int NOT NULL CHECK (interval_sec IN (300, 900, 1800, 2700, 3600)),
  status e_plan_status NOT NULL DEFAULT 'active',
  next_run_at timestamptz NOT NULL,
  last_run_at timestamptz,
  high_watermark timestamptz,                 -- hanya maju pada run succeeded
  gap_windows jsonb NOT NULL DEFAULT '[]',    -- celah run partial
  cursor_state jsonb NOT NULL DEFAULT '{}',
  inflight_run_id uuid,                       -- coalescing; reaper membersihkan run mandek
  consecutive_failures int NOT NULL DEFAULT 0,
  priority smallint NOT NULL DEFAULT 5,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (topic_query_id, platform_code, operation)
);
CREATE INDEX crawl_plans_due_idx ON crawl_plans (status, next_run_at) WHERE status = 'active';

CREATE TABLE collection_streams (
  id uuid PRIMARY KEY,
  platform_code text NOT NULL REFERENCES platforms (code),
  operation text NOT NULL,
  stream_key bytea NOT NULL UNIQUE,
  interval_class int NOT NULL CHECK (interval_class IN (300, 900, 1800, 2700, 3600)),
  visibility_tenant_id uuid REFERENCES tenants (id) ON DELETE CASCADE,  -- NULL = shared pool; isi = stream privat (akun BYO, R-15)
  terms text[] NOT NULL,
  query_native jsonb NOT NULL DEFAULT '{}',
  interval_sec int NOT NULL,
  cursor_state jsonb NOT NULL DEFAULT '{}',
  high_watermark timestamptz,
  gap_windows jsonb NOT NULL DEFAULT '[]',
  inflight_run_id uuid,
  next_run_at timestamptz NOT NULL,
  last_run_at timestamptz,
  enabled boolean NOT NULL DEFAULT true
);

CREATE TABLE stream_topic_links (
  stream_id uuid NOT NULL REFERENCES collection_streams (id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  topic_query_id uuid NOT NULL REFERENCES topic_queries (id) ON DELETE CASCADE,
  PRIMARY KEY (stream_id, topic_query_id)
);

-- Partisi bulanan (dibuat oleh smip_ensure_monthly_partitions, migrasi 0006)
CREATE TABLE crawl_runs (
  id uuid NOT NULL,
  tenant_id uuid REFERENCES tenants (id) ON DELETE CASCADE,  -- NULL = run collection stream (system-owned)
  crawl_plan_id uuid REFERENCES crawl_plans (id) ON DELETE CASCADE,
  collection_stream_id uuid REFERENCES collection_streams (id) ON DELETE CASCADE,
  scheduled_for timestamptz NOT NULL,
  kind e_run_kind NOT NULL,
  status e_run_status NOT NULL DEFAULT 'queued',
  window_from timestamptz,
  window_to timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  attempts smallint NOT NULL DEFAULT 0,
  items_fetched int NOT NULL DEFAULT 0,
  items_matched int NOT NULL DEFAULT 0,
  items_new int NOT NULL DEFAULT 0,
  final_connector_id uuid,
  error_code text,
  error_message text,                                          -- sudah di-redact
  trace_id text,
  PRIMARY KEY (id, scheduled_for),
  CONSTRAINT crawl_runs_owner_ck CHECK ((crawl_plan_id IS NULL) <> (collection_stream_id IS NULL)),
  CONSTRAINT crawl_runs_tenant_ck CHECK ((collection_stream_id IS NULL OR tenant_id IS NULL) AND (crawl_plan_id IS NULL OR tenant_id IS NOT NULL))
) PARTITION BY RANGE (scheduled_for);
CREATE INDEX crawl_runs_plan_idx ON crawl_runs (crawl_plan_id, scheduled_for DESC);
CREATE INDEX crawl_runs_active_idx ON crawl_runs (status) WHERE status IN ('queued', 'dispatching', 'fetching', 'processing');

CREATE TABLE provider_attempts (
  id uuid NOT NULL,
  crawl_run_id uuid NOT NULL,
  crawl_run_scheduled_for timestamptz NOT NULL,
  tenant_id uuid,
  connector_id uuid NOT NULL,
  provider_account_id uuid,
  attempt_no smallint NOT NULL,
  started_at timestamptz NOT NULL,
  duration_ms int,
  outcome e_attempt_outcome NOT NULL,
  error_code text,
  http_status smallint,
  items int,
  usage jsonb,
  raw_ref text,
  PRIMARY KEY (id, started_at),
  -- FK ke tabel partisi wajib menyertakan kolom partisi (terbukti S-08)
  FOREIGN KEY (crawl_run_id, crawl_run_scheduled_for) REFERENCES crawl_runs (id, scheduled_for) ON DELETE CASCADE
) PARTITION BY RANGE (started_at);
CREATE INDEX provider_attempts_run_idx ON provider_attempts (crawl_run_id);

CREATE TABLE cost_allocations (
  run_id uuid NOT NULL,
  run_scheduled_for timestamptz NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  cost_units numeric NOT NULL CHECK (cost_units >= 0),
  basis text NOT NULL CHECK (basis IN ('matches', 'even_split')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, tenant_id),
  FOREIGN KEY (run_id, run_scheduled_for) REFERENCES crawl_runs (id, scheduled_for) ON DELETE CASCADE
);
