-- F-05 · DATA_MODEL §6.1–6.4, 6.6 — konten global & stream event ber-sign
CREATE TABLE posts (
  platform LowCardinality(String),
  post_id String,
  content_type LowCardinality(String),
  parent_post_id Nullable(String),
  root_post_id Nullable(String),
  parent_author_id Nullable(String),
  parent_author_handle Nullable(String),
  url Nullable(String),
  text String,
  lang LowCardinality(String),
  published_at DateTime64(3, 'UTC'),
  author_id String,
  author_handle String,
  author_name Nullable(String),
  author_created_at Nullable(DateTime('UTC')),
  author_followers Nullable(UInt64),
  author_verified Nullable(UInt8),
  author_location_raw Nullable(String),
  hashtags Array(String),
  mentions Array(String),
  media String,
  geo_region_code Nullable(String),
  geo_confidence Nullable(Float32),
  is_ad Nullable(UInt8),
  matched UInt8,                           -- 0 = tidak cocok topic mana pun (retensi unmatched_posts_retention_days, DATA_MODEL §9)
  source_connector LowCardinality(String),
  raw_ref String,
  ingested_at DateTime64(3, 'UTC'),
  version UInt64
) ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(published_at)
ORDER BY (platform, post_id)
SETTINGS non_replicated_deduplication_window = 1000;

-- sumber semua agregat; override/reprocess/engagement = pasangan sign -1/+1
CREATE TABLE topic_match_events (
  tenant_id UUID,
  topic_id UUID,
  topic_query_id UUID,
  platform LowCardinality(String),
  post_id String,
  content_type LowCardinality(String),
  published_at DateTime64(3, 'UTC'),
  author_id String,
  author_handle String,
  author_created_year Nullable(UInt16),
  author_followers Nullable(UInt64),
  sentiment Enum8('negative' = -1, 'neutral' = 0, 'positive' = 1),
  sentiment_score Float32,
  emotion Enum8('unknown' = 0, 'anger' = 1, 'anticipation' = 2, 'disgust' = 3, 'trust' = 4, 'joy' = 5, 'sadness' = 6, 'surprise' = 7, 'fear' = 8),
  emotion_score Float32,
  -- label demografi SUDAH di-threshold τ oleh worker (conf < τ → 'unknown'); agregat tinggal menghitung
  author_gender Enum8('unknown' = 0, 'male' = 1, 'female' = 2),
  author_gender_conf Float32,
  author_age_range Enum8('unknown' = 0, 'below_18' = 1, '18_21' = 2, '22_30' = 3, '31_45' = 4, '46_55' = 5, 'above_55' = 6),
  author_age_conf Float32,
  model_version LowCardinality(String),
  issues Array(String),
  hashtags Array(String),
  parent_author_id Nullable(String),
  parent_author_handle Nullable(String),
  geo_region_code Nullable(String),
  media Array(Tuple(type LowCardinality(String), url String, thumb Nullable(String))),
  engagement UInt64,
  engagement_known UInt8,
  sign Int8,
  event_at DateTime64(3, 'UTC')
) ENGINE = MergeTree
PARTITION BY toYYYYMM(published_at)
ORDER BY (tenant_id, topic_id, published_at, platform, post_id)
SETTINGS non_replicated_deduplication_window = 1000;   -- WAJIB agar insert_deduplication_token berlaku (S-07)

-- state terkini untuk feed; published_at di sort key → FINAL 4× lebih cepat (S-07)
CREATE TABLE topic_matches (
  tenant_id UUID, topic_id UUID, topic_query_id UUID,
  platform LowCardinality(String), post_id String, content_type LowCardinality(String),
  published_at DateTime64(3, 'UTC'),
  author_id String, author_handle String,
  sentiment Enum8('negative' = -1, 'neutral' = 0, 'positive' = 1), sentiment_score Float32,
  emotion Enum8('unknown' = 0, 'anger' = 1, 'anticipation' = 2, 'disgust' = 3, 'trust' = 4, 'joy' = 5, 'sadness' = 6, 'surprise' = 7, 'fear' = 8),
  model_version LowCardinality(String),
  issues Array(String), hashtags Array(String),
  geo_region_code Nullable(String),
  engagement UInt64, engagement_known UInt8,
  event_at DateTime64(3, 'UTC')
) ENGINE = ReplacingMergeTree(event_at)
PARTITION BY toYYYYMM(published_at)
ORDER BY (tenant_id, topic_id, published_at, platform, post_id)
SETTINGS non_replicated_deduplication_window = 1000;  -- target MV: wajib agar dedup token menjangkau agregat (F-05)

CREATE MATERIALIZED VIEW mv_topic_matches TO topic_matches AS
SELECT tenant_id, topic_id, topic_query_id, platform, post_id, content_type, published_at, author_id, author_handle,
       sentiment, sentiment_score, emotion, model_version, issues, hashtags, geo_region_code, engagement, engagement_known, event_at
FROM topic_match_events WHERE sign = 1;

CREATE TABLE engagement_snapshots (
  platform LowCardinality(String), post_id String, captured_at DateTime64(3, 'UTC'),
  likes Nullable(UInt64), comments Nullable(UInt64), shares Nullable(UInt64),
  views Nullable(UInt64), quotes Nullable(UInt64), saves Nullable(UInt64),
  source_connector LowCardinality(String)
) ENGINE = MergeTree PARTITION BY toYYYYMM(captured_at)
ORDER BY (platform, post_id, captured_at) TTL toDateTime(captured_at) + INTERVAL 180 DAY;

CREATE TABLE author_demographics (
  platform LowCardinality(String),
  author_id String,
  gender Enum8('unknown' = 0, 'male' = 1, 'female' = 2),
  gender_conf Float32,
  -- tanpa below_18 per akun (ADR-007 amandemen, data anak)
  age_range Enum8('unknown' = 0, '18_21' = 2, '22_30' = 3, '31_45' = 4, '46_55' = 5, 'above_55' = 6),
  age_conf Float32,
  method LowCardinality(String),
  model_version LowCardinality(String),
  updated_at DateTime64(3, 'UTC'),
  version UInt64
) ENGINE = ReplacingMergeTree(version) ORDER BY (platform, author_id);

CREATE TABLE provider_call_log (
  connector LowCardinality(String), account_id String, at DateTime64(3, 'UTC'),
  operation LowCardinality(String), outcome LowCardinality(String), error_code LowCardinality(String),
  duration_ms UInt32, items_returned UInt32, cost_units Nullable(Float64), cost_unit_label LowCardinality(String)
) ENGINE = MergeTree PARTITION BY toYYYYMM(at) ORDER BY (connector, account_id, at) TTL toDateTime(at) + INTERVAL 180 DAY;
