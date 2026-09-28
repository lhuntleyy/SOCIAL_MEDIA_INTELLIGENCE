-- F-05 · DATA_MODEL §6.5, §6.7 — agregat (dibaca dashboard, Golden Rule 7) + MV inkremental ber-sign.
-- Query wajib sum()/uniqMerge() + GROUP BY (merge eventual). Bucket harian = UTC; hari zona tenant dihitung dari bucket 1h.

CREATE TABLE agg_topic_5m (
  tenant_id UUID, topic_id UUID, platform LowCardinality(String), sentiment Enum8('negative' = -1, 'neutral' = 0, 'positive' = 1), content_type LowCardinality(String),
  bucket DateTime('UTC'),
  posts Int64, engagement Int64, engagement_known_posts Int64
) ENGINE = SummingMergeTree PARTITION BY toYYYYMM(bucket)
ORDER BY (tenant_id, topic_id, platform, sentiment, content_type, bucket) TTL bucket + INTERVAL 35 DAY
SETTINGS non_replicated_deduplication_window = 1000;  -- target MV: wajib agar dedup token menjangkau agregat (F-05)
CREATE MATERIALIZED VIEW mv_agg_topic_5m TO agg_topic_5m AS
SELECT tenant_id, topic_id, platform, sentiment, content_type, toStartOfFiveMinutes(published_at) AS bucket,
       sum(sign) AS posts, sum(sign * toInt64(engagement)) AS engagement, sum(sign * toInt64(engagement_known)) AS engagement_known_posts
FROM topic_match_events GROUP BY tenant_id, topic_id, platform, sentiment, content_type, bucket;

CREATE TABLE agg_topic_1h (
  tenant_id UUID, topic_id UUID, platform LowCardinality(String), sentiment Enum8('negative' = -1, 'neutral' = 0, 'positive' = 1), content_type LowCardinality(String),
  bucket DateTime('UTC'),
  posts Int64, engagement Int64, engagement_known_posts Int64
) ENGINE = SummingMergeTree PARTITION BY toYYYYMM(bucket)
ORDER BY (tenant_id, topic_id, platform, sentiment, content_type, bucket) TTL bucket + INTERVAL 400 DAY
SETTINGS non_replicated_deduplication_window = 1000;  -- target MV: wajib agar dedup token menjangkau agregat (F-05)
CREATE MATERIALIZED VIEW mv_agg_topic_1h TO agg_topic_1h AS
SELECT tenant_id, topic_id, platform, sentiment, content_type, toStartOfHour(published_at) AS bucket,
       sum(sign) AS posts, sum(sign * toInt64(engagement)) AS engagement, sum(sign * toInt64(engagement_known)) AS engagement_known_posts
FROM topic_match_events GROUP BY tenant_id, topic_id, platform, sentiment, content_type, bucket;

CREATE TABLE agg_topic_1d (
  tenant_id UUID, topic_id UUID, platform LowCardinality(String), sentiment Enum8('negative' = -1, 'neutral' = 0, 'positive' = 1), content_type LowCardinality(String),
  bucket Date,
  posts Int64, engagement Int64, engagement_known_posts Int64
) ENGINE = SummingMergeTree PARTITION BY toYYYYMM(bucket)
ORDER BY (tenant_id, topic_id, platform, sentiment, content_type, bucket)
SETTINGS non_replicated_deduplication_window = 1000;  -- target MV: wajib agar dedup token menjangkau agregat (F-05)
CREATE MATERIALIZED VIEW mv_agg_topic_1d TO agg_topic_1d AS
SELECT tenant_id, topic_id, platform, sentiment, content_type, toDate(published_at) AS bucket,
       sum(sign) AS posts, sum(sign * toInt64(engagement)) AS engagement, sum(sign * toInt64(engagement_known)) AS engagement_known_posts
FROM topic_match_events GROUP BY tenant_id, topic_id, platform, sentiment, content_type, bucket;

CREATE TABLE agg_topic_uniq_1h (
  tenant_id UUID, topic_id UUID, platform LowCardinality(String), bucket DateTime('UTC'),
  authors AggregateFunction(uniq, String)
) ENGINE = AggregatingMergeTree PARTITION BY toYYYYMM(bucket)
ORDER BY (tenant_id, topic_id, platform, bucket) TTL bucket + INTERVAL 400 DAY
SETTINGS non_replicated_deduplication_window = 1000;  -- target MV: wajib agar dedup token menjangkau agregat (F-05)
CREATE MATERIALIZED VIEW mv_agg_topic_uniq_1h TO agg_topic_uniq_1h AS
SELECT tenant_id, topic_id, platform, toStartOfHour(published_at) AS bucket, uniqState(author_id) AS authors
FROM topic_match_events WHERE sign = 1
GROUP BY tenant_id, topic_id, platform, bucket;

