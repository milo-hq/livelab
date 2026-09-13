# 05 · 卡顿率、弱网与跨境播放策略

## 目标

给出可度量的卡顿定义，理解播放器侧的"恢复阶梯"，用弱网代理复现并验证每一级恢复动作。

## 原理

### 卡顿怎么定义才不打架

| 口径 | 定义 | 本项目 |
|---|---|---|
| Mux Rebuffering % | 卡顿态时长 ÷ 总观看时长 | `stall_end.durationMs` 求和 ÷ `heartbeat.playingMs` 求和 |
| Conviva | 排除首帧前缓冲与暂停；≥200ms 微卡顿计入 | QoE 探针：首帧前的 `waiting` 不算；seek/暂停期间不算；≥200ms 才算 |
| 阿里云"百秒卡顿时长" | (卡顿总秒 ÷ 观看总秒) × 100 | Grafana 面板同名 |
| 字节"卡顿人头" | 累计卡顿占比 ≥5% 的用户 ÷ 总用户 | 可由 view 级聚合得到 |

探针实现（`packages/player-core/src/qoe-probe.ts`）：`waiting` 事件启动 200ms 定时器，超时才发 `stall_start`；`playing` 结束并计算 `durationMs`；同时接受引擎级 `stall_start`（如 WebRTC `disconnected`）。

### 弱网下各协议的行为

- **LL-HLS / FLV（TCP）**：丢包表现为重传 → 到达变慢 → 缓冲耗尽 → 卡顿；有几秒缓冲兜底。
- **WebRTC（UDP）**：NACK/FEC 抗丢包，延迟不涨但画质降、可能花屏；持续 30% 丢包仍可播（阿里云 RTS 宣称）。
- 策略：互动房间 WebRTC 优先、失败降级 LL-HLS；大盘观众 LL-HLS/FLV；最低档保留纯音频。

### 恢复阶梯

```
stall #1 → nudge（currentTime += 0.1，跨过缓冲空洞）
stall #2 → seek_live（丢弃积压，贴回 live edge）
stall #3 → downgrade（setLevel(0)，30s 后恢复 auto）
stall #4 → switch_pathway（换 CDN/线路，同协议）
stall #5 → switch_protocol（LL-HLS → FLV → WHEP …）
60s 无卡顿 → 阶梯归零
```

阶梯是 `policy.stallLadder`，由服务端按房间下发，运营可调。

### 跨境

跨境的本质是 RTT 高、丢包随时段波动、部分 CDN 在某些 ISP 表现差。前端能做的：
1. **多 pathway + 客户端切换**（本项目的 `switch_pathway`），配合服务端按地理/ISP 调度返回的顺序。
2. **HLS Content Steering**：hls.js 原生支持，steering server 返回 pathway 优先级 JSON，秒级切换且不丢缓冲。
3. **上报 QoE 维度**：`cdn`、`region`、`isp`，让调度服务有数据依据（快手用 Flink 实时调 CDN 配比的思路）。

## 代码走读：弱网代理

`apps/api/src/modules/weaknet/routes.ts`：`GET /weaknet?u=<上游>&delay=&loss=&bw=`。

- `delay`：首字节前睡眠，模拟 RTT。
- `loss`：对**分片**按概率返回 503，**清单永不丢**——丢清单会让播放器死等，丢分片才能触发我们要研究的重试路径。
- `bw`：令牌桶限速（50ms tick）。
- `.m3u8` 响应体重写：每个 URI（含 `URI="…"` 属性、`#EXT-X-MAP`/`#EXT-X-PART`/`#EXT-X-PRELOAD-HINT`）都改回 `/weaknet?u=…`，并保留 `?session=` 与 `_HLS_msn` 等查询参数。

播放器通过 `EngineOptions.requestTransform` 把所有媒体请求改写到代理（hls.js 的 `fetchSetup/xhrSetup`；mpegts.js 只改起始 URL）。WebRTC 走 UDP 不经 HTTP，用 Chrome DevTools 或 macOS Network Link Conditioner。

## 动手实验

1. `/lab` LL-HLS 面板：丢包 30%，重新起播。观察 QoE 浮层：`error network/fragLoadError`（非致命，hls.js 自己重试）→ 偶发 `stall_start/stall_end` → 阶梯动作。
2. 带宽 800kbps：观察 `level_switch → L0`（ABR 降到 360p），延迟是否稳定。
3. 延迟 2000ms：LL-HLS 的阻塞式清单刷新对高 RTT 更敏感，看 `latency` 是否涨、`rate 1.5x` 是否追回。
4. 停掉 MediaMTX 里的 `demo_360`（改 `push.sh` 只推两路）观察 ABR 主清单 503 → `switch_pathway` 到 `local-a`。

## 度量

- 百秒卡顿时长、卡顿会话占比、卡顿用户率（≥5%）。
- `recovery_action` 分布：哪一级救回了多少会话。
- 按 `weaknet` 属性（`delay/loss/bw`）分组对比：这就是 A/B 实验的雏形。

## 生产注意事项

- 卡顿的口径要与后端/数据团队对齐并写进文档；不同口径的数字不可比。
- 追帧速率 1.5x 在有声内容上会明显变调，带货/秀场建议 1.05–1.1；本项目为教学取 1.5。
- Network Information API 只有 Chromium 支持，`net_type` 在 Safari 上恒为 unknown。
- 跨境切换要配合服务端调度，避免所有客户端同时切到同一条备线。

## 面试/复盘要点

- 三种卡顿口径的差异与你项目采用的定义。
- 恢复阶梯每一级的适用场景，为什么 nudge 在最前、切协议在最后。
- 弱网代理为什么不丢清单。
