# 跨境直播平台 媒体后端 / 云直播 / CDN 选型报告（2026-09）

> 版本号、日期、价格均来自 2026-09-13 抓取的官方页面 / GitHub API / Docker Hub。

## 1. 自托管开源媒体服务器

| 项目 | 最新稳定版 | 推流 Ingest | 播放 Egress | 官方 Docker |
|---|---|---|---|---|
| SRS | `v6.0-r1`（2026-08-12）；`v7.0-d0` pre-release | RTMP、SRT、WHIP、GB28181 | HTTP-FLV、HLS、HTTP-TS、DASH、WHEP | `ossrs/srs:6`；端口 1935 / 1985(API) / 8080(HTTP) / 8000udp(WebRTC) / 10080udp(SRT) |
| MediaMTX | `v1.21.0`（2026-09-05） | RTSP、RTMP(S)、SRT、WHIP、HLS、MPEG-TS、MoQ | RTSP、RTMP、SRT、WHEP、HLS（Low-Latency 模式）、MoQ | `bluenviron/mediamtx:1.21.0`；端口 8554 / 1935 / 8888(HLS) / 8889(WebRTC) / 8890(SRT) |
| OvenMediaEngine | `v0.21.0`（2026-08-13） | RTMP、SRT、WHIP、MPEG-TS | WebRTC、LLHLS、HLS | `airensoft/ovenmediaengine:latest` |
| nginx-rtmp-module | master 最后提交 2024-12-24 | RTMP | HLS/DASH | 无官方镜像 |

要点：
- SRS 6 不支持 LL-HLS，但 HTTP-FLV + WHEP 是国内直播平台最常见低延迟组合。
- MediaMTX 是唯一在一个静态二进制里同时覆盖 RTMP/SRT/WHIP/WHEP/LL-HLS/MoQ 的项目；v1.21.0 修复 CORS 默认策略。
- nginx-rtmp 停滞，2026 年不建议新项目采用。

本地开发推荐：MediaMTX；SRS 作为第二选择验证 HTTP-FLV 路径。

来源：https://github.com/ossrs/srs/releases · https://github.com/bluenviron/mediamtx/releases · https://mediamtx.org/docs/read/hls · https://github.com/OvenMediaLabs/OvenMediaEngine/releases

## 2. 云直播托管服务（2026 特性 + 计费）

| 服务 | 关键能力 | 计费模型 |
|---|---|---|
| AWS IVS | Low-Latency（HLS 2–5s）与 Real-Time（WebRTC <300ms）；Multitrack | LL 输入按小时 $0.20–$2.00/h；LL 输出按观众小时 $0.0072–$0.144/h；RT $0.072/参会者小时 |
| Cloudflare Stream Live | RTMPS/SRT/WHIP 推流；HLS/DASH/WHEP 播放；LL-HLS 开放测试版（~3s）；WHIP/WHEP GA，2026-10-15 起计费 | $1 / 1000 分钟播放，$5 / 1000 分钟录制 |
| Mux Video Live | plus/premium 档，最高 1080p | 编码 $0.02375–$0.044531/min；分发前 10 万分钟免费 |
| 阿里云 视频直播 + RTS | RTS 基于 ARTC（WebRTC）`artc://`，200–800ms；直播封装提供 LL-HLS（`-llhls.m3u8`） | RTS 内地 0.396 元/GB→0.2475；亚太 0.812–1.17；北美/欧洲 0.69 元/GB |
| 腾讯云 CSS + 快直播 LEB | LEB `webrtc://` 毫秒级 | 内地 0.52 元/GB→0.32；境外分区 0.56–2.40 元/GB |
| 火山引擎 veLive | 标准直播 + RTM（`.sdp`）+ 低延时 FLV | 价格页 JS 渲染未能抓取 |
| Agora | Broadcast Streaming / ILS | $0.59–$17.99 / 1000 分钟；每月 1 万分钟免费 |

中国合规与跨境加速：
- ICP：内地加速/直播域名必须备案；Cloudflare China Network 由 JD Cloud 运营，Stream 未列为支持产品。
- 阿里云直播全球加速（GA）、腾讯云 GAAP：跨境通道需联通跨境资质审核。

来源：https://aws.amazon.com/ivs/pricing/ · https://developers.cloudflare.com/stream/webrtc-beta/ · https://help.aliyun.com/zh/live/billing-of-rts · https://cloud.tencent.com/document/product/267/39136 · https://docs.agora.io/en/broadcast-streaming/overview/pricing

## 3. HLS / LL-HLS 的 CDN 要求与多 CDN 策略

LL-HLS 对 CDN 的硬性要求：
1. 不再需要 HTTP/2 Push；HTTP/1.1 chunked、HTTP/2、HTTP/3 均可。
2. 阻塞式 playlist reload：`_HLS_msn` / `_HLS_part` / `_HLS_skip` 必须进入 CDN 缓存键。
3. Part 200–500ms；清单 `Cache-Control: max-age=1`；Preload Hint、Rendition Report、Delta Update。
4. 请求量放大（6s 切片 + 200ms Part × 5 档 = 每 6s 150 请求），request collapsing 是成本关键。

CDN 支持：Akamai、CloudFront、Cloudflare、Fastly 均支持 LL-HLS 但需显式配置缓存键；阿里云"直播封装"提供 LL-HLS。

多 CDN 调度：DNS 切换（粗）→ 302/HTTPDNS 调度（国内主流）→ 客户端切换 → HLS Content Steering（hls.js 已支持，steering server 返回 JSON 实时切换 pathway 不丢缓冲）。