CREATE TABLE agg_issue_1h (
  tenant_id UUID, topic_id UUID, platform LowCardinality(String), sentiment Enum8('negative' = -1, 'neutral' = 0, 'positive' = 1), issue String, bucket DateTime('UTC'),
  mentions Int64, engagement Int64
) ENGINE = SummingMergeTree PARTITION BY toYYYYMM(bucket)
ORDER BY (tenant_id, topic_id, platform, sentiment, issue, bucket) TTL bucket + INTERVAL 400 DAY
SETTINGS non_replicated_deduplication_window = 1000;  -- target MV: wajib agar dedup token menjangkau agregat (F-05)
CREATE MATERIALIZED VIEW mv_agg_issue_1h TO agg_issue_1h AS
SELECT tenant_id, topic_id, platform, sentiment, issue, toStartOfHour(published_at) AS bucket, sum(sign) AS mentions, sum(sign * toInt64(engagement)) AS engagement
FROM topic_match_events ARRAY JOIN issues AS issue
GROUP BY tenant_id, topic_id, platform, sentiment, issue, bucket;

CREATE TABLE agg_author_1d (
  tenant_id UUID, topic_id UUID, platform LowCardinality(String), sentiment Enum8('negative' = -1, 'neutral' = 0, 'positive' = 1), author_id String, bucket Date,
  posts SimpleAggregateFunction(sum, Int64),
  replies SimpleAggregateFunction(sum, Int64),
  reposts SimpleAggregateFunction(sum, Int64),
  engagement SimpleAggregateFunction(sum, Int64),
  author_handle SimpleAggregateFunction(anyLast, String),
  author_followers SimpleAggregateFunction(anyLast, Nullable(UInt64))
) ENGINE = AggregatingMergeTree PARTITION BY toYYYYMM(bucket)
ORDER BY (tenant_id, topic_id, platform, sentiment, author_id, bucket) TTL bucket + INTERVAL 400 DAY
SETTINGS non_replicated_deduplication_window = 1000;  -- target MV: wajib agar dedup token menjangkau agregat (F-05)
CREATE MATERIALIZED VIEW mv_agg_author_1d TO agg_author_1d AS
SELECT tenant_id, topic_id, platform, sentiment, author_id, toDate(published_at) AS bucket,
       sumIf(sign, content_type = 'post') AS posts, sumIf(sign, content_type IN ('reply', 'comment')) AS replies,
       sumIf(sign, content_type IN ('repost', 'quote')) AS reposts, sum(sign * toInt64(engagement)) AS engagement,
       anyLast(author_handle) AS author_handle, anyLast(author_followers) AS author_followers
FROM topic_match_events
GROUP BY tenant_id, topic_id, platform, sentiment, author_id, bucket;

CREATE TABLE agg_reposted_author_1d (
  tenant_id UUID, topic_id UUID, platform LowCardinality(String), parent_author_id String, bucket Date,
  reposted_count SimpleAggregateFunction(sum, Int64),
  parent_author_handle SimpleAggregateFunction(anyLast, Nullable(String))
) ENGINE = AggregatingMergeTree PARTITION BY toYYYYMM(bucket)
ORDER BY (tenant_id, topic_id, platform, parent_author_id, bucket) TTL bucket + INTERVAL 400 DAY
SETTINGS non_replicated_deduplication_window = 1000;  -- target MV: wajib agar dedup token menjangkau agregat (F-05)
CREATE MATERIALIZED VIEW mv_agg_reposted_author_1d TO agg_reposted_author_1d AS
SELECT tenant_id, topic_id, platform, assumeNotNull(parent_author_id) AS parent_author_id, toDate(published_at) AS bucket,
       sum(sign) AS reposted_count, anyLast(parent_author_handle) AS parent_author_handle
FROM topic_match_events WHERE content_type IN ('repost', 'quote') AND parent_author_id IS NOT NULL
GROUP BY tenant_id, topic_id, platform, parent_author_id, bucket;

