-- I-03: optimistic locking resource config (API_SPEC §1.3 `If-Match: "<version>"`) — topics belum punya kolom version.
ALTER TABLE topics ADD COLUMN version int NOT NULL DEFAULT 1;
