CREATE DATABASE IF NOT EXISTS qoe;

-- One row per player event. Column set follows CMCD/Mux-style QoE dimensions.
CREATE TABLE IF NOT EXISTS qoe.events (
  ts DateTime64(3),
  event LowCardinality(String),
  session_id String,
  view_id String,
  user_id String,
  room_id LowCardinality(String),
  protocol LowCardinality(String),
  player LowCardinality(String),
  player_ver LowCardinality(String),
  cdn LowCardinality(String),
  region LowCardinality(String),
  isp LowCardinality(String),
  os LowCardinality(String),
  browser LowCardinality(String),
  net_type LowCardinality(String),
  value_ms UInt32,
  bitrate_kbps UInt32,
  level Int16,
  buffer_ms UInt32,
  latency_ms UInt32,
  dropped_frames UInt32,
  total_frames UInt32,
  err_type LowCardinality(String),
  err_detail LowCardinality(String),
  fatal UInt8,
  attrs Map(LowCardinality(String), String)
) ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (room_id, event, ts, session_id)
TTL toDateTime(ts) + INTERVAL 30 DAY;

-- Pre-aggregated startup quantiles per 5 minutes for cheap dashboards.
CREATE MATERIALIZED VIEW IF NOT EXISTS qoe.startup_5m
ENGINE = AggregatingMergeTree
ORDER BY (m, room_id, cdn, protocol)
AS SELECT
  toStartOfFiveMinutes(ts) AS m,
  room_id, cdn, protocol,
  quantilesTDigestState(0.5, 0.95)(value_ms) AS q,
  countState() AS n
FROM qoe.events
WHERE event = 'first_frame'
GROUP BY m, room_id, cdn, protocol;