CREATE TABLE agg_geo_1d (
  tenant_id UUID, topic_id UUID, platform LowCardinality(String), geo_region_code String, bucket Date,
  posts Int64
) ENGINE = SummingMergeTree PARTITION BY toYYYYMM(bucket)
ORDER BY (tenant_id, topic_id, platform, geo_region_code, bucket)
SETTINGS non_replicated_deduplication_window = 1000;  -- target MV: wajib agar dedup token menjangkau agregat (F-05)
CREATE MATERIALIZED VIEW mv_agg_geo_1d TO agg_geo_1d AS
SELECT tenant_id, topic_id, platform, ifNull(geo_region_code, '') AS geo_region_code, toDate(published_at) AS bucket, sum(sign) AS posts
FROM topic_match_events
GROUP BY tenant_id, topic_id, platform, geo_region_code, bucket;

CREATE TABLE agg_author_age_1d (
  tenant_id UUID, topic_id UUID, author_created_year UInt16, bucket Date,
  authors AggregateFunction(uniq, String)
) ENGINE = AggregatingMergeTree PARTITION BY toYYYYMM(bucket)
ORDER BY (tenant_id, topic_id, author_created_year, bucket) TTL bucket + INTERVAL 400 DAY
SETTINGS non_replicated_deduplication_window = 1000;  -- target MV: wajib agar dedup token menjangkau agregat (F-05)
CREATE MATERIALIZED VIEW mv_agg_author_age_1d TO agg_author_age_1d AS
SELECT tenant_id, topic_id, ifNull(author_created_year, 0) AS author_created_year, toDate(published_at) AS bucket, uniqState(author_id) AS authors
FROM topic_match_events WHERE sign = 1
GROUP BY tenant_id, topic_id, author_created_year, bucket;

CREATE TABLE agg_emotion_1h (
  tenant_id UUID, topic_id UUID, platform LowCardinality(String), emotion Enum8('unknown' = 0, 'anger' = 1, 'anticipation' = 2, 'disgust' = 3, 'trust' = 4, 'joy' = 5, 'sadness' = 6, 'surprise' = 7, 'fear' = 8), bucket DateTime('UTC'),
  posts Int64, engagement Int64
) ENGINE = SummingMergeTree PARTITION BY toYYYYMM(bucket)
ORDER BY (tenant_id, topic_id, platform, emotion, bucket) TTL bucket + INTERVAL 400 DAY
SETTINGS non_replicated_deduplication_window = 1000;  -- target MV: wajib agar dedup token menjangkau agregat (F-05)
CREATE MATERIALIZED VIEW mv_agg_emotion_1h TO agg_emotion_1h AS
SELECT tenant_id, topic_id, platform, emotion, toStartOfHour(published_at) AS bucket, sum(sign) AS posts, sum(sign * toInt64(engagement)) AS engagement
FROM topic_match_events
GROUP BY tenant_id, topic_id, platform, emotion, bucket;

CREATE TABLE agg_hashtag_1h (
  tenant_id UUID, topic_id UUID, platform LowCardinality(String), sentiment Enum8('negative' = -1, 'neutral' = 0, 'positive' = 1), hashtag String, bucket DateTime('UTC'),
  mentions Int64, engagement Int64
) ENGINE = SummingMergeTree PARTITION BY toYYYYMM(bucket)
ORDER BY (tenant_id, topic_id, platform, sentiment, hashtag, bucket) TTL bucket + INTERVAL 400 DAY
SETTINGS non_replicated_deduplication_window = 1000;  -- target MV: wajib agar dedup token menjangkau agregat (F-05)
CREATE MATERIALIZED VIEW mv_agg_hashtag_1h TO agg_hashtag_1h AS
SELECT tenant_id, topic_id, platform, sentiment, lower(hashtag) AS hashtag, toStartOfHour(published_at) AS bucket, sum(sign) AS mentions, sum(sign * toInt64(engagement)) AS engagement
FROM topic_match_events ARRAY JOIN hashtags AS hashtag
GROUP BY tenant_id, topic_id, platform, sentiment, hashtag, bucket;

CREATE TABLE agg_emotion_1d (
  tenant_id UUID, topic_id UUID, platform LowCardinality(String), emotion Enum8('unknown' = 0, 'anger' = 1, 'anticipation' = 2, 'disgust' = 3, 'trust' = 4, 'joy' = 5, 'sadness' = 6, 'surprise' = 7, 'fear' = 8), bucket Date,
  posts Int64, engagement Int64
) ENGINE = SummingMergeTree PARTITION BY toYYYYMM(bucket)
ORDER BY (tenant_id, topic_id, platform, emotion, bucket)
SETTINGS non_replicated_deduplication_window = 1000;  -- target MV: wajib agar dedup token menjangkau agregat (F-05)
CREATE MATERIALIZED VIEW mv_agg_emotion_1d TO agg_emotion_1d AS
SELECT tenant_id, topic_id, platform, emotion, toDate(published_at) AS bucket, sum(sign) AS posts, sum(sign * toInt64(engagement)) AS engagement
FROM topic_match_events
GROUP BY tenant_id, topic_id, platform, emotion, bucket;

