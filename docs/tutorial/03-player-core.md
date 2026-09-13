# 03 · 播放器内核适配层：hls.js / mpegts.js / WHEP

## 目标

写出一个"引擎可替换、UI 不感知、指标口径统一"的播放器内核层。这是直播前端最核心的一块代码，也是面试里最容易被追问细节的地方。

## 原理：三层分离

```
┌──────────────────────────── UI 层（media-chrome / Video.js v10）───────────────────────────┐
│  只关心 <video> 的 paused / volume / fullscreen，不知道流是怎么来的                         │
├──────────────────────────── 控制层 PlayerController ──────────────────────────────────────┤
│  输入 pathways + policy → 选引擎 → 回退链 → 卡顿恢复阶梯 → 产出统一的 QoE 事件              │
├──────── HlsEngine ───────┬──────── FlvEngine ───────┬──────── WhepEngine ───────┬─ Native ─┤
│  hls.js 1.7 (MSE)        │  mpegts.js 1.8 (MSE)     │  RTCPeerConnection        │ <video src>│
└──────────────────────────┴──────────────────────────┴───────────────────────────┴──────────┘
                                          ▼ 都只写同一个 <video>
```

所有引擎实现同一个接口（`packages/player-core/src/types.ts`）：

```ts
export interface PlayerEngine {
  readonly kind: 'hls' | 'flv' | 'whep' | 'native-hls';
  load(video: HTMLVideoElement, src: string, opts: EngineOptions): Promise<void>;
  destroy(): void;
  getStats(): EngineStats;        // latencyMs, bufferMs, bitrateKbps, level, dropped/total frames, playbackRate
  setLevel(level: number): void;  // -1 = auto
  seekToLive(): void;
  on(event, cb): () => void;      // ready | playing | stall_start | stall_end | level_switch | error | stats | log
}
```

接口里没有任何 hls.js 或 mpegts.js 的类型泄漏——这就是"引擎可替换"的全部秘密。

## 代码走读

### HlsEngine（`engines/hls.ts` + `hls-config.ts`）

`buildHlsConfig` 是纯函数，把"业务意图"翻译成 hls.js 配置：

```ts
{
  lowLatencyMode: true,
  liveSyncDuration: targetLatencySec,          // 目标延迟（秒）
  liveMaxLatencyDuration: targetLatencySec * 3, // 超过就 seek 到 live edge
  maxLiveSyncPlaybackRate: 1.5,                // 落后时 1.5x 追帧，而不是跳
  backBufferLength: 30,                        // 直播不需要无限回看缓冲
  enableWorker: true, workerPath: workerUrl,   // ESM 构建必须显式给 worker URL，否则静默失效
  startFragPrefetch: true,
  startLevel: -1, abrEwmaDefaultEstimate: 从 localStorage 恢复的上次带宽,
  testBandwidth: 没有历史带宽时才做试探,
  cmcd: { sessionId, contentId, version: 2 },  // CDN 日志关联
  fetchSetup / xhrSetup: requestTransform      // 弱网代理、多 CDN 改写
}
```

错误处理是 hls.js 用法里最容易写错的部分：

- 非致命错误（`fatal: false`）：hls.js 自己重试，我们只记日志。
- 致命 `NETWORK_ERROR`：先 `hls.startLoad()` 重新拉流一次；10s 内再次致命才上报 `fatal:true`。
- 致命 `MEDIA_ERROR`：先 `hls.recoverMediaError()`（重建 SourceBuffer）一次。
- 其余致命：直接上报，交给控制层切线路。

### FlvEngine（`engines/flv.ts`）

mpegts.js 的两个延迟策略同时开：`liveBufferLatencyChasing`（缓冲超过 `MaxLatency` 直接 seek）与 `liveSync`（超过阈值提高 playbackRate）。SRS 开着 GOP cache，新观众进来会先收到一大段缓存，靠 chasing 才能贴到 live edge。iOS ≤17.0 没有 MSE，`mpegts.isSupported()` 为 false 时控制层不会选它。

### WhepEngine（`engines/whep-client.ts`）

