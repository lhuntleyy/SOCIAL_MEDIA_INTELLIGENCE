-- partisi ikut terhapus saat tabel induk di-drop (migrasi 0003–0005 down)
DROP FUNCTION IF EXISTS smip_ensure_monthly_partitions(regclass, date, int);
