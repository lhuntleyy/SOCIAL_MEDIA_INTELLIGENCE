DROP TYPE IF EXISTS e_label_source, e_actor_type, e_export_status, e_export_kind, e_channel_kind, e_alert_status, e_alert_type,
  e_model_status, e_model_task, e_circuit, e_health, e_unit, e_period, e_quota_scope, e_fact_source, e_rl_algo, e_scope,
  e_strategy, e_account_status, e_cred_kind, e_verify_status, e_runtime, e_risk, e_provider_kind, e_attempt_outcome,
  e_run_status, e_run_kind, e_plan_status, e_query_kind, e_topic_status, e_taxonomy_type, e_role, e_user_status, e_tenant_status;
DROP FUNCTION IF EXISTS smip_current_tenant();
-- role grup sengaja tidak di-drop (level cluster)
DROP EXTENSION IF EXISTS pg_trgm;
DROP EXTENSION IF EXISTS citext;
