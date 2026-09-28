-- F-04 · DATA_MODEL §4 provider management
CREATE TABLE providers (
  id uuid PRIMARY KEY,
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  name text NOT NULL,
  kind e_provider_kind NOT NULL,
  risk_level e_risk NOT NULL,
  enabled boolean NOT NULL DEFAULT false,     -- master switch; kill-switch RUNBOOK §10
  docs_url text,
  tos_url text,
  pricing_url text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT providers_unofficial_high_risk CHECK (kind <> 'unofficial' OR risk_level = 'high')
);

CREATE TABLE connectors (
  id uuid PRIMARY KEY,
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*(\.[a-z0-9_]+)?$'),  -- provider.platform[.varian]
  provider_id uuid NOT NULL REFERENCES providers (id),
  platform_code text NOT NULL REFERENCES platforms (code),
  runtime e_runtime NOT NULL,
  version text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  config jsonb NOT NULL DEFAULT '{}',
  config_schema jsonb NOT NULL DEFAULT '{}',
  manifest_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE connector_capabilities (
  connector_id uuid NOT NULL REFERENCES connectors (id) ON DELETE CASCADE,
  operation text NOT NULL,
  declared jsonb NOT NULL,
  measured jsonb NOT NULL DEFAULT '{}',   -- p50/p95, min_interval_sec, fixed_cost_per_run, sample_size
  status e_verify_status NOT NULL DEFAULT 'declared',
  verified_at timestamptz,
  evidence_ref text,
  PRIMARY KEY (connector_id, operation),
  CONSTRAINT capabilities_verified_evidence CHECK (status <> 'verified' OR (verified_at IS NOT NULL AND evidence_ref IS NOT NULL))
);

CREATE TABLE credentials (
  id uuid PRIMARY KEY,
  tenant_id uuid REFERENCES tenants (id) ON DELETE CASCADE,  -- NULL = milik operator
  kind e_cred_kind NOT NULL,
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL CHECK (octet_length(iv) = 12),
  wrapped_dek bytea,                                        -- NULL = crypto-shredded (revoke)
  kek_id text NOT NULL,
  aad text NOT NULL,
  fingerprint bytea NOT NULL,
  expires_at timestamptz,
  rotated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users (id)
);

CREATE TABLE provider_accounts (
  id uuid PRIMARY KEY,
  tenant_id uuid REFERENCES tenants (id) ON DELETE CASCADE,  -- NULL = shared pool
  provider_id uuid NOT NULL REFERENCES providers (id),
  label text NOT NULL,
  credential_id uuid NOT NULL UNIQUE REFERENCES credentials (id),
  display_hint text,
  status e_account_status NOT NULL DEFAULT 'active',
  cooldown_until timestamptz,
  attention_reason text,
  allowed_connector_ids uuid[],
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE routing_policies (
  id uuid PRIMARY KEY,
  tenant_id uuid REFERENCES tenants (id) ON DELETE CASCADE,  -- NULL = default global
  platform_code text NOT NULL REFERENCES platforms (code),
  operation text NOT NULL,
  strategy e_strategy NOT NULL DEFAULT 'priority_weighted',
  failover_enabled boolean NOT NULL DEFAULT true,
  max_attempts smallint NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  allow_unverified boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  version int NOT NULL DEFAULT 1,
  updated_by uuid REFERENCES users (id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX routing_policies_uniq ON routing_policies (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'), platform_code, operation);

CREATE TABLE routing_rules (
  id uuid PRIMARY KEY,
  policy_id uuid NOT NULL REFERENCES routing_policies (id) ON DELETE CASCADE,
  connector_id uuid NOT NULL REFERENCES connectors (id),
  priority smallint NOT NULL CHECK (priority >= 1),
  weight int NOT NULL CHECK (weight BETWEEN 0 AND 1000),
  enabled boolean NOT NULL DEFAULT false,
  max_share_pct smallint CHECK (max_share_pct BETWEEN 1 AND 100),
  conditions jsonb NOT NULL DEFAULT '{}',
  UNIQUE (policy_id, connector_id)
);

CREATE TABLE rate_limit_policies (
  id uuid PRIMARY KEY,
  scope_type e_scope NOT NULL,
  scope_id uuid NOT NULL,
  algorithm e_rl_algo NOT NULL,
  capacity int NOT NULL CHECK (capacity > 0),
  refill_tokens int NOT NULL CHECK (refill_tokens >= 0),
  refill_interval_ms int NOT NULL CHECK (refill_interval_ms > 0),
  source e_fact_source NOT NULL,
  source_ref text NOT NULL,                 -- Golden Rule 1: tanpa sumber = tidak boleh ada
  verified_at timestamptz,
  enabled boolean NOT NULL DEFAULT true
);

CREATE TABLE quota_policies (
  id uuid PRIMARY KEY,
  scope_type e_quota_scope NOT NULL,
  scope_id uuid,                            -- NULL hanya untuk scope global
  period e_period NOT NULL,
  unit e_unit NOT NULL,
  limit_value numeric NOT NULL CHECK (limit_value >= 0),
  hard boolean NOT NULL,                    -- hard → skip; soft → throttle (COST_MODEL §8)
  alert_thresholds smallint[] NOT NULL DEFAULT '{50,80,95}',
  reset_tz text NOT NULL DEFAULT 'UTC',
  enabled boolean NOT NULL DEFAULT true,
  CONSTRAINT quota_scope_id_ck CHECK ((scope_type = 'global') = (scope_id IS NULL))
);

CREATE TABLE quota_usage (
  scope_type e_quota_scope NOT NULL,
  scope_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  period_start date NOT NULL,
  unit e_unit NOT NULL,
  used numeric NOT NULL DEFAULT 0,
  reserved numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_type, scope_id, period_start, unit)
);

CREATE TABLE provider_health (
  connector_id uuid NOT NULL REFERENCES connectors (id) ON DELETE CASCADE,
  provider_account_key uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  state e_health NOT NULL DEFAULT 'unknown',
  circuit e_circuit NOT NULL DEFAULT 'closed',
  score smallint CHECK (score BETWEEN 0 AND 100),
  success_rate_5m real,
  p95_latency_ms int,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error_code text,
  opened_at timestamptz,
  next_probe_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connector_id, provider_account_key)
);

CREATE TABLE health_checks (
  id uuid NOT NULL,
  connector_id uuid NOT NULL,
  provider_account_id uuid,
  kind text NOT NULL CHECK (kind IN ('active', 'passive_window')),
  at timestamptz NOT NULL,
  ok boolean NOT NULL,
  latency_ms int,
  error_code text,
  details jsonb,
  PRIMARY KEY (id, at)
) PARTITION BY RANGE (at);

CREATE TABLE outbox (
  id bigserial PRIMARY KEY,
  aggregate text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
