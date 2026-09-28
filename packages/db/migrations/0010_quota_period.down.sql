ALTER TABLE quota_usage DROP CONSTRAINT quota_usage_pkey;
DELETE FROM quota_usage WHERE period = 'month';
ALTER TABLE quota_usage ADD PRIMARY KEY (scope_type, scope_id, period_start, unit);
ALTER TABLE quota_usage DROP COLUMN period;
