# 04 · 起播速度：把首帧压进 1 秒

## 目标

理解首帧（TTFF）由哪几段组成，掌握每一段在本项目里的对应优化，并能用数据证明优化有效。

## 原理：首帧的时间线

```
用户点击/进房 ──▶ 拿播放地址 ──▶ 建连(DNS+TCP+TLS) ──▶ 下载清单 ──▶ 下载 init + 首个分片 ──▶ 解码 ──▶ 首帧
   t0            api /play      preconnect 已省掉     LL-HLS 两级清单     part 500ms         硬解
```

B 站公开的拆法是"流地址查询 + 网络传输 + 解码"三段；Mux 的口径是 Video Startup Time（意图播放 → 首帧），行业目标 < 2s，优秀 < 1s；阿里云定义"秒开率 = 首帧 ≤ 1000ms 的占比"。本项目在本机的典型值：LL-HLS 270–370ms，FLV 90–480ms，WHEP 540ms。

## 代码走读：每一段对应的优化

| 段 | 优化 | 代码位置 |
|---|---|---|
| 拿地址 | `GET /v1/rooms/:id/play` 与房间信息并行请求；`staleTime 60s` 复用 | `use-player.ts` |
| 建连 | `<link rel="preconnect">` 到 8888/8889/8787 三个域 | `index.html` |
| 清单 | 服务端 `hlsAlwaysRemux: true` 预热切片器；part 500ms | `infra/mediamtx.yml` |
| 首档位 | `abrEwmaDefaultEstimate` 用上次会话的带宽（`localStorage['livelab.bw']`），`testBandwidth: false` 跳过试探下载 | `engines/hls.ts` |
| 预取 | `startFragPrefetch: true`：attach 之前就开始拉首片 | `hls-config.ts` |
| 缓冲 | `liveSyncDuration = 3`：不必等满 3×TARGETDURATION | `hls-config.ts` |
| 包体 | 引擎 `import()` 按线路懒加载：只下载用到的那一个 | `create-engine.ts` |
| 解码 | 固定 1s GOP、`-tune zerolatency`，首片即关键帧 | `infra/pusher/push.sh` |
| 起播动作 | `canplay` 立即 `play()`，不等 `canplaythrough` | `use-player.ts` |

一个容易忽视的点：**FLV 快是因为 SRS 的 GOP cache**——新观众立刻收到上一关键帧起的所有帧，首帧几乎不用等；代价是初始延迟高，需要 mpegts.js 的 chasing 追回来。这是"起播速度 vs 延迟"的经典取舍。

## 动手实验

1. `/lab` 点"全部重新起播"，三路 TTFF 并排对比，重复 5 次取中位数。
2. 把 `index.html` 里的 `preconnect` 删掉再试，对比 LL-HLS 的 TTFF（本机差异小，跨地域可达 300–500ms）。
3. 清掉 `localStorage['livelab.bw']`，观察第一次进房 hls.js 是否从低档位起播并多做一次带宽试探（QoE 浮层的 `level_switch`）。
4. 弱网面板：延迟 300ms、带宽 1500kbps，再看 TTFF 与首档位选择。

## 度量

- `video.first_frame.ttffMs`：Grafana "起播 TTFF p50/p95" 面板；秒开率 = `countIf(value_ms <= 1000) / count()`。
- 按 `cdn`、`protocol`、`browser`、`net_type` 下钻（"按 CDN/协议/网络"看板）。
- EBVS（Exit Before Video Start）：有 `play_attempt`、无 `first_frame`、无 fatal、停留 ≥1s 就离开——起播慢的直接业务后果。

## 生产注意事项

- 播放地址接口要走就近节点并可缓存（302 调度/HTTPDNS），否则"拿地址"这一段在跨境时就是 200ms+。
- CMAF/fMP4 优于 TS：LL-HLS Partial Segment 实践上要求 fMP4，且省掉 transmux。
- 海报图作为 LCP 元素，视频首帧不要成为页面 LCP。
- 把 `abrEwmaDefaultEstimate` 的来源从 localStorage 升级为服务端按地区/ISP 下发的先验值。

## 面试/复盘要点

- 能把 TTFF 拆成 5 段并各给一个优化手段。
- 知道 GOP cache 的两面性。
- 秒开率、EBVS 的定义与计算 SQL。