国内大厂实践：
- 快手：KTP + 多 CDN 智能调度（Flink 实时调整配比）；HTTPDNS 后首屏 -30%、百秒卡顿 -20%。
- B站：HLS + P2P（fMP4/CMAF 0.5–1s 切片）；首帧 = 流地址查询 + 网络传输 + 解码三段；备用 URL 故障切换，卡顿率 1.2%→0.56%。
- 抖音/火山：FLV 2–3s、RTM <1s；BVC 编码 + ROI。

来源：https://www.forasoft.com/learn/video-streaming/articles-streaming/ll-hls-deep-dive · https://dev.to/masonwritescode/build-multi-cdn-failover-with-hls-content-steering-hlsjs-and-a-40-line-server-1l8i · https://www.infoq.cn/article/gG2hKhBv5YpgmhX6H9pQ

## 4. 弱网技术（分发侧）

- LL-HLS（TCP，有缓冲兜底）vs WebRTC（UDP + NACK/FEC，对丢包敏感）；策略：互动用 WebRTC，大盘 LL-HLS/FLV，互相降级。
- 腾讯云弱网手段：码率自适应；丢帧 B→P→I；SVC；FEC + ARQ；PacedSender；BBR；302 调度；QUIC/SRT。
- SRT 贡献链路：1s 缓冲可恢复 ~25% 丢包；OBS latency ≥ 2.5×RTT。
- 直播 ABR 阶梯（H.264）：1080p 4.5M / 720p 2.5M / 540p 1.4M / 360p 0.7M / 纯音频 64–96k。
- 纯音频降级作为最低档。
- 跨境就近接入：推流端接本地 PoP，跨境走专线；播放端 HTTPDNS/302 按 IP 调度；内地观众落 ICP CDN。

## 5. 本地开发推流工具

FFmpeg 9.0.1（2026-08-12）；8.0 起内置 WHIP muxer。

```bash
# RTMP 循环推送
ffmpeg -re -stream_loop -1 -i test.mp4 -c copy -f flv rtmp://localhost:1935/live/test
# SRT（MediaMTX 8890）
ffmpeg -re -stream_loop -1 -i test.mp4 -c copy -f mpegts 'srt://localhost:8890?streamid=publish:live/test&pkt_size=1316'
# WHIP（MediaMTX 8889）
ffmpeg -re -stream_loop -1 -i test.mp4 -c:v libx264 -pix_fmt yuv420p -preset ultrafast -tune zerolatency -g 60 -b:v 1500k -c:a libopus -ar 48000 -ac 2 -b:a 128k -f whip http://localhost:8889/live/test/whip
```

OBS 32.2.2：RTMP Server `rtmp://localhost/live` Key `test`；WHIP Server `http://localhost:8889/live/test/whip`；SRT `srt://localhost:8890?streamid=publish:live/test&mode=caller&latency=120000`。

## Recommendations

### (a) 本地开发栈
MediaMTX 1.21.0 + FFmpeg + OBS；hls.js（LL-HLS）+ 原生 WHEP。

```yaml
services:
  mediamtx:
    image: bluenviron/mediamtx:1.21.0-ffmpeg
    ports: ["8554:8554","1935:1935","8888:8888","8889:8889","8890:8890/udp","8189:8189/udp"]
    environment:
      MTX_HLSVARIANT: lowLatency
      MTX_HLSPARTDURATION: 500ms
      MTX_WEBRTCADDITIONALHOSTS: 127.0.0.1
      MTX_API: "yes"
```
播放：`http://localhost:8888/live/test/index.m3u8`（LL-HLS）、`http://localhost:8889/live/test/whep`。HTTP-FLV 用 `ossrs/srs:6`。

### (b) 生产云栈
1. 双主云 + 一海外云：内地 阿里云直播（FLV/HLS + RTS + LL-HLS 封装）或腾讯云 CSS + LEB；海外 Cloudflare Stream；<300ms 互动用 AWS IVS Real-Time。
2. 跨境链路：推流端就近接入；跨境同步走 GA / GAAP 专线。
3. 多 CDN：自建调度服务按 IP 地理 + 实时 QoE 返回 2–3 条 pathway；Web 用 HLS Content Steering；内地固定境内 CDN，海外默认 Cloudflare。
4. 协议策略：大盘 LL-HLS（海外）/ FLV+LL-HLS（内地）；带货/连麦 WebRTC，失败降级 LL-HLS；最低档纯音频。

### (c) 参考架构
```
主播 OBS/App ──RTMP/SRT/WHIP──▶ 就近 Ingest PoP（跨境经 GA/GAAP 专线）
        ▼
 转码/封装 Origin：5 档 ABR(1080p→audio-only)
   ├─ LL-HLS(fMP4, part 500ms) ──▶ 内地 CDN + Cloudflare + CloudFront
   ├─ HTTP-FLV(2-3s)           ──▶ 内地 CDN
   └─ WebRTC(<1s)              ──▶ 各云实时边缘
        ▼
 调度服务(HTTPDNS/302 + Content Steering，输入播放器 QoE 上报)
        ▼
 React+TS 播放器：hls.js / mpegts.js / 原生 WHEP；弱网降档→纯音频；失败切 pathway；上报 QoE
```

未能核实：火山引擎单价；腾讯云 LL-HLS 境外可用性；Cloudflare–JD Cloud 续约条款。
