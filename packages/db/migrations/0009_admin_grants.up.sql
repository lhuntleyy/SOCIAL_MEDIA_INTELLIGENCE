-- F-10 · grant minimal untuk admin tenant/user/API key (API_SPEC §10)
-- users global TANPA RLS sebelumnya → smip_app bisa membaca email/nama SELURUH user platform (bocor lintas tenant).
-- Kini: role aplikasi hanya melihat user yang punya membership di tenant konteks (subquery tunduk RLS memberships).
-- Undangan (butuh cari user lintas tenant) berjalan sebagai smip_system SETELAH otorisasi admin tenant di aplikasi.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_same_tenant ON users FOR SELECT USING (EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id));
-- jalur auth: verifikasi API key lintas tenant (sebelum konteks tenant ada) + terima undangan
GRANT SELECT, UPDATE (last_used_at) ON api_keys TO smip_auth;
GRANT UPDATE (status) ON users TO smip_auth;
-- satu owner terakhir tidak boleh dicabut/diturunkan (dicek juga di aplikasi; trigger = jaring pengaman)
CREATE FUNCTION smip_keep_last_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.role = 'owner' AND (TG_OP = 'DELETE' OR NEW.role <> 'owner') AND NOT EXISTS (
    SELECT 1 FROM memberships m WHERE m.tenant_id = OLD.tenant_id AND m.role = 'owner' AND m.user_id <> OLD.user_id
  ) AND EXISTS (SELECT 1 FROM tenants t WHERE t.id = OLD.tenant_id) THEN
    RAISE EXCEPTION 'tenant % harus punya minimal satu owner', OLD.tenant_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER memberships_keep_last_owner BEFORE UPDATE OR DELETE ON memberships FOR EACH ROW EXECUTE FUNCTION smip_keep_last_owner();
