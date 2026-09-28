DROP TRIGGER IF EXISTS memberships_keep_last_owner ON memberships;
DROP FUNCTION IF EXISTS smip_keep_last_owner();
REVOKE UPDATE (status) ON users FROM smip_auth;
REVOKE SELECT, UPDATE (last_used_at) ON api_keys FROM smip_auth;
DROP POLICY IF EXISTS users_same_tenant ON users;
ALTER TABLE users NO FORCE ROW LEVEL SECURITY;
ALTER TABLE users DISABLE ROW LEVEL SECURITY;
