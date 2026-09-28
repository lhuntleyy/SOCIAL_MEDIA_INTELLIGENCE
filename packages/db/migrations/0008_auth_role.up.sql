-- F-09 · role sempit untuk autentikasi (SECURITY §2): hanya jalur login/refresh/MFA yang boleh membaca hash password.
-- Login user API di produksi: NOINHERIT + member smip_app & smip_auth; tiap transaksi memilih role via SET LOCAL ROLE.
-- tenant yang dipilih saat login ikut dirotasi bersama refresh token (access token hasil refresh butuh tid)
ALTER TABLE refresh_tokens ADD COLUMN tenant_id uuid REFERENCES tenants (id) ON DELETE CASCADE;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'smip_auth') THEN CREATE ROLE smip_auth NOLOGIN BYPASSRLS; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO smip_auth;
GRANT SELECT, UPDATE (password_hash, mfa_secret_enc, last_login_at, updated_at) ON users TO smip_auth;
GRANT SELECT ON users TO smip_auth;
GRANT SELECT, INSERT, UPDATE ON refresh_tokens TO smip_auth;
GRANT SELECT ON memberships, tenants TO smip_auth;
GRANT INSERT ON audit_logs TO smip_auth;
GRANT EXECUTE ON FUNCTION smip_current_tenant() TO smip_auth;
