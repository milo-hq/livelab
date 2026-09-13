# 01 · 直播链路总览与协议选型

## 目标

读完本章你能画出"主播 → 观众"的完整链路，并对任意一个业务场景（带货、赛事、秀场、连麦）说出该用哪种协议、延迟预期是多少、CDN 要什么能力、iOS 上会不会翻车。

## 原理：一条直播流经过了什么

```
采集/编码 ──推流协议──▶ 接入(Ingest) ──▶ 转码/封装(Origin) ──分发协议──▶ CDN 边缘 ──▶ 播放器
OBS/手机   RTMP/SRT/WHIP    就近 PoP        ABR 阶梯、切片        HLS/LL-HLS/FLV/WebRTC   hls.js/mpegts.js/RTCPeerConnection
 ~20–30ms                    ~10ms           300ms–2s              1–30s（协议决定）        解码+渲染 100–200ms
```

延迟是"每一段的缓冲"之和。抖音/火山引擎公开过的拆解：生产端 20–30ms，服务端转码 300ms–2s，消费端 100–200ms；剩下的都是**分发协议的缓冲策略**决定的。所以选协议 = 选延迟档位 + 选 CDN 成本 + 选终端兼容性。

### 推流侧（贡献链路）三选一

| 协议 | 传输 | 适用 | 备注 |
|---|---|---|---|
| RTMP | TCP | 默认，OBS/编码器全支持 | 拥塞时延迟尖峰；H.265 需扩展 |
| SRT | UDP + ARQ | 弱网、跨境专线之外的公网贡献 | 1s 缓冲可恢复 ~25% 丢包；OBS latency ≥ 2.5×RTT |
| WHIP | WebRTC | 浏览器推流、连麦、亚秒互动 | RFC 9725（2025）；OBS ≥30、FFmpeg ≥8.0 内置 |

### 分发侧（播放链路）四档

| | HLS | LL-HLS | HTTP-FLV | WebRTC（WHEP） |
|---|---|---|---|---|
| 端到端延迟 | 20–45s（调优 5s） | 2–4s | 1–3s | 0.1–0.5s |
| 传输 | HTTP 分片 | HTTP 分片 + Partial Segment + 阻塞式清单刷新 | HTTP 长连接 | UDP/SRTP |
| CDN 要求 | 任意 | HTTP/2+、`_HLS_msn/_HLS_part` 进缓存键、短 TTL、回源合并 | 长连接透传（国内 CDN 普遍支持） | 需 SFU/实时边缘（阿里 RTS、腾讯 LEB、Cloudflare、IVS RT） |
| iOS Safari | 原生 | 原生 | 仅 iOS 17.1+ 经 ManagedMediaSource（mpegts.js） | 原生 |
| 成本 | 最低 | 略高（请求数 ×10） | 中 | 最高（按分钟计费） |
| 典型 | 回放式直播、大型赛事 | 带货、新闻、赛事 | 国内秀场/游戏桌面端 | 拍卖、连麦、竞猜 |

数据来源见附录 01（Mux、SRS、Cloudflare、MediaMTX 生产基准）。

<!-- widget:protocols -->

### 为什么 LL-HLS 现在是"默认答案"

1. **iOS 原生支持**：不需要 JS 播放器就能 2–4s，AirPlay/画中画完整。
2. **一套 CMAF 切片同时服务 HLS/DASH**，CDN 成本最低。
3. **hls.js 1.7 已把 LL-HLS 做成默认**（`lowLatencyMode: true`），并补齐 CMCD v2，让 CDN 日志能按会话关联播放器上报。
4. HTTP-FLV 仍是国内桌面端的现实选择（SRS/CDN 生态成熟），但 iOS 只能走 MMS 兜底，且 mpegts.js 单人维护；WebRTC 单价最高，只给需要互动的房间开。

## 代码走读：房间的"播放策略"是数据，不是代码

`apps/api/src/modules/rooms/pathways.ts` 把上面的选型表变成了每个房间返回给播放器的 JSON：

```ts
// 标准房间：LL-HLS(ABR) → LL-HLS(直连) → HTTP-FLV → WebRTC
// 互动房间：WebRTC → LL-HLS(ABR) → LL-HLS(直连) → HTTP-FLV
export function buildPathways(room, cfg): Pathway[] { ... }

export function policyFor(room): PlayPolicy {
  return room.mode === 'interactive'
    ? { preferred: 'whep', targetLatencySec: 1, maxStartupMs: 2000, stallLadder: ['switch_pathway', 'switch_protocol'] }
    : { preferred: 'llhls', targetLatencySec: 3, maxStartupMs: 3000, stallLadder: ['nudge', 'seek_live', 'downgrade', 'switch_pathway', 'switch_protocol'] };
}
```

`Pathway` 里的 `cdn` 标签在本地是 `local-abr` / `local-a` / `local-flv` / `local-rtc`，上线后就是 `aliyun-cn` / `cloudflare` / `cloudfront`——播放器的回退链、遥测的维度、多 CDN 调度都靠它。**把策略放在服务端下发**，意味着运营可以按地区/房间/时段调整，而不用发版。

## 动手实验

1. `curl localhost:8787/v1/rooms/demo/play | jq`，观察 4 条 pathway 与 policy。
2. `curl localhost:8787/v1/rooms/demo-rt/play | jq`，看互动房间如何把 WHEP 放到第一位。
3. 直接用浏览器打开 `http://localhost:8888/live/demo/index.m3u8?cookieCheck=1`，阅读 MediaMTX 生成的多码率清单：注意 `#EXT-X-VERSION:10`、独立的音频 rendition、`video1_stream.m3u8`。再打开媒体清单，找到 `#EXT-X-PART`、`#EXT-X-PRELOAD-HINT`、`#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=...`——这三样就是 LL-HLS 与普通 HLS 的全部区别。

## 度量

打开 `/lab` 页面同时起三路播放，对比 TTFF（首帧耗时）与延迟：LL-HLS ≈ 2–4s，FLV ≈ 1–3s，WHEP < 1s。用画面里烧录的时钟减去当前时间验证。

## 生产注意事项

- **协议是房间属性，不是全局配置**：带货间开 WebRTC，大盘观众走 LL-HLS，两者用同一路推流。
- **LL-HLS 上 CDN 前先验证阻塞式清单刷新**：很多"支持 LL-HLS"的 CDN 只是透传，`_HLS_msn` 未进缓存键时观众拿到旧清单。
- **iOS 走原生 `<video src=m3u8>`**，除非你需要 JS 侧 ABR/统计才启用 `preferManagedMediaSource`。
- MoQ（Media over QUIC）在 2026 是"可试点不可依赖"：WebTransport 已 Baseline，但 Cloudflare relay 仍是 tech preview。

## 面试/复盘要点

- 能按"延迟档位 × CDN 能力 × 终端兼容 × 成本"四维讲清楚四种协议，并说出 LL-HLS 的三个关键 tag。
- 能解释为什么播放策略要服务端下发（灰度、按地区、按房间模式）。
- 知道 WHIP 已成 RFC 9725 而 WHEP 仍是 draft-04，但业界已量产。