CREATE TABLE agg_hashtag_1d (
  tenant_id UUID, topic_id UUID, platform LowCardinality(String), sentiment Enum8('negative' = -1, 'neutral' = 0, 'positive' = 1), hashtag String, bucket Date,
  mentions Int64, engagement Int64
) ENGINE = SummingMergeTree PARTITION BY toYYYYMM(bucket)
ORDER BY (tenant_id, topic_id, platform, sentiment, hashtag, bucket)
SETTINGS non_replicated_deduplication_window = 1000;  -- target MV: wajib agar dedup token menjangkau agregat (F-05)
CREATE MATERIALIZED VIEW mv_agg_hashtag_1d TO agg_hashtag_1d AS
SELECT tenant_id, topic_id, platform, sentiment, lower(hashtag) AS hashtag, toDate(published_at) AS bucket, sum(sign) AS mentions, sum(sign * toInt64(engagement)) AS engagement
FROM topic_match_events ARRAY JOIN hashtags AS hashtag
GROUP BY tenant_id, topic_id, platform, sentiment, hashtag, bucket;

CREATE TABLE agg_psycho_gender_1d (
  tenant_id UUID, topic_id UUID, platform LowCardinality(String), author_gender Enum8('unknown' = 0, 'male' = 1, 'female' = 2), sentiment Enum8('negative' = -1, 'neutral' = 0, 'positive' = 1), bucket Date,
  posts Int64
) ENGINE = SummingMergeTree PARTITION BY toYYYYMM(bucket)
ORDER BY (tenant_id, topic_id, platform, author_gender, sentiment, bucket) TTL bucket + INTERVAL 400 DAY
SETTINGS non_replicated_deduplication_window = 1000;  -- target MV: wajib agar dedup token menjangkau agregat (F-05)
CREATE MATERIALIZED VIEW mv_agg_psycho_gender_1d TO agg_psycho_gender_1d AS
SELECT tenant_id, topic_id, platform, author_gender, sentiment, toDate(published_at) AS bucket, sum(sign) AS posts
FROM topic_match_events
GROUP BY tenant_id, topic_id, platform, author_gender, sentiment, bucket;

CREATE TABLE agg_psycho_age_1d (
  tenant_id UUID, topic_id UUID, platform LowCardinality(String), author_age_range Enum8('unknown' = 0, 'below_18' = 1, '18_21' = 2, '22_30' = 3, '31_45' = 4, '46_55' = 5, 'above_55' = 6), sentiment Enum8('negative' = -1, 'neutral' = 0, 'positive' = 1), bucket Date,
  posts Int64
) ENGINE = SummingMergeTree PARTITION BY toYYYYMM(bucket)
ORDER BY (tenant_id, topic_id, platform, author_age_range, sentiment, bucket) TTL bucket + INTERVAL 400 DAY
SETTINGS non_replicated_deduplication_window = 1000;  -- target MV: wajib agar dedup token menjangkau agregat (F-05)
CREATE MATERIALIZED VIEW mv_agg_psycho_age_1d TO agg_psycho_age_1d AS
SELECT tenant_id, topic_id, platform, author_age_range, sentiment, toDate(published_at) AS bucket, sum(sign) AS posts
FROM topic_match_events
GROUP BY tenant_id, topic_id, platform, author_age_range, sentiment, bucket;

CREATE TABLE media_items (
  tenant_id UUID, topic_id UUID, platform LowCardinality(String), post_id String, media_idx UInt16,
  media_type LowCardinality(String), media_url String, thumb_url Nullable(String),
  published_at DateTime64(3, 'UTC'), sentiment Enum8('negative' = -1, 'neutral' = 0, 'positive' = 1), sign Int8, event_at DateTime64(3, 'UTC')
) ENGINE = MergeTree PARTITION BY toYYYYMM(published_at)
ORDER BY (tenant_id, topic_id, published_at, platform, post_id, media_idx)
SETTINGS non_replicated_deduplication_window = 1000;  -- target MV: wajib agar dedup token menjangkau agregat (F-05)
CREATE MATERIALIZED VIEW mv_media_items TO media_items AS
SELECT tenant_id, topic_id, platform, post_id, toUInt16(idx - 1) AS media_idx, m.1 AS media_type, m.2 AS media_url, m.3 AS thumb_url,
       published_at, sentiment, sign, event_at
FROM topic_match_events ARRAY JOIN media AS m, arrayEnumerate(media) AS idx;
