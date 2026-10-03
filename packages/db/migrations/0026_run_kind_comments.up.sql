-- Run pengambilan komentar dari post teratas topik (permintaan pemilik 2026-10-03). Pemilik run = plan topik (biaya & tenant
-- ikut topik); target = refresh_target {platform, post_ids}; komentar langsung ditautkan ke topik induk (tanpa cocok keyword).
ALTER TYPE e_run_kind ADD VALUE IF NOT EXISTS 'comments';
