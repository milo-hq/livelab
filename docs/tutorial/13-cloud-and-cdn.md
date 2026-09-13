# 13 · 上云与 CDN：跨境直播的生产方案

## 目标

把本地的 MediaMTX 换成云服务、把 `local-a/local-b` 换成真实 CDN，并给出一个中国公司服务"内地 + 东南亚 + 欧美"观众的多 CDN 方案与成本估算方法。所有价格为 2026-09-13 官方页面数据，采购前需复核。

## 云直播服务对比

| 服务 | 低延迟能力 | 亚秒能力 | 计费模型 | 适合 |
|---|---|---|---|---|
| 阿里云 视频直播 | 标准 FLV/HLS + 直播封装 LL-HLS（`-llhls.m3u8`） | RTS（ARTC/WebRTC，200–800ms） | 内地 0.396 元/GB 起；亚太 0.81–1.17；北美/欧洲 0.69 元/GB | 内地主力 |
| 腾讯云 云直播 CSS | 标准 + CMAF/LLHLS 封装 | 快直播 LEB（`webrtc://`） | 内地 0.52 元/GB 起；境外分区 0.56–2.40 元/GB | 内地主力 |
| Cloudflare Stream Live | LL-HLS（open beta ~3s） | WHIP/WHEP GA（2026-10-15 起计费） | $1 / 1000 分钟播放 | 海外主力，成本可预测 |
| AWS IVS | Low-Latency（2–5s） | Real-Time（<300ms） | 按输入小时 + 观众小时分区计价 | 海外互动 |
| 火山引擎 veLive | 低延时 FLV 2–3s | RTM（`.sdp`）<1s | 需商务询价 | 抖音生态 |
| Mux Video Live | LL-HLS | — | 编码分钟 + 分发分钟 | 快速集成 |
| Agora | — | 互动直播 | $0.59–17.99 / 1000 分钟 | 强互动/连麦 |

## 参考架构

```
主播 OBS/App ─RTMP(默认)/SRT(弱网)/WHIP(互动)─▶ 就近接入 PoP（内地：阿里/腾讯；海外：Cloudflare/IVS）
                                                  │ 跨境同步走 阿里云 GA / 腾讯 GAAP 专线（联通跨境资质）
                                                  ▼
                       转码 Origin：5 档 ABR（1080p 4.5M / 720p 2.5M / 540p 1.4M / 360p 0.7M / 纯音频 64–96k）
                       ├─ LL-HLS(fMP4, part 500ms, 阻塞刷新) ─▶ 内地 CDN + Cloudflare + CloudFront
                       ├─ HTTP-FLV(2–3s) ─────────────────────▶ 内地 CDN
                       └─ WebRTC(RTS/LEB/WHEP, <1s) ──────────▶ 各云实时边缘
                                                  ▼
                       调度服务：IP 地理 + ISP + 实时 QoE（播放器上报）→ 2–3 条 pathway（本项目的 /v1/rooms/:id/play）
                                                  ▼
                       React 播放器：hls.js / mpegts.js / WHEP；卡顿阶梯；切 pathway；上报 QoE
```

本项目的 `Pathway.cdn` 标签、`PlayPolicy` 与 `recovery_action` 事件就是这套架构的客户端半边；把 `buildPathways` 的 URL 换成云地址，前端不用改。

## 多 CDN 调度（由粗到细）

1. **DNS 切换**：粒度粗、受 TTL 限制。
2. **302 / HTTPDNS 调度**：请求级、秒级切换，国内直播主流；快手用 HTTPDNS 后首屏 −30%、百秒卡顿 −20%。
3. **客户端切换**：播放器持多条地址，失败/卡顿即切（本项目已实现）。
4. **HLS Content Steering**：标准化方案，hls.js/dash.js/AVPlayer 支持；steering server 返回 pathway 优先级 JSON，切换不丢缓冲。示例 steering 响应：

```json
{ "VERSION": 1, "TTL": 300, "RELOAD-URI": "https://steer.example.com/s?sid=…", "PATHWAY-PRIORITY": ["aliyun-cn", "cloudflare", "cloudfront"] }
```

在 master playlist 里加 `#EXT-X-CONTENT-STEERING:SERVER-URI="…",PATHWAY-ID="aliyun-cn"`，各 variant 用 `PATHWAY-ID` 标注。调度服务的输入正是第 11 章上报的 `cdn × region × isp` 的 TTFF/卡顿数据。

## LL-HLS 上 CDN 的核对清单

- [ ] `_HLS_msn` / `_HLS_part` / `_HLS_skip` 进入缓存键；
- [ ] 源站真正 hold 阻塞式请求（~50ms 内响应），而非立即返回旧清单；
- [ ] 清单 `Cache-Control: max-age=1` 或更短；part 200–500ms；
- [ ] 回源合并（request collapsing）开启：6s 切片 + 200ms part × 5 档 = 每 6s 150 请求；
- [ ] HTTP/2 起步；HTTP/3 需 CDN 实现 RFC 9218 优先级，否则可能劣化。

## 中国合规与跨境

- 内地加速/直播域名必须 ICP 备案；Cloudflare China Network 由京东云运营，Stream 不在其支持列表。
- 内地 ↔ 海外源流同步走阿里云 GA / 腾讯 GAAP，需申请联通跨境资质（预留 1–2 周）。
- 内地观众固定落境内 CDN；海外默认 Cloudflare，欧美峰值备 CloudFront；每周按各 CDN 质量与单价重排权重。

## 成本估算工作表

以"1 万并发 × 2 小时 × 720p 2.5Mbps"为例：流量 = 10000 × 7200 s × 2.5 Mbps ÷ 8 = 22.5 TB。

| 线路 | 单价 | 估算 |
|---|---|---|
| 阿里云内地 | 0.396 元/GB（0–10TB 档，阶梯更低） | ≈ 8,900 元 |
| 阿里云亚太 1 | 0.812 元/GB | ≈ 18,300 元 |
| Cloudflare Stream | $1 / 1000 观看分钟 | 10000 × 120 分钟 = 1.2M 分钟 ≈ $1,200 |
| AWS IVS RT（互动房间） | $0.072 / 参会者小时 | 1000 人 × 2 h ≈ $144 |

结论：海外用 Cloudflare 按分钟计费最可预测；内地按流量并利用阶梯价；互动只给需要的房间开。

<!-- widget:cost -->

## 迁移步骤（从本项目到云）

1. 推流：OBS 指向云接入地址；保留 SRT/WHIP 备选。
2. `buildPathways`：返回云播放地址，`cdn` 标签用真实 CDN 名。
3. 遥测：`region/isp` 由边缘（Cloudflare Workers / 阿里云 ESA）注入或按 IP 库解析。
4. 调度：先用客户端切换，稳定后接 Content Steering / HTTPDNS。
5. 观测：CDN 日志（CMCD `sid`）与 `qoe.events` 关联，看板增加"按 CDN"页。

## 面试/复盘要点

- 四种多 CDN 调度方式的粒度与代价。
- LL-HLS 上 CDN 的核对清单。
- ICP、跨境专线资质对架构与排期的影响。
- 能用工作表估算一场直播的分发成本。
