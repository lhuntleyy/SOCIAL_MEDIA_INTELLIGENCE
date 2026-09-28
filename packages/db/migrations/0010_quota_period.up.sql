-- I-09: quota harian & bulanan pada unit yang sama bertabrakan di tanggal 1 (period_start sama = YYYY-MM-01)
-- → `period` masuk primary key quota_usage.
ALTER TABLE quota_usage ADD COLUMN period e_period NOT NULL DEFAULT 'day';
ALTER TABLE quota_usage DROP CONSTRAINT quota_usage_pkey;
ALTER TABLE quota_usage ADD PRIMARY KEY (scope_type, scope_id, period, period_start, unit);
