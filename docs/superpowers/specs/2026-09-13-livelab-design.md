# LiveLab —— 直播/视频播放前端全链路实践项目 设计文档

日期：2026-09-13
状态：已按调研结论定稿（自主模式，未经用户逐项确认；关键假设见 §1.3）

## 1. 目标与范围

### 1.1 目标
按照岗位描述（直播间播放、弹幕/IM、主播互动、付费、运营工具；起播速度、卡顿率、弱网、跨境；播放质量监控、埋点、异常采集）构建一个**可本地一键跑通、结构与线上产品一致**的教学级项目，并配套一份详细中文教程。技术选型不依赖既有经验，全部来自 2026-09 的市场调研（见 `docs/research/`）。

### 1.2 范围
包含：Web 端（React + TypeScript）观众直播间、主播控制台、管理后台；Node/TypeScript 后端（房间 API、IM 网关、钱包/支付 Mock、遥测入库）；本地媒体服务器与可观测性栈（Docker Compose）；教程与云/CDN 生产方案。
不包含：Flutter、Android/iOS 原生；真实支付渠道对接（仅 Mock + 生产接入说明）；DRM。

### 1.3 关键假设（自主决策）
1. 目标读者是有 React/TS 基础的前端工程师，希望系统掌握直播播放链路；教程用中文，代码注释与标识符用英文。
2. "类似线上版本"指架构与工程实践对齐一线平台（抖音/B站/Twitch 公开资料），而非像素级复刻某个产品。
3. 本地即可完整运行是硬约束；云服务只给出方案与接入点，不要求读者开通账号。
4. 后端用 TypeScript 自建（而非 Centrifugo/Go），以便教程用一种语言讲透协议；生产替代方案在文档中说明。

## 2. 技术选型（来自调研，2026-09-13 核实版本）

| 层 | 选择 | 版本 | 理由 |
|---|---|---|---|
| 包管理/构建 | pnpm workspaces + Turborepo | pnpm 10.25 / turbo 2.10 | 单仓多包，教程按包讲解 |
| 前端 | React + Vite + TypeScript | 19.3 / 8.3 / **5.9.3**（不用刚发布的 7.0） | Vite 8 Rolldown；TS 7 生态未跟上 |
| 样式/UI | Tailwind CSS 4 + 自写组件 | 4.3 | 直播间 UI 定制度高，不引入重型组件库；后台用同一套 |
| 路由 | react-router 8（declarative 模式，`react-router` + `react-router/dom`） | 8.3 | ESM-only，React ≥19.2.7 |
| 状态 | Zustand 5（房间/弹幕/播放器状态）+ TanStack Query 5（REST） | 5.0 / 5.102 | 高频实时数据用 Zustand 选择器避免重渲染 |
| 播放器内核 | hls.js（HLS/LL-HLS，CMCD v2）、mpegts.js（HTTP-FLV）、原生 WHEP（RTCPeerConnection） | 1.7.3 / 1.8.2 / 自写 | 三条路径：广兼容、低延迟桌面、亚秒互动 |
| 播放器 UI | media-chrome（`media-chrome/react`） | 4.19 | 与引擎解耦，可迁移 Video.js v10 |
| 弹幕 | 自研 Canvas 渲染器（lane 分配 + 节点池思想）+ Worker 可选 | — | 教学价值；算法参考 weizhenye/Danmaku |
| 礼物动画 | 自研 Canvas 粒子/序列动画 + 动画适配器接口（SVGA/alpha-MP4 留接口） | — | 不引入大依赖；文档说明生产格式 |
| 后端 | Fastify 5 + @fastify/websocket + ioredis + zod | 5.12 / 11.3 / 6.0 / 4.6 | TS 全栈；Redis Pub/Sub 扇出 |
| 数据库 | SQLite（better-sqlite3）用于房间/钱包/账本；Redis 用于在线态/消息历史 | — | 本地零配置；账本用事务演示幂等 |
| 媒体服务器 | MediaMTX（RTMP/SRT/WHIP 推，LL-HLS/WHEP 播）；SRS 6（HTTP-FLV，可选 profile） | 1.21.0 / 6.0-r1 | 单二进制、协议最全 |
| 测试流 | FFmpeg lavfi 测试图 + 烧录时间戳 + 正弦音 | 9.0 | 无需素材文件；可目测延迟 |
| 遥测存储/看板 | ClickHouse + Grafana（ClickHouse datasource） | 26.8 / 13.2 | 事件级 QoE 分析 |
| 测试 | Vitest 5 + Playwright 1.63 | — | 单元 + 端到端冒烟 |

