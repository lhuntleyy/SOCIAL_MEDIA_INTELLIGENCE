-- Menu Akun (pantau akun): topik berjenis `account` — query = `@username` per akun per platform, operation user_timeline.
-- Analitik (sentimen, emosi, isu, …) sama dengan topik keyword; pemisahan menu lewat kolom ini.
ALTER TABLE topics ADD COLUMN kind text NOT NULL DEFAULT 'topic' CHECK (kind IN ('topic', 'account'));
