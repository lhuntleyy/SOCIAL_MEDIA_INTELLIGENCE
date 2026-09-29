-- Owner platform (pemilik/administrator SMIP) TIDAK berada di kantor mana pun: mereka punya "kantor" internal
-- (kind = 'platform') sebagai rumah sesi (token butuh tenant), disembunyikan dari daftar kantor. Data kantor lain
-- dilihat lewat impersonasi yang diaudit (SECURITY §3).
ALTER TABLE tenants ADD COLUMN kind text NOT NULL DEFAULT 'office' CHECK (kind IN ('office', 'platform'));
CREATE UNIQUE INDEX tenants_one_platform ON tenants (kind) WHERE kind = 'platform';

INSERT INTO tenants (id, slug, name, kind)
VALUES ('00000000-0000-7000-8000-00000000f000', 'smip-platform', 'Platform (owner)', 'platform')
ON CONFLICT DO NOTHING;

-- operator yang sudah ada → anggota tenant platform sebagai owner (keanggotaan kantor lama tidak diubah)
INSERT INTO memberships (tenant_id, user_id, role)
SELECT '00000000-0000-7000-8000-00000000f000', u.id, 'owner' FROM users u WHERE u.is_platform_operator
ON CONFLICT DO NOTHING;