## 3. 系统架构

```
                      ┌────────────────────────────────────────────┐
 OBS / ffmpeg pusher ─┤ MediaMTX  RTMP:1935  HLS:8888  WebRTC:8889 │
                      │ SRS(可选) RTMP:1936  HTTP-FLV:8080         │
                      └───────────────┬────────────────────────────┘
                                      │ LL-HLS / WHEP / FLV
┌──────────────┐   REST + WS    ┌─────┴──────────┐   ClickHouse HTTP   ┌────────────┐
│ apps/web     │◄──────────────►│ apps/api       │────────────────────►│ ClickHouse │
│ React 19     │                │ Fastify 5      │                     └─────┬──────┘
│ 观众/主播/后台│                │ rooms · im · │   Redis pub/sub             │
└──────────────┘                │ wallet · pay · │◄──────────► Redis      ┌────┴────┐
                                │ telemetry ·    │                        │ Grafana │
                                │ weaknet-proxy  │                        └─────────┘
                                └────────────────┘
```

### 3.1 仓库结构
```
livelab/
  apps/
    web/                 观众端 + 主播控制台 + 管理后台（一个 SPA，按路由分包）
    api/                 Fastify 服务（REST、WS 网关、支付 Mock、遥测入库、弱网代理）
  packages/
    protocol/            前后端共享的消息/事件 zod schema 与类型
    player-core/         播放器内核适配层（引擎接口、三引擎、回退链、QoE 探针）
    danmaku/             弹幕渲染引擎（Canvas，lane 分配，Worker 可选）
    telemetry/           浏览器遥测 SDK（事件队列、批量上报、采样、环形日志）
  infra/
    docker-compose.yml   mediamtx / srs(profile) / redis / clickhouse / grafana / pusher
    mediamtx.yml, srs.conf, clickhouse/init.sql, grafana/provisioning/*
  docs/
    tutorial/            教程章节 00–13
    research/            四份调研报告
    superpowers/         设计与计划
```

### 3.2 数据流
1. **播放**：`apps/web` 请求 `GET /v1/rooms/:id/play` → 得到 pathway 列表（每条含 protocol、url、cdn 标签、优先级）→ `player-core` 按设备能力与房间模式选引擎并按回退链尝试 → `<video>` 由 media-chrome 包裹。
2. **IM**：WS `ws://api/ws?room=&token=` → 握手 `hello{seq}` → 服务端补发 `seq` 之后的历史 → 心跳 25s → 消息按 `lane`（chat/gift/system）下发，服务端 150ms 批帧，大房间对 chat 抽样。
3. **付费**：`POST /v1/wallet/recharge` 创建订单 → 跳转 `/pay/mock/:orderId` → 用户点击"支付成功" → mock-pay 异步（含随机延迟/重复）POST 带 HMAC 的 webhook → 幂等入账（事件表唯一键）→ 前端轮询订单状态；`POST /v1/gifts` 带 `Idempotency-Key`，服务端查价、事务内 `balance >= price` 扣减、写账本、发布 `gift` 到房间。
4. **遥测**：`telemetry` SDK 收集 `player-core` 标准事件 + web-vitals → 批量 `fetch keepalive` → `POST /v1/telemetry` → ClickHouse `qoe.events`；Grafana 看板与告警读取 ClickHouse。hls.js 开启 CMCD v2，`sid` = 遥测 session_id。
5. **运营**：主播控制台调用 MediaMTX API（`/v3/paths/get/:name`）读取推流健康度；管理后台读 Redis 在线数 + ClickHouse 聚合。

## 4. 各模块设计