WHEP 只是 50 行 fetch：

```ts
pc.addTransceiver('video', { direction: 'recvonly' });
pc.addTransceiver('audio', { direction: 'recvonly' });
await pc.setLocalDescription(await pc.createOffer());
await waitIceGatheringComplete(pc, 1000);          // MediaMTX 期望非 trickle
const res = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/sdp' }, body: pc.localDescription.sdp });
// 201 + Location = 资源 URL；body = answer SDP
await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
// 结束：DELETE resourceUrl
```

统计来自 `pc.getStats()` 的 `inbound-rtp`：`framesDropped`、`jitterBufferDelay/jitterBufferEmittedCount`。市面上的 WHEP 客户端库大多停更于 2023–2024，自写反而最省心。

### PlayerController（`controller.ts`）

```ts
selectPathways(pathways, policy, caps, force?)
  // 按终端能力过滤（whep 需 webrtc；flv 需 MSE/MMS；llhls 需 MSE/MMS/原生 HLS）
  // 排序：force > policy.preferred > priority
start()
  // 逐条尝试；ready 超时（maxStartupMs×2）或 fatal → recovery_action{switch_pathway|switch_protocol} → 下一条
  // 全部失败 → error{type:'controller', detail:'all_pathways_failed'}
卡顿阶梯（每次 stall_start 前进一步，60s 无卡顿重置）
  nudge → seek_live → downgrade(setLevel(0)，30s 后恢复 auto) → switch_pathway → switch_protocol
```

每一步都作为 `recovery_action` 事件进入遥测，所以 Grafana 里能看到"多少会话靠切线路救回来了"。

### 起播的最后一步：谁来调 `play()`

`apps/web/src/hooks/use-player.ts` 不用 `autoplay` 属性，而是在媒体 `canplay` 时由脚本调用 `play()`，并在首帧后"解除武装"（换线路时重新武装）。原因有二：`play()` 早于引擎 attach 会被"new load request"打断；Chrome 会把由 `autoplay` 属性启动的静音视频在隐藏页签里暂停，脚本 `play()` 则不会。浏览器拒绝有声播放时退回静音起播并提示点击喇叭。

## 动手实验

1. `/room/demo` 按 `i` 打开 QoE 浮层，点 `flv@local-flv` / `whep@local-rtc` 按钮手动切线路，观察 `recovery_action` 事件与 TTFF 差异。
2. 停掉 SRS（`docker stop livelab-srs`）后切到 FLV：观察 fatal → `switch_pathway` 自动回退。
3. 在 DevTools → Application → Local Storage 看 `livelab.bw`：第二次进房的 `testBandwidth` 会被跳过，起播更快。
4. 单元测试：`pnpm --filter @livelab/player-core test`（74 个用例，全部用假引擎与假 RTCPeerConnection，不依赖浏览器媒体能力）。

## 度量

`video.first_frame.ttffMs` 按 `protocol`/`cdn` 分组；`video.recovery_action.action` 分布；`video.error.err_detail` Top N。

## 生产注意事项

- **锁版本**：hls.js 小版本也会改默认行为（1.7 把 `lowLatencyMode` 默认打开）；mpegts.js 单人维护、发版间隔长。
- **Worker 路径**：Vite 用 `import url from 'hls.js/dist/hls.worker.js?url'`；CDN 部署时确保同源或 CORS。
- **iOS**：无 MSE 时走 `NativeHlsEngine`（`<video src=m3u8>`），拿不到 hls.js 的统计，用 `getVideoPlaybackQuality()` 兜底。
- **DRM**：hls.js `KEY_SYSTEM_*` 错误单独归类，别混进网络错误。

## 面试/复盘要点

- 三层分离的理由：UI 库要换（Video.js v10 即将 GA）、引擎要换（MoQ 2027）、指标口径不能变。
- 能讲清 hls.js 的致命错误恢复顺序，以及为什么"先自愈一次再切线路"。
- 知道 WHEP 请求/响应的三要素：SDP offer、201 + Location、DELETE 释放。
