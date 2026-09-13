# 浏览器端直播播放技术现状调研（2026-09）

> 所有版本号/日期均来自 npm registry（2026-09-13 查询）或所引 URL。

## 1. hls.js

| 项目 | 现状 | 来源 |
|---|---|---|
| 最新稳定版 | **1.7.3**（2026-09-11）；1.7.0 于 2026-08-12 发布 | [npm](https://www.npmjs.com/package/hls.js)、[GitHub Releases](https://github.com/video-dev/hls.js/releases) |
| LL-HLS | 完整支持 Partial Segments、Blocking Playlist Reload、Delta Updates、Rendition Reports；`lowLatencyMode` 默认 `true` | [README](https://github.com/video-dev/hls.js/blob/master/README.md)、[API.md](https://github.com/video-dev/hls.js/blob/master/docs/API.md) |
| iOS Safari | 自 1.5.0 起通过 ManagedMediaSource (MMS) 支持 iOS 17.1+；`preferManagedMediaSource` 默认 `false` | README |
| Worker | 仅 transmuxer 跑在 Worker，MediaSource 仍在主线程（issue #4592）。ESM 构建不内联 worker，必须显式配 `workerPath` | [dev.to](https://dev.to/masonwritescode/check-whether-hlsjs-is-actually-using-a-worker-most-esm-setups-arent-2jfc) |
| CMCD / CMSD | CMCD v1 + v2（1.7.0 起 `cmcd.version: 2`）；CMSD 未实现 | [v1.7.0 release](https://github.com/video-dev/hls.js/releases/tag/v1.7.0) |

1.7.0 关键新特性：`createIFramePlayer()`、`nextAudioTrack`、init segment 并行加载、`abrSwitchInterval`、`errorPenaltyExpireMs`、`liveMaxUnchangedPlaylistRefresh`、`appendTimeout`、`MEDIA_SOURCE_REQUIRES_RESET` 恢复机制。

低延迟直播核心配置（默认值）：

```ts
{
  lowLatencyMode: true,
  liveSyncDurationCount: 3,
  liveSyncDuration: undefined,
  liveMaxLatencyDuration: undefined,
  maxLiveSyncPlaybackRate: 1,
  backBufferLength: Infinity,   // 直播建议 30~90
  maxBufferLength: 30,
  startLevel: undefined, testBandwidth: true,
  abrEwmaDefaultEstimate: 500000, abrBandWidthFactor: 0.95,
  enableWorker: true, workerPath: null,
  preferManagedMediaSource: false,
  cmcd: { sessionId, contentId, useHeaders, version: 2, eventTargets }
}
```

## 2. mpegts.js（flv.js 后继）

- 最新 1.8.2（2026-08-14）、1.8.1（2026-08-06：Webpack 5/TS 5.9.3、PGS 字幕、`SEI_ARRIVED` 事件、修 iOS 26 MediaSource 检测与 Safari 26.5+ 卡死）；1.8.0（2024-12-24：MMS/iOS 17.1+、MSE in Workers、AV1、基于 playbackRate 的延迟追赶）。[npm](https://www.npmjs.com/package/mpegts.js)、[Releases](https://github.com/xqq/mpegts.js/releases)
- 维护状态：单一维护者，间歇式活跃；flv.js 停在 1.6.2（2021-09）。
- 桌面 HTTP-FLV 在 2026 仍是 1–3 s 档的实用选择（SRS 生态），定位"中间档"。[SRS blog](https://ossrs.net/lts/en-us/blog/hls-5s-low-latency)
- iOS：≤17.0 不可用（无 MSE），17.1+ 可通过 MMS 工作。

## 3. WebRTC 播放（WHEP）

- 标准化：`draft-ietf-wish-whep-04`（2026-06-22），尚未成为 RFC；WHIP 已是 RFC 9725。[IETF](https://datatracker.ietf.org/doc/draft-ietf-wish-whep/)
- 客户端库普遍更新慢（WHEP 本质只是 fetch + RTCPeerConnection 约 50 行）：`@eyevinn/whep-video-component` 0.1.0（2023-09）、`whip-whep` 1.2.0（2024-05）。
- 服务端自带播放器：SRS `http://host:1985/rtc/v1/whep/?app=live&stream=xxx`；MediaMTX `http://host:8889/<stream>/whep`。[SRS](https://ossrs.net/lts/en-us/docs/v5/doc/webrtc)、[MediaMTX](https://mediamtx.org/docs/read/webrtc)
- 实测延迟：MediaMTX 四个生产部署 P50 180–740 ms、P95 240–1180 ms；Cloudflare Stream WebRTC <500 ms，2026-10-15 起 GA 计费（$1/1000 min）。[AdaptNXT](https://www.adaptnxt.com/blogs/mediamtx-whip-whep-latency-benchmarks-4-deployments)、[Cloudflare](https://developers.cloudflare.com/stream/webrtc-beta/)

## 4. Media over QUIC（MoQ）

- `draft-ietf-moq-transport-17`（2026-05），未成 RFC。WebTransport 于 Safari/iOS 26.4（2026-03/04）落地，三大浏览器全覆盖。[webrtc.ventures](https://webrtc.ventures/2026/04/webtransport-is-now-baseline-what-it-means-for-real-time-media/)
- Cloudflare 2025-08-22 上线 MoQ relay tech preview；JS 库 `@moq/hang` 0.4.3。[Cloudflare blog](https://blog.cloudflare.com/moq/)
- 结论：2026 属于"可试点、不宜作为主路径"。

## 5. UI 层

| 库 | 最新版本 | 维护/React 友好度 |
|---|---|---|
| Vidstack | `next` 1.15.6；`latest` 仍是 0.6.15（2024） | 作者已加入 Mux，轻维护，重心转向 Video.js v10。[Discussion #1755](https://github.com/vidstack/player/discussions/1755) |
| media-chrome | 4.19.2 | Mux 维护、Web Components + 官方 React 包装，稳定 |
| Video.js 8 | 8.24.0 | 维护模式；没有 v9，直接跳到 v10 |
| Video.js v10 | `@videojs/core`/`@videojs/react` 10.0.0-rc.2（2026-09-09） | Mux 主导，Vidstack + Media Chrome + Plyr 合流；GA 定在 2026 秋。[Mux blog](https://www.mux.com/blog/videojs) |
| Shaka Player | 5.2.10 | Google 维护；`streaming.lowLatencyMode`；包体约为 hls.js 两倍 |
| dash.js | 5.2.1 | 仅 DASH；唯一实现 CMSD 的主流播放器 |

## 6. 协议对比

| | HLS | LL-HLS | HTTP-FLV | WebRTC (WHEP) |
|---|---|---|---|---|
| 玻璃到玻璃延迟 | 20–45 s（SRS 调优可到 5 s） | 2–4 s | 1–3 s | 0.1–0.5 s |
| CDN 兼容 | 任何 HTTP CDN | 需 HTTP/2 + 支持 blocking reload 的 CDN | 需长连接透传，多用自建边缘 | 需 SFU/WebRTC CDN，单价高 |
| iOS Safari | 原生 | 原生 | 仅 iOS 17.1+ 经 MMS | 原生 WebRTC，移动端多 100–250 ms jitter |
| 成本 | 最低 | 略高（请求数×10） | 中 | 最高 |
| 典型场景 | 点播式直播 | 直播带货、新闻、赛事 | 国内秀场/游戏直播桌面端 | 拍卖、连麦、互动竞猜 |

来源：[Mux](https://www.mux.com/articles/low-latency-live-streaming-developers-guide-ll-hls-webrtc-cmaf)、[SRS](https://ossrs.net/lts/en-us/blog/hls-5s-low-latency)

## 7. 起播时间优化（2025–2026 推荐）

1. `<link rel="preconnect">` 到 manifest/分片域名：实测省 ~450 ms。[Heart Internet](https://www.heartinternet.uk/blog/streaming-video-on-the-web-a-performance-review-of-popular-javascript-players/)
2. 包体与压缩：hls.js 71 KB vs Shaka 140 KB / video.js 133 KB。
3. 首档位策略：`startLevel` 固定中低档 + `testBandwidth:false` + `abrEwmaDefaultEstimate`（从 localStorage 恢复上次估值）；`startFragPrefetch:true`。
4. 减小起播缓冲：`liveSyncDuration` 1–2 s + `maxLiveSyncPlaybackRate:1.5`；`backBufferLength` ≤30。
5. 1.7.0 init segment 并行加载直接缩短 TTFF。
6. fMP4/CMAF 优于 TS：LL-HLS Partial Segment 要求 CMAF；fMP4 无需 transmux。[Ant Media](https://antmedia.io/low-latency-hls-or-ll-hls/)
7. 服务端参数：2 s 分片、200–500 ms part、hold time 3–5 s、`CAN-BLOCK-RELOAD=YES`。
8. HTTP/3：需 CDN 实现 RFC 9218 优先级；HTTP/2 仍是 LL-HLS 基线。
9. 确认 Worker 真正启用：Vite 下 `import workerUrl from 'hls.js/dist/hls.worker.js?url'` 传给 `workerPath`。

## Recommendations

- (a) 默认广兼容路径：hls.js 1.7.x + LL-HLS(CMAF)；iOS Safari 走原生 `<video src=m3u8>`；开启 CMCD v2。
- (b) 低延迟桌面路径：mpegts.js 1.8.2（HTTP-FLV），仅桌面 Chromium/Firefox 且已有 FLV 边缘时启用；封装适配层并锁版本。
- (c) 亚秒互动路径：自写 ~50 行 WHEP client（POST SDP → 201/Location → ICE），服务端 MediaMTX/SRS/Cloudflare Stream。MoQ 作为 2027 备选。
- UI 层：media-chrome 4.19.x（React 包装），预留迁移到 Video.js v10 `@videojs/react`。三种引擎都只输出到同一个 `<video>`，UI 与引擎解耦。
