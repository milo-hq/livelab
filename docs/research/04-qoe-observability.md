# 浏览器直播播放器 QoE 监控 / 埋点 / 异常采集 —— 2026-09 现状调研

> 版本号/日期于 2026-09-13 通过 npm registry、GitHub 与官方文档核对。

## 1. 行业 QoE 指标定义

**起播时间（Startup Time）**
- Mux：Video Startup Time = 用户意图播放→首帧；Player Startup Time；Page Load Time；建议 <2s，<1s 优秀（[Mux](https://www.mux.com/blog/the-video-startup-time-metric-explained)）。
- Bitmovin：Startup Score = `100·(1-(VST-300)/19700)²`（[Bitmovin](https://developer.bitmovin.com/playback/docs/the-bitmovin-playback-score)）。
- 阿里云："首帧耗时 = AVG(首帧显示时间 − 调用start时间)"；"秒开率 = 首帧≤1000ms 次数 ÷ 实际播放量"；"慢开率 = 首帧≥3000ms"（[阿里云](https://www.alibabacloud.com/help/zh/vod/user-guide/metric-description)）。
- CMCD v2 `msd`（Media Start Delay）。

**卡顿（Rebuffering）**
- Mux Rebuffering Percentage = 卡顿态时长 ÷ 总观看时长；直播 <1%，>3% 严重（[Mux](https://www.mux.com/docs/guides/monitoring-metrics)）。
- Conviva = `rebufferingTime / (playTime + rebufferingTime)`，排除首帧前与暂停，<200ms 微卡顿计入（[Conviva](https://docs.conviva.ai/vsi-video/metric-dictionary/rebuffering-ratio/)）。
- 阿里云："百秒卡顿时长 = (卡顿总时长 ÷ 观看总时长) × 100"；"百秒卡顿次数"；"次数卡顿率 = 发生过卡顿的播放量 ÷ 实际播放量"。
- 字节系"卡顿人头"口径：累计卡顿/在线时长 ≥5% 记为卡顿用户。

**失败/退出**
- Mux Playback Failure % = 致命错误 view ÷ 总 view；EBVS = 点击 play 但从未首帧且等待 ≥1s（[Mux](https://www.mux.com/docs/guides/data-playback-success-metric)）。目标失败率 <0.5%。

**直播延迟**：`EXT-X-PROGRAM-DATE-TIME` 与 UTC 比较（[Mux](https://www.mux.com/blog/live-latency-metric)）；CMCD v2 `ltc`；player→edge 用 hls.js `hls.latency`。

**掉帧**：`getVideoPlaybackQuality()` `totalVideoFrames / droppedVideoFrames`；`requestVideoFrameCallback()` 2024-10 Baseline。

## 2. CMCD / CMSD

- CMCD v2 = CTA-5004-B，2026-04-14；Request/Response/Event 三模式；新键 `ltc, msd, sta, bs, ttfb, ...`（[CTA-5004-B](https://cta-wave.github.io/Resources/common-media-client-data--cta-5004-b.html)）。
- hls.js v1.7.0 支持 CMCD v2：`cmcd.version: 2` + `cmcd.eventTargets`；dash.js 5.2 完整；Shaka 4.16+。
- CDN：Akamai AMD、CloudFront real-time logs（2024-04）提供 CMCD 字段；Cloudflare 无公开文档。
- CMSD = CTA-5006，`CMSD-Static/CMSD-Dynamic` 响应头。

## 3. 浏览器遥测 SDK

| 方案 | 版本 | 要点 |
|---|---|---|
| `@opentelemetry/sdk-trace-web` | 2.11.0 | 稳定；logs 0.222.0 experimental |
| `@opentelemetry/browser-sdk` | 0.4.0 | 实验性 browser 专用 SDK |
| OTLP HTTP exporter | 0.222.0 | 已移除 sendBeacon，改用 `fetch keepalive`；卸载靠 `visibilitychange → forceFlush()` |
| Grafana Faro | 2.11.0 | 开源；Alloy `faro.receiver` → Loki/Tempo |
| Sentry | 10.74.0 | 自托管重；session replay |
| PostHog | 1.430.3 | 开源可自托管，events + replay + flags |
| ClickStack/HyperDX | 0.26.0 | OTel-native，直连 ClickHouse |

## 4. 存储 / 看板

- ClickHouse 26.8 LTS（2026-09-01）；Grafana 13.2.1；ClickHouse datasource 4.20.0。
- 不用 Prometheus 存事件：label 维度爆炸且无法按会话重算 p95。

事件表：
```sql
CREATE TABLE qoe.events (
  ts DateTime64(3), event LowCardinality(String),
  session_id String, view_id String, user_id_hash String,
  stream_id LowCardinality(String), protocol LowCardinality(String),
  player LowCardinality(String), player_ver LowCardinality(String),
  cdn LowCardinality(String), region LowCardinality(String), isp LowCardinality(String),
  os LowCardinality(String), browser LowCardinality(String), net_type LowCardinality(String),
  value_ms UInt32, bitrate_kbps UInt32, level Int16, buffer_ms UInt32, latency_ms UInt32,
  dropped_frames UInt32, total_frames UInt32,
  err_type LowCardinality(String), err_detail LowCardinality(String), fatal UInt8,
  attrs Map(LowCardinality(String), String)
) ENGINE = MergeTree PARTITION BY toDate(ts)
ORDER BY (stream_id, event, ts, session_id) TTL ts + INTERVAL 30 DAY;
```

查询示例：
```sql
-- p50/p95 起播，按 CDN×ISP
SELECT toStartOfFiveMinutes(ts) m, cdn, isp, quantiles(0.5,0.95)(value_ms)
FROM qoe.events WHERE event='first_frame' AND ts >= now()-INTERVAL 1 HOUR GROUP BY m,cdn,isp ORDER BY m;
-- 百秒卡顿时长 & 次数卡顿率
SELECT 100*sumIf(value_ms,event='stall_end')/1000 / (sumIf(value_ms,event='heartbeat')/1000) AS stall_per_100s,
       100*uniqIf(view_id,event='stall_end')/uniqIf(view_id,event='play_attempt') AS stall_view_pct
FROM qoe.events WHERE ts >= now()-INTERVAL 15 MINUTE;
-- 播放失败率 & EBVS
WITH v AS (SELECT view_id, maxIf(1,event='first_frame') ff, maxIf(1,event='error' AND fatal=1) fe,
           maxIf(1,event='end' AND value_ms>=1000) ex FROM qoe.events
           WHERE ts>=now()-INTERVAL 1 HOUR GROUP BY view_id)
SELECT 100*avg(fe) failure_pct, 100*avg(ff=0 AND fe=0 AND ex=1) ebvs_pct FROM v;
```

## 5. 错误分类与异常捕获

- hls.js `ErrorTypes` NETWORK/MEDIA/KEY_SYSTEM/MUX/OTHER；`ErrorDetails` ~50 项；`data.fatal` 决定 `recoverMediaError()`/重建；`BUFFER_STALLED_ERROR` 是卡顿计数源。
- mpegts.js：`ErrorTypes` NETWORK/MEDIA/OTHER；`STATISTICS_INFO` 提供 speed/droppedFrames。
- WebRTC：`connectionState` `failed` 需 `restartIce()`；`getStats()` inbound-rtp `framesDropped/jitterBufferDelay/packetsLost/freezeCount`。
- MSE `QuotaExceededError`：移除 back-buffer 后重试或降档。
- 现场采集：致命错误时上传 500 条环形日志 + `performance.getEntriesByType('resource')` 最近 60s 瀑布；"报障"按钮强制 100% 采样。
- SLO 告警：多窗口 burn-rate。

## 6. 弱网优化（可度量）

- hls.js：`maxLiveSyncPlaybackRate` 1.05–1.1 追帧、`liveSyncOnStallIncrease 1`、`maxBufferHole 0.1`、`nudgeOffset/nudgeMaxRetry`、`abrEwmaDefaultEstimate`、`abrSwitchInterval`、`errorPenaltyExpireMs`。
- mpegts.js：`liveBufferLatencyChasing`、`liveBufferLatencyMaxLatency 1.5`、`liveSync`。
- 卡顿恢复阶梯：nudge → 降档 → seek-to-live → 协议降级 WebRTC→LL-HLS→HLS（每步打 `recovery_action` 事件）。
- Network Information API 仅 Chromium。
- A/B：OpenFeature v0.9.0；`@openfeature/web-sdk` 1.10.0；flag 变体作事件维度。

## 7. 直播间页面性能

- `web-vitals` 6.2.1：INP/LCP/CLS；`visibilitychange` 批量 `sendBeacon`。
- 播放器内核 `import()` 按协议懒加载（`hls.light.mjs`）；`preconnect` 到 CDN；LCP 元素设为海报图。

## Recommendations

指标定义：
- TTFF_click = t(首帧) − t(点击/autoplay)；秒开率 = ≤1000ms 占比。
- 卡顿：`waiting`→`playing` ≥200ms，排除首帧前与 seek/暂停；百秒卡顿时长；卡顿率(view)；卡顿用户率(≥5%)。
- 失败率 = fatal error view ÷ play_attempt；EBVS。
- 延迟：E2E = now − PDT(currentTime)；player-edge = bufferedEnd − currentTime。
- 掉帧率 = Δdropped/Δtotal（10s heartbeat）。

SDK 设计：事件 `video.play_attempt, first_frame, stall_start, stall_end, level_switch, latency_sample, heartbeat(10s), error, recovery_action, end, report_issue`；公共维度 session_id/view_id/stream_id/protocol/player/cdn/region/isp/os/browser/net_type/flag_variants；CMCD `sid` = session_id。传输：内存队列 ≥20 条或 5s 批发，`fetch keepalive`，hidden 立即 flush。采样：heartbeat 10–20%，error/first_frame 100%。

管线：collector → ClickHouse 26.8 → Grafana 13.2 + ClickHouse datasource。

告警：起播 p95 >3s 10m；百秒卡顿 >3 5m；失败率 >1%；EBVS >5%；CDN/ISP 错误占比 >20%；延迟 p50 > 目标×1.5。
