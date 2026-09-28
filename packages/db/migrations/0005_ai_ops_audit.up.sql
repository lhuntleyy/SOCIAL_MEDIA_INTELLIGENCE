-- F-04 · DATA_MODEL §5 AI, alert, export, audit, geo, korpus training
CREATE TABLE model_versions (
  id uuid PRIMARY KEY,
  task e_model_task NOT NULL,
  name text NOT NULL,
  version text NOT NULL,
  artifact_uri text,
  config jsonb NOT NULL DEFAULT '{}',        -- τ, prompt version, dll
  metrics jsonb NOT NULL DEFAULT '{}',       -- macro_f1, per_class, eval_set_id, coverage
  status e_model_status NOT NULL DEFAULT 'candidate',
  activated_at timestamptz,
  activated_by uuid REFERENCES users (id),
  UNIQUE (task, name, version)
);
CREATE UNIQUE INDEX model_versions_one_active ON model_versions (task) WHERE status = 'active';

CREATE TABLE sentiment_overrides (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  topic_id uuid NOT NULL REFERENCES topics (id) ON DELETE CASCADE,
  platform text NOT NULL,
  post_id text NOT NULL,
  previous_label text NOT NULL,
  new_label text NOT NULL CHECK (new_label IN ('negative', 'neutral', 'positive')),
  previous_model_version text,
  user_id uuid NOT NULL REFERENCES users (id),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sentiment_overrides_post_idx ON sentiment_overrides (tenant_id, topic_id, platform, post_id);

CREATE TABLE eval_sets (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE,
  task e_model_task NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE eval_items (
  id uuid PRIMARY KEY,
  eval_set_id uuid NOT NULL REFERENCES eval_sets (id) ON DELETE CASCADE,
  text text NOT NULL,
  label text NOT NULL,
  annotator_ids uuid[] NOT NULL DEFAULT '{}',
  agreement real,
  source_post_ref text
);

CREATE TABLE notification_channels (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  kind e_channel_kind NOT NULL,
  config jsonb NOT NULL DEFAULT '{}',        -- non-rahasia
  credential_id uuid REFERENCES credentials (id),
  enabled boolean NOT NULL DEFAULT true
);

CREATE TABLE alert_rules (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  topic_id uuid REFERENCES topics (id) ON DELETE CASCADE,
  type e_alert_type NOT NULL,
  params jsonb NOT NULL,
  channels uuid[] NOT NULL DEFAULT '{}',
  cooldown_sec int NOT NULL DEFAULT 3600 CHECK (cooldown_sec >= 0),
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE alert_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  rule_id uuid NOT NULL REFERENCES alert_rules (id) ON DELETE CASCADE,
  fired_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL,
  status e_alert_status NOT NULL DEFAULT 'open',
  acked_by uuid REFERENCES users (id),
  resolved_at timestamptz
);
CREATE INDEX alert_events_open_idx ON alert_events (tenant_id, status) WHERE status <> 'resolved';

CREATE TABLE exports (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  requested_by uuid REFERENCES users (id),
  kind e_export_kind NOT NULL,
  params jsonb NOT NULL,
  status e_export_status NOT NULL DEFAULT 'queued',
  file_uri text,
  row_count int,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Audit append-only (SECURITY §8): partisi bulanan + trigger menolak UPDATE/DELETE (DROP PARTITION untuk retensi tetap bisa).
CREATE TABLE audit_logs (
  id uuid NOT NULL,
  tenant_id uuid,
  actor_type e_actor_type NOT NULL,
  actor_id uuid,
  action text NOT NULL,
  target_type text,
  target_id text,
  before jsonb,                               -- sudah di-redact
  after jsonb,
  ip inet,
  user_agent text,
  request_id text,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, at)
) PARTITION BY RANGE (at);
CREATE INDEX audit_logs_target_idx ON audit_logs (target_type, target_id, at DESC);

CREATE FUNCTION smip_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN RAISE EXCEPTION 'audit_logs append-only: % ditolak', TG_OP USING ERRCODE = 'insufficient_privilege'; END $$;
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION smip_reject_mutation();

CREATE TABLE geo_regions (
  code text PRIMARY KEY,                      -- kode wilayah Kemendagri/BPS
  level text NOT NULL CHECK (level IN ('province', 'regency')),
  name text NOT NULL,
  parent_code text REFERENCES geo_regions (code),
  aliases text[] NOT NULL DEFAULT '{}',
  centroid point
);
CREATE INDEX geo_regions_aliases_idx ON geo_regions USING gin (aliases);

-- Korpus training (AI_SPEC §14): append-only, TANPA FK ke posts (post kena retensi, label tetap hidup).
-- Teks di s3://smip-training/ (bukan raw 30 hari). below_18 tidak pernah ditulis sebagai label (ADR-007).
CREATE TABLE nlp_labels (
  id uuid NOT NULL,
  platform text NOT NULL,
  post_id text NOT NULL,
  task e_model_task NOT NULL,
  text_ref text NOT NULL CHECK (text_ref LIKE 's3://%training%'),
  label text NOT NULL CHECK (label <> 'below_18'),
  confidence real CHECK (confidence BETWEEN 0 AND 1),
  source e_label_source NOT NULL,
  model_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX nlp_labels_export_idx ON nlp_labels (model_version, created_at);