### 4.1 `packages/protocol`
- zod schema：`ClientFrame`（`hello|ping|chat|like|gift_ack|...`）、`ServerFrame`（`welcome|pong|batch|chat|gift|like_agg|system|pin|poll|announce|mod_action|cohost_*`），每条 `ServerFrame` 带 `seq`（房间内单调递增）与 `lane`。
- REST DTO：Room、Pathway、Wallet、Order、Gift、TelemetryBatch。
- 单一真相：前后端都从这里导入类型，禁止手写重复类型。

### 4.2 `packages/player-core`
接口：
```ts
interface PlayerEngine {
  readonly kind: 'hls' | 'flv' | 'whep'
  load(video: HTMLVideoElement, src: string, opts: EngineOptions): Promise<void>
  destroy(): void
  getStats(): EngineStats           // latency, buffer, bitrate, level, dropped/total frames
  on(event: EngineEvent, cb): () => void   // 标准化事件：ready, playing, stall_start, stall_end, level_switch, error(fatal?), latency
}
```
- `HlsEngine`：LL-HLS 配置预设（`lowLatencyMode`、`liveSyncDuration`、`maxLiveSyncPlaybackRate`、`backBufferLength`、`startLevel`+`abrEwmaDefaultEstimate` 从 localStorage 恢复、`workerPath` 显式）、CMCD v2、错误恢复（`recoverMediaError`/重建）。iOS Safari 无 MSE 时走原生 `src`。
- `FlvEngine`：mpegts.js 追帧参数、`STATISTICS_INFO` 转标准 stats。
- `WhepEngine`：自写 WHEP（POST SDP offer → 201 + Location → ICE trickle 可选 → DELETE 释放），`connectionState` 监控，`getStats()` 提取 `framesDropped/jitterBufferDelay/packetsLost`。
- `PlayerController`：输入 pathway 列表 + 策略 → 选择引擎 → 卡顿恢复阶梯（nudge → 降档 → seek-to-live → 切 pathway → 切协议）→ 每步发 `recovery_action` 事件；用于跨境/弱网演示。
- `QoeProbe`：从 `<video>` 事件与引擎事件计算 TTFF、卡顿（≥200ms，排除首帧前/seek/暂停）、掉帧、延迟，输出给 telemetry。
- 能力探测：`MediaSource`/`ManagedMediaSource`/原生 HLS/WebRTC。

### 4.3 `packages/danmaku`
- `DanmakuRenderer(canvas, opts)`：`emit(item)`、`pause()`、`resume()`、`resize()`、`setSpeed()`；lane 分配算法：每 lane 记录最后一条的右端与速度，追尾判定；掉帧时以 `dt` 推进；`visibilitychange` 暂停并清队列；实时模式（直播）与时间轴模式（回放）。
- 客户端限流：每秒最多 N 条上屏，超限丢弃，礼物/系统消息不受限。
- Worker 模式：`OffscreenCanvas` 可选（特性检测）。

### 4.4 `packages/telemetry`
- `createTelemetry({endpoint, sampleRates, context})`：`track(name, attrs)`、`heartbeat` 定时、`flush()`；内存队列 ≥20 条或 5s 批发；`fetch(..., {keepalive:true})`；`visibilitychange=hidden` 立即 flush；session_id（标签页级）/ view_id（每次起播）；环形日志 500 条；致命错误附最近 60s resource timing；`web-vitals` 6 采集 INP/LCP/CLS；`report_issue()` 强制 100% 采样。
- 事件名：`video.play_attempt, first_frame, stall_start, stall_end, level_switch, latency_sample, heartbeat, error, recovery_action, end, report_issue`，`web.vital`。

### 4.5 `apps/api`
- 模块：`rooms`（CRUD、play pathways、steering 策略参数）、`im`（WS 网关：房间订阅、seq、历史 ring in Redis、批帧、抽样、慢速模式、禁言、关键词过滤、心跳）、`wallet`（余额、充值订单）、`pay-mock`（收银台页面 + webhook 投递器）、`gifts`（下单、幂等、账本、广播）、`interaction`（点赞聚合、投票、置顶、公告、连麦信令）、`telemetry`（校验 + ClickHouse 批量写）、`weaknet`（HLS/FLV 反向代理，注入延迟/丢包/限速，供弱网实验）、`admin`（在线数、消息速率、QoE 摘要）。
- 鉴权：演示级 JWT（`jose`），角色 viewer/host/admin；教程说明生产替换点。
- 横向扩展：所有房间广播经 Redis Pub/Sub，多实例可运行。

