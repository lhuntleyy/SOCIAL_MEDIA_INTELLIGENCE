-- F-04 · partisi bulanan untuk crawl_runs, provider_attempts, health_checks, audit_logs, nlp_labels.
-- Job retention (H-04) memanggil fungsi ini tiap hari untuk bulan-bulan ke depan dan DROP partisi kedaluwarsa.
-- Partisi DEFAULT = jaring pengaman: insert di luar rentang tidak gagal; isinya dipantau (harus kosong).
CREATE FUNCTION smip_ensure_monthly_partitions(parent regclass, from_month date, months int) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  m date := date_trunc('month', from_month)::date;
  created int := 0;
  pname text;
  base text := split_part(parent::text, '.', array_length(string_to_array(parent::text, '.'), 1));
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
                 WHERE i.inhparent = parent AND c.relname = base || '_default') THEN
    EXECUTE format('CREATE TABLE %I PARTITION OF %s DEFAULT', base || '_default', parent);
  END IF;
  FOR i IN 0 .. months - 1 LOOP
    pname := format('%s_y%sm%s', base, to_char(m, 'YYYY'), to_char(m, 'MM'));
    IF to_regclass(pname) IS NULL THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)', pname, parent, m, (m + interval '1 month')::date);
      created := created + 1;
    END IF;
    m := (m + interval '1 month')::date;
  END LOOP;
  RETURN created;
END $$;

SELECT smip_ensure_monthly_partitions(t::regclass, (date_trunc('month', now()) - interval '1 month')::date, 4)
FROM unnest(ARRAY['crawl_runs', 'provider_attempts', 'health_checks', 'audit_logs', 'nlp_labels']) AS t;
