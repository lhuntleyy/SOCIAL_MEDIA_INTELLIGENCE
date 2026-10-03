-- system_settings (0025) dibaca/ditulis worker & API lewat role smip_system (withSystem); GRANT ALL TABLES di 0007
-- tidak berlaku untuk tabel yang dibuat sesudahnya.
GRANT SELECT, INSERT, UPDATE, DELETE ON system_settings TO smip_system;