### 4.6 `apps/web`
路由：`/`（房间列表）、`/room/:id`（观众直播间）、`/host/:id`（主播控制台）、`/admin`（管理后台）、`/pay/mock/:orderId`（Mock 收银台）、`/lab`（播放实验室：协议/弱网/多 CDN 切换对比）。
直播间布局：播放器 + 弹幕层 + 礼物动画层 + 右侧聊天/在线/置顶/投票 + 底部输入与礼物面板。
性能：播放器引擎 `import()` 按协议懒加载；`preconnect` 到媒体域；海报图作为 LCP；Zustand 选择器与 `useSyncExternalStore` 避免弹幕流触发全量重渲染。

### 4.7 `infra`
- `docker-compose.yml`：`mediamtx`（LL-HLS part 500ms、WHEP、API）、`pusher`（ffmpeg lavfi 测试图+时间戳循环推 RTMP）、`srs`（profile `flv`）、`redis`、`clickhouse`（init.sql 建 `qoe.events` 与物化视图）、`grafana`（datasource + 3 个看板：QoE 总览、按 CDN/协议对比、错误分析）。
- 一键：`pnpm dev` 启动 api + web；`pnpm infra:up` 启动容器。

## 5. 错误处理原则
- 播放：非致命错误由引擎自愈；致命错误进入恢复阶梯，阶梯耗尽显示可重试的错误态并上报；所有错误带 `err_type/err_detail/fatal`。
- IM：断线指数退避（1s→20s + jitter）；重连携带 `lastSeq`；超出历史窗口则全量刷新；心跳超时主动重连。
- 支付：webhook 幂等（事件 id 唯一键）；订单状态机 `created→paid|failed|expired`；前端乐观扣减、失败回滚。
- 遥测：上报失败静默丢弃（不影响播放），队列上限 500 条。

## 6. 测试策略
- 单元（Vitest）：lane 分配与追尾判定；QoE 卡顿计算（含排除规则）；遥测批量与采样；协议帧 schema；账本幂等与余额校验；IM 抽样/批帧逻辑。
- 集成（Vitest + 内存 Redis 或真实 Redis）：WS 握手/补发/心跳。
- 端到端（Playwright，需 Docker）：打开 `/room/demo`，断言 `first_frame` 事件出现且 `video.currentTime` 增长；发送弹幕并在画布层出现。
- 质量门：`pnpm lint && pnpm typecheck && pnpm test`。

## 7. 教程结构（`docs/tutorial/`）
00 导读与环境 · 01 直播链路总览与协议选型 · 02 本地媒体服务器与推流 · 03 播放器内核适配层（hls.js/mpegts.js/WHEP） · 04 起播优化 · 05 卡顿与弱网/跨境策略（含弱网实验） · 06 弹幕渲染引擎 · 07 IM 网关与协议 · 08 主播互动（点赞/礼物/投票/置顶/连麦信令） · 09 付费与钱包（Mock 支付、幂等、账本） · 10 运营工具（主播台/后台） · 11 播放质量监控与埋点（指标定义、SDK、ClickHouse、Grafana、告警） · 12 前端性能与工程化（分包、测试、CI） · 13 上云与 CDN（阿里云/腾讯云/Cloudflare/IVS、多 CDN 调度、Content Steering、ICP 与跨境）· 附录：调研报告。

## 8. 实施分期
- P0 骨架：monorepo、infra、protocol、api 基础、web 壳与路由。
- P1 播放：player-core 三引擎 + 控制器 + QoE 探针 + 直播间播放 + 实验室页。
- P2 互动：IM 网关 + 弹幕引擎 + 聊天/点赞/礼物/投票/置顶/公告。
- P3 付费：钱包、Mock 支付、礼物下单、账本。
- P4 运营：主播控制台、管理后台、审核工具。
- P5 观测：telemetry SDK、入库、Grafana 看板与告警、弱网代理实验。
- P6 教程与收尾：全部章节、README、E2E、连麦信令（可选）。
