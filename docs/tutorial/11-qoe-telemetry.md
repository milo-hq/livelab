# 11 · 播放质量监控、埋点与异常采集

## 目标

建立一条"播放器事件 → 批量上报 → ClickHouse → Grafana 看板与告警"的自托管管线，指标口径对齐 Mux / Conviva / 阿里云，并能在致命错误时拿到现场。

## 原理：指标定义（本项目采用）

| 指标 | 定义 | 事件/列 |
|---|---|---|
| TTFF | 用户意图播放（`play_attempt`）→ 首个 `playing` | `first_frame.value_ms` |
| 秒开率 | TTFF ≤ 1000ms 的占比 | `countIf(value_ms<=1000)/count()` |
| 卡顿 | 首帧后、非 seek/暂停期间的 `waiting` ≥200ms | `stall_start` / `stall_end.value_ms` |
| 百秒卡顿时长 | Σ卡顿ms ÷ Σ观看ms × 100 | `heartbeat.value_ms = playingMs` |
| 卡顿会话占比 | 有 `stall_end` 的 view ÷ 有 `play_attempt` 的 view | uniq(view_id) |
| 播放失败率 | 有 `error{fatal}` 的 view ÷ 有 `play_attempt` 的 view | `fatal=1` |
| EBVS | 无 `first_frame`、无 fatal、停留 ≥1s 后 `end` | `end.value_ms = watchMs` |
| 延迟 | 播放器到边缘：`bufferedEnd − currentTime`（hls.js 用 `hls.latency`） | `latency_sample.latency_ms` |
| 掉帧率 | `droppedVideoFrames / totalVideoFrames` 增量 | `heartbeat` |
| 恢复动作 | 阶梯每一步 | `recovery_action.attrs.action` |

维度：`session_id`（标签页）、`view_id`（每次起播）、`room_id`、`protocol`、`cdn`、`player/player_ver`、`os/browser/net_type`、`region/isp`，以及 hls.js CMCD v2 的 `sid` = `session_id`，让 CDN 日志能与播放器上报对齐。

## 代码走读

### SDK（`packages/telemetry`）

```ts
const telemetry = createTelemetry({ endpoint: '/v1/telemetry', ctx: { player: 'livelab-web', playerVer, region, isp } });
telemetry.track('video.first_frame', { ttffMs: 312, protocol: 'llhls', cdn: 'local-abr' }, { viewId, roomId });
telemetry.log('warn', 'stall #2 → seek_live');
await telemetry.reportIssue('黑屏有声音');
```

- **批量**：≥20 条或 5s 一发；`visibilitychange=hidden`/`pagehide` 立即 flush；`fetch(..., { keepalive: true })`（OpenTelemetry 2026 已放弃 sendBeacon，同样选择）；单请求 <60KB（keepalive 限制 64KB）。
- **采样**：`heartbeat`、`latency_sample` 默认 20%，按 `fnv1a(sessionId|name)` 决定——同一会话要么全留要么全丢，时间序列不断裂。`error`、`first_frame`、`end`、`report_issue` 永不采样、永不因队列满而丢（独立"必达"队列）。
- **现场**：致命错误与报障自动附带最近 50 条环形日志（`attrs.log`）与近 60s 媒体请求瀑布（`attrs.resources`，来自 `performance.getEntriesByType('resource')`）。
- **Web Vitals**：`web-vitals` 6 的 LCP/INP/CLS/TTFB/FCP 以 `web.vital` 上报。

### 入库（`apps/api/src/modules/telemetry`）

`POST /v1/telemetry`（64KB 上限，zod 校验）→ `mapper.toRows`（扁平化为 `qoe.events` 列，其余属性进 `attrs` Map）→ `ClickHouseSink`（2s 或 1000 行批量 `INSERT … FORMAT JSONEachRow`，失败限频打日志后丢弃，永不阻塞请求）。未配置 ClickHouse 时退化为控制台输出。

### 存储（`infra/clickhouse/init.sql`）

`qoe.events` MergeTree，按天分区，`ORDER BY (room_id, event, ts, session_id)`，TTL 30 天；`startup_5m` 物化视图预聚合 TTFF 分位数。为什么不用 Prometheus：会话级维度（session/ISP/CDN 的笛卡尔积）会让 label 爆炸，且无法按会话重算 p95。

### 看板与告警（`infra/grafana/provisioning`）

三块看板：**QoE 总览**（会话数、TTFF p50/p95、秒开率、百秒卡顿、卡顿会话占比、失败率/EBVS、延迟按协议、码率与掉帧、Top 错误、恢复动作分布）、**按 CDN/协议/网络**、**错误与异常分析**（含致命会话的日志尾部与用户报障）。三条起步告警：TTFF p95 > 3s 持续 10m；百秒卡顿 > 3 持续 5m；失败率 > 1% 持续 5m。

## 动手实验

1. 播放 1 分钟后打开 Grafana（admin/admin）→ LiveLab · QoE 总览，把时间范围设为最近 15 分钟。
2. `/lab` 丢包 30% 播放 1 分钟，回到看板看百秒卡顿与 `recovery_action` 分布的变化。
3. 播放器右上角"报障"，填写描述，去"错误与异常分析"看板底部看 `attrs.resources`。
4. 直接查询：

```sql
SELECT cdn, protocol, quantile(0.5)(value_ms) p50, quantile(0.95)(value_ms) p95, count() n
FROM qoe.events WHERE event='first_frame' AND ts > now() - INTERVAL 1 HOUR GROUP BY cdn, protocol;
```

## 生产注意事项

- 采集端加 OpenFeature 之类的 flag 维度，播放器配置 A/B 就是"按 flag 变体分组看同一张表"。
- 接入 CDN 日志（Akamai DataStream / CloudFront real-time logs 已含 CMCD 字段）按 `sid` 关联。
- 告警用多窗口 burn-rate 而不是单阈值，避免夜间低流量误报。
- 隐私：`user_id` 哈希后入库；`attrs.log` 不要含 token。

## 面试/复盘要点

- 每个指标的分子分母与排除规则。
- 为什么按会话采样、为什么错误必达。
- ClickHouse vs Prometheus 的选择理由。
