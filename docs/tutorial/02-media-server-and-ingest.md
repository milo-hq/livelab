# 02 · 本地媒体服务器与推流

## 目标

一条命令拉起与生产同构的"接入 → 封装 → 分发"链路，并理解每个端口、每个配置项在线上对应什么。

## 选型：为什么是 MediaMTX

| 项目 | 版本（2026-09） | 推流 | 播放 | 结论 |
|---|---|---|---|---|
| MediaMTX | 1.21.0 | RTSP/RTMP/SRT/WHIP/HLS/MoQ | LL-HLS/WHEP/RTSP/RTMP/SRT/MoQ | 单二进制、协议最全，本地首选 |
| SRS | 6.0-r1（7.0 dev） | RTMP/SRT/WHIP/GB28181 | HTTP-FLV/HLS/DASH/WHEP | 国内 CDN 常见的 HTTP-FLV 路径，作为第二选择 |
| OvenMediaEngine | 0.21.0 | RTMP/SRT/WHIP | LLHLS/WebRTC | LLHLS+WebRTC 参考实现，配置较重 |
| nginx-rtmp | 2024-12 最后提交 | RTMP | HLS/DASH | 停滞，不推荐 |

## 代码走读

### `infra/docker-compose.yml`

| 服务 | 镜像 | 端口 | 线上对应 |
|---|---|---|---|
| mediamtx | `bluenviron/mediamtx:1.21.0` | 1935 RTMP · 8888 HLS · 8889 WebRTC · 8189/udp ICE · 8890/udp SRT · 9997 API | 云直播的接入点 + 封装 Origin + 实时边缘 |
| pusher | `linuxserver/ffmpeg` | — | 主播的 OBS |
| srs（profile `flv`） | `ossrs/srs:6` | 1936 RTMP · 8080 HTTP-FLV · 1985 API | 国内 CDN 的 FLV 边缘 |
| redis | `redis:7-alpine` | 6390 | IM 扇出与在线态 |
| clickhouse | `clickhouse/clickhouse-server:26.8` | 8123 | QoE 事件仓库 |
| grafana | `grafana/grafana:13.2.1` | 3000 | 质量看板与告警 |

### `infra/mediamtx.yml` 中真正重要的几行

```yaml
hlsAlwaysRemux: true      # 有推流就开始切片，而不是等第一个观众来——省掉观众的 muxer 预热 ≈ 1–2s 起播
hlsVariant: lowLatency    # LL-HLS：Partial Segment + 阻塞式清单刷新
hlsSegmentDuration: 1s
hlsPartDuration: 500ms    # Apple 建议 200–500ms；越小请求越多、延迟越低
hlsSegmentCount: 7        # 清单窗口 7s
webrtcAdditionalHosts: ["127.0.0.1", "localhost"]   # ICE 候选里宣告的地址；上云时改成公网 IP 或 TURN
```

还有一个只在开发环境这么做的地方：`authInternalUsers` 允许任何 IP 调 API（线上必须换成 `authHTTPAddress` 回调，用推流密钥鉴权）。

### `infra/pusher/push.sh`：不用素材文件的测试流

```sh
ffmpeg -re -f lavfi -i "testsrc2=size=1280x720:rate=30" -f lavfi -i "sine=frequency=440" \
  -/filter_complex /filter.txt \          # drawtext 烧录当前时钟 + split 出三路
  ... -f flv rtmp://mediamtx:1935/live/demo \
  ... -f flv rtmp://mediamtx:1935/live/demo_720 \
  ... -f flv rtmp://mediamtx:1935/live/demo_360
```

三点值得记住：

1. **`-re` + `-stream_loop`/lavfi** 让 ffmpeg 按实时速率推，而不是尽快推完。
2. **`-g 30 -keyint_min 30 -sc_threshold 0`**：固定 1s GOP，且禁止场景切换插关键帧。切片边界必须落在关键帧上，GOP 不固定会让 LL-HLS 的分片时长漂移、起播变慢。
3. **烧录时钟**：`drawtext=text='%{localtime}'`，观众端画面时间与手机时间之差就是端到端延迟。ffmpeg 7+ 用 `-/filter_complex FILE` 读滤镜脚本，绕开 `:` 的两层转义。

三路是为了 ABR：`demo_720`（2.5Mbps）和 `demo_360`（0.7Mbps）由 api 拼成一个多码率 master playlist（见第 04 章），hls.js 才有档位可切。

## 动手实验

```bash
pnpm infra:up
curl -s localhost:9997/v3/paths/list | jq '.items[] | {name, ready, tracks}'
curl -s 'localhost:8888/live/demo/index.m3u8?cookieCheck=1'
```

注意第一次 `curl` 不带 `?cookieCheck=1` 会得到 302：MediaMTX 对无 `Origin` 头的普通请求做一次 cookie 探测；浏览器 XHR/fetch 自带 `Origin`，直接 200。这是排障时常见的"curl 不通但浏览器通"。

用 OBS 替换测试流：设置 → 直播 → 服务 Custom，服务器 `rtmp://localhost/live`，密钥 `demo`。或者 WHIP：服务 WHIP，服务器 `http://localhost:8889/live/demo/whip`。

HTTP-FLV：`pnpm infra:flv`，然后 `curl -s -o /dev/null -w '%{http_code} %{size_download}\n' -m 3 http://localhost:8080/live/demo.flv`。

## 度量

`curl -s localhost:9998/metrics | grep -E "^(paths|hls_muxers|webrtc_sessions)"` 是 MediaMTX 的 Prometheus 指标：推流字节、观众数、WebRTC 会话——主播控制台的"健康度卡片"就读这里的 JSON 版本 `/v3/paths/get/live/demo`。

## 生产注意事项

- 接入点要**就近**：跨境主播先接本地 PoP，再经专线回源（阿里云 GA / 腾讯 GAAP，需联通跨境资质）。
- 转码 ABR 阶梯 2026 常见值：1080p 4.5M / 720p 2.5M / 540p 1.4M / 360p 0.7M / 纯音频 64–96k；最低档纯音频是弱网的底线。
- WebRTC 上云要配 TURN 与 `webrtcAdditionalHosts`，否则 NAT 后的观众连不上。
- 推流鉴权：`authHTTPAddress` 回调你的 api 校验 stream key，禁止匿名推流。

## 面试/复盘要点

- 说得出 LL-HLS 的 part duration、segment duration、窗口大小与延迟/请求量的关系。
- 知道 GOP 固定为什么影响起播与切片。
- 能解释 `hlsAlwaysRemux` 这类"预热"型优化：把成本从观众的首帧移到服务端常驻。
