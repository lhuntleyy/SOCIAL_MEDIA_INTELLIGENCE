REVOKE ALL ON users, refresh_tokens, memberships, tenants, audit_logs FROM smip_auth;
REVOKE ALL ON FUNCTION smip_current_tenant() FROM smip_auth;
REVOKE USAGE ON SCHEMA public FROM smip_auth;
ALTER TABLE refresh_tokens DROP COLUMN IF EXISTS tenant_id;
