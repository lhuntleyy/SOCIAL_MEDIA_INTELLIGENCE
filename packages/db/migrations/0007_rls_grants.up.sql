-- F-04 · Row Level Security + grant (ARCHITECTURE §8, SECURITY §3/§6, TESTING SEC-01)
-- smip_app     : API per tenant, NOBYPASSRLS — konteks via set_config('app.tenant_id', $1, true)
-- smip_system  : scheduler/worker/operator, BYPASSRLS
-- smip_py_reader: worker-fetch-py, BYPASSRLS, hanya SELECT provider_accounts/credentials/connectors
DO $$
DECLARE t text;
BEGIN
  -- tenant_id wajib = tenant konteks (baca & tulis)
  FOREACH t IN ARRAY ARRAY['memberships', 'api_keys', 'topics', 'topic_taxonomies', 'topic_queries', 'topic_platforms',
    'crawl_plans', 'stream_topic_links', 'cost_allocations', 'sentiment_overrides', 'notification_channels',
    'alert_rules', 'alert_events', 'exports',
    -- tenant_id nullable tetapi baris NULL (shared/operator/system) TIDAK terlihat oleh tenant
    'crawl_runs', 'provider_attempts', 'credentials', 'provider_accounts']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = smip_current_tenant()) WITH CHECK (tenant_id = smip_current_tenant())', t);
  END LOOP;

  -- baris global (tenant_id NULL) boleh DIBACA tenant, tapi hanya baris miliknya yang boleh ditulis
  FOREACH t IN ARRAY ARRAY['taxonomies', 'routing_policies'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY read_own_or_global ON %I FOR SELECT USING (tenant_id = smip_current_tenant() OR tenant_id IS NULL)', t);
    EXECUTE format('CREATE POLICY write_own ON %I FOR ALL USING (tenant_id = smip_current_tenant()) WITH CHECK (tenant_id = smip_current_tenant())', t);
  END LOOP;
END $$;

-- routing_rules tidak punya tenant_id: ikut visibilitas policy induknya (subquery tunduk RLS routing_policies)
ALTER TABLE routing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY via_policy_read ON routing_rules FOR SELECT USING (EXISTS (SELECT 1 FROM routing_policies p WHERE p.id = policy_id));
CREATE POLICY via_policy_write ON routing_rules FOR ALL
  USING (EXISTS (SELECT 1 FROM routing_policies p WHERE p.id = policy_id AND p.tenant_id = smip_current_tenant()))
  WITH CHECK (EXISTS (SELECT 1 FROM routing_policies p WHERE p.id = policy_id AND p.tenant_id = smip_current_tenant()));

-- tenants: tenant hanya melihat dirinya sendiri
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants FOR SELECT USING (id = smip_current_tenant());

-- audit: tenant hanya menambah & membaca miliknya
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_read_own ON audit_logs FOR SELECT USING (tenant_id = smip_current_tenant());
CREATE POLICY audit_insert_own ON audit_logs FOR INSERT WITH CHECK (tenant_id = smip_current_tenant());

-- ===== grant =====
GRANT USAGE ON SCHEMA public TO smip_app, smip_system, smip_py_reader;
GRANT EXECUTE ON FUNCTION smip_current_tenant() TO smip_app, smip_system, smip_py_reader;

GRANT SELECT, INSERT, UPDATE, DELETE ON memberships, api_keys, taxonomies, topics, topic_taxonomies, topic_queries,
  topic_platforms, crawl_plans, sentiment_overrides, notification_channels, alert_rules, alert_events, exports,
  routing_policies, routing_rules, credentials, provider_accounts TO smip_app;
GRANT SELECT ON crawl_runs, provider_attempts, stream_topic_links, cost_allocations TO smip_app;
GRANT SELECT, INSERT ON audit_logs TO smip_app;
-- tabel global/registry: baca saja
GRANT SELECT ON plans, tenants, platforms, providers, connectors, connector_capabilities, model_versions, geo_regions, provider_health TO smip_app;
-- users: kolom rahasia (password_hash, mfa_secret_enc) TIDAK pernah bisa dibaca role aplikasi
GRANT SELECT (id, email, name, is_platform_operator, status, last_login_at, created_at, updated_at) ON users TO smip_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO smip_system;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO smip_system;
REVOKE UPDATE, DELETE ON audit_logs FROM smip_system;   -- append-only juga untuk role sistem
REVOKE UPDATE ON nlp_labels FROM smip_system;           -- label tidak diubah; DELETE tetap untuk permintaan penghapusan konten (DATA_MODEL §9)
GRANT EXECUTE ON FUNCTION smip_ensure_monthly_partitions(regclass, date, int) TO smip_system;

GRANT SELECT ON provider_accounts, credentials, connectors TO smip_py_reader;
