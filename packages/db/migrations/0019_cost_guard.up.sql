-- I-23: cost guard soft cap (COST_MODEL §8, CONNECTOR_SPEC §11). Soft quota tercapai → scheduler throttle interval (bukan stop).
-- throttled_since = penanda transisi (alert sekali saat mulai / berakhir), diisi scheduler; NULL = tidak sedang throttle.
ALTER TABLE quota_policies ADD COLUMN throttled_since timestamptz;
