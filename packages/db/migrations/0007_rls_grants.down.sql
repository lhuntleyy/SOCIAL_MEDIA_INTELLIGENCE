DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['memberships', 'api_keys', 'topics', 'topic_taxonomies', 'topic_queries', 'topic_platforms',
    'crawl_plans', 'stream_topic_links', 'cost_allocations', 'sentiment_overrides', 'notification_channels',
    'alert_rules', 'alert_events', 'exports', 'crawl_runs', 'provider_attempts', 'credentials', 'provider_accounts']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['taxonomies', 'routing_policies'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS read_own_or_global ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS write_own ON %I', t);
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
DROP POLICY IF EXISTS via_policy_read ON routing_rules;
DROP POLICY IF EXISTS via_policy_write ON routing_rules;
ALTER TABLE routing_rules NO FORCE ROW LEVEL SECURITY;
ALTER TABLE routing_rules DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_self ON tenants;
ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;
ALTER TABLE tenants DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_read_own ON audit_logs;
DROP POLICY IF EXISTS audit_insert_own ON audit_logs;
ALTER TABLE audit_logs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_logs DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM smip_app, smip_system, smip_py_reader;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM smip_system;
REVOKE ALL ON FUNCTION smip_current_tenant() FROM smip_app, smip_system, smip_py_reader;
REVOKE ALL ON FUNCTION smip_ensure_monthly_partitions(regclass, date, int) FROM smip_system;
REVOKE USAGE ON SCHEMA public FROM smip_app, smip_system, smip_py_reader;
