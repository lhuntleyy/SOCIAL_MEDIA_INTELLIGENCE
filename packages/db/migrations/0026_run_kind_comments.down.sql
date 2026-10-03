-- nilai enum Postgres tidak bisa dihapus tanpa membuat ulang tipe; run 'comments' dihapus agar aman dibiarkan.
DELETE FROM crawl_runs WHERE kind = 'comments';
