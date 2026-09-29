ALTER TABLE memberships DISABLE TRIGGER memberships_keep_last_owner;
DELETE FROM memberships WHERE tenant_id IN (SELECT id FROM tenants WHERE kind = 'platform');
ALTER TABLE memberships ENABLE TRIGGER memberships_keep_last_owner;
DELETE FROM tenants WHERE kind = 'platform';
DROP INDEX IF EXISTS tenants_one_platform;
ALTER TABLE tenants DROP COLUMN IF EXISTS kind;
