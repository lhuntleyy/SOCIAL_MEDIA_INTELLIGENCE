-- Fase 3 (A-03): pengaturan LLM dari panel admin — provider bisa diganti tanpa deploy (AI_SPEC §4.5 LlmProvider).
-- kind = protokol API: gemini (Generative Language API), openai_compatible (OpenAI, OpenRouter, vLLM/Ollama/custom), anthropic.
CREATE TABLE llm_providers (
  id uuid PRIMARY KEY,
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('gemini', 'openai_compatible', 'anthropic')),
  base_url text,                                   -- wajib untuk openai_compatible (SSRF guard saat disimpan)
  enabled boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}',              -- header ekstra non-rahasia, dsb.
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'openai_compatible' OR base_url IS NOT NULL)
);

-- Banyak API key per provider (rotasi round-robin, cooldown saat 429/quota). Secret di `credentials` (envelope, write-only).
CREATE TABLE llm_api_keys (
  id uuid PRIMARY KEY,
  provider_id uuid NOT NULL REFERENCES llm_providers (id) ON DELETE CASCADE,
  label text NOT NULL,
  credential_id uuid NOT NULL UNIQUE REFERENCES credentials (id),
  display_hint text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'invalid', 'revoked')),
  cooldown_until timestamptz,
  last_error_code text,
  last_used_at timestamptz,
  requests_total bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, label)
);
CREATE INDEX llm_api_keys_provider_idx ON llm_api_keys (provider_id) WHERE status = 'active';

-- Katalog model hasil "Refresh model" (daftar dari API provider) — pilihan dropdown di panel.
CREATE TABLE llm_models (
  provider_id uuid NOT NULL REFERENCES llm_providers (id) ON DELETE CASCADE,
  model_id text NOT NULL,
  display_name text,
  input_token_limit int,
  output_token_limit int,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, model_id)
);

-- Tugas NLP → provider/model (+ cadangan). `default` dipakai tugas tanpa baris sendiri.
CREATE TABLE llm_task_settings (
  task text PRIMARY KEY CHECK (task IN ('default', 'sentiment', 'emotion', 'keyphrase', 'summary')),
  provider_id uuid REFERENCES llm_providers (id) ON DELETE SET NULL,
  model_id text,
  fallback_provider_id uuid REFERENCES llm_providers (id) ON DELETE SET NULL,
  fallback_model_id text,
  enabled boolean NOT NULL DEFAULT true,
  params jsonb NOT NULL DEFAULT '{}',              -- max_output_tokens, batch_size, rpm, …
  version int NOT NULL DEFAULT 1,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON llm_providers, llm_api_keys, llm_models, llm_task_settings TO smip_system;
