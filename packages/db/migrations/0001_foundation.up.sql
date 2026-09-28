-- F-04 · fondasi: ekstensi, role grup, fungsi konteks tenant, enum (DATA_MODEL konvensi: enum diawali e_)
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Role GRUP (NOLOGIN) level cluster — user login dibuat ops & diberi membership (DEPLOYMENT §5: role berbeda per service).
-- Tidak dihapus oleh down (cluster-wide, bisa dipakai database lain).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'smip_app') THEN CREATE ROLE smip_app NOLOGIN NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'smip_system') THEN CREATE ROLE smip_system NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'smip_py_reader') THEN CREATE ROLE smip_py_reader NOLOGIN BYPASSRLS; END IF;
END $$;

-- Konteks tenant transaksi: set via SELECT set_config('app.tenant_id', $1, true) (S-08).
-- nullif wajib: di koneksi pool nilai kembali '' (bukan NULL) setelah transaksi → cast uuid gagal.
CREATE FUNCTION smip_current_tenant() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE TYPE e_tenant_status AS ENUM ('active', 'suspended', 'closed');
CREATE TYPE e_user_status AS ENUM ('active', 'disabled', 'invited');
CREATE TYPE e_role AS ENUM ('owner', 'admin', 'analyst', 'viewer');
CREATE TYPE e_taxonomy_type AS ENUM ('interest', 'industry');
CREATE TYPE e_topic_status AS ENUM ('active', 'paused', 'archived');
CREATE TYPE e_query_kind AS ENUM ('main', 'sub');
CREATE TYPE e_plan_status AS ENUM ('active', 'paused', 'error_backoff', 'disabled');
CREATE TYPE e_run_kind AS ENUM ('incremental', 'backfill', 'engagement_refresh', 'verify');
CREATE TYPE e_run_status AS ENUM ('queued', 'dispatching', 'fetching', 'processing', 'succeeded', 'partial', 'failed', 'skipped', 'cancelled');
CREATE TYPE e_attempt_outcome AS ENUM ('success', 'retryable_error', 'failover_error', 'fatal_error');
CREATE TYPE e_provider_kind AS ENUM ('official', 'third_party', 'unofficial');
CREATE TYPE e_risk AS ENUM ('low', 'medium', 'high');
CREATE TYPE e_runtime AS ENUM ('bun', 'python');
CREATE TYPE e_verify_status AS ENUM ('declared', 'verified', 'failed', 'deprecated');
CREATE TYPE e_cred_kind AS ENUM ('api_key', 'oauth2', 'session', 'basic', 'cookie_jar');
CREATE TYPE e_account_status AS ENUM ('active', 'disabled', 'cooling_down', 'needs_attention', 'revoked');
CREATE TYPE e_strategy AS ENUM ('priority_weighted', 'round_robin', 'cost_aware');
CREATE TYPE e_scope AS ENUM ('provider', 'connector', 'provider_account');
CREATE TYPE e_rl_algo AS ENUM ('token_bucket', 'fixed_window', 'concurrency');
CREATE TYPE e_fact_source AS ENUM ('provider_docs', 'provider_header', 'observed', 'internal_safety');
CREATE TYPE e_quota_scope AS ENUM ('global', 'tenant', 'topic', 'provider', 'connector', 'provider_account');
CREATE TYPE e_period AS ENUM ('day', 'month');
CREATE TYPE e_unit AS ENUM ('requests', 'results', 'cost_units');
CREATE TYPE e_health AS ENUM ('healthy', 'degraded', 'unhealthy', 'unknown');
CREATE TYPE e_circuit AS ENUM ('closed', 'open', 'half_open');
CREATE TYPE e_model_task AS ENUM ('sentiment', 'emotion', 'gender', 'age_range', 'keyphrase', 'lang', 'geo', 'llm_fallback');
CREATE TYPE e_model_status AS ENUM ('candidate', 'active', 'retired');
CREATE TYPE e_alert_type AS ENUM ('volume_spike', 'negative_ratio', 'new_issue', 'provider_unhealthy', 'quota_threshold');
CREATE TYPE e_alert_status AS ENUM ('open', 'acked', 'resolved');
CREATE TYPE e_channel_kind AS ENUM ('email', 'webhook', 'telegram');
CREATE TYPE e_export_kind AS ENUM ('csv', 'xlsx');
CREATE TYPE e_export_status AS ENUM ('queued', 'running', 'done', 'failed', 'expired');
CREATE TYPE e_actor_type AS ENUM ('user', 'api_key', 'system');
CREATE TYPE e_label_source AS ENUM ('model', 'llm', 'human');
