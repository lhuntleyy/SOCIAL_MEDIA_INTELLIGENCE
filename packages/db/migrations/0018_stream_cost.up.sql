-- I-25: atribusi biaya run collection stream (ADR-009 amandemen, DATA_MODEL §3.11, P-20).
ALTER TABLE crawl_runs ADD COLUMN tenant_matches jsonb NOT NULL DEFAULT '{}';  -- {tenant_id: jumlah match baru} (run stream)
ALTER TABLE cost_allocations
  ADD COLUMN requests numeric NOT NULL DEFAULT 0 CHECK (requests >= 0),
  ADD COLUMN results numeric NOT NULL DEFAULT 0 CHECK (results >= 0),
  ADD COLUMN matches int NOT NULL DEFAULT 0,
  ADD COLUMN applied_at timestamptz;          -- diterapkan ke counter quota tenant (Redis) — worker-dispatch
CREATE INDEX cost_allocations_unapplied_idx ON cost_allocations (created_at) WHERE applied_at IS NULL;
