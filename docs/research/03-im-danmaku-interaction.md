# 直播互动层技术调研报告（2026-09）

> 版本号来自 npm registry（2026-09-13）或引用页面。

## 1. 实时传输与后端扇出

### 1.1 浏览器传输能力

| 传输 | 支持情况 | 适用性 |
|---|---|---|
| WebSocket | 全平台 | 聊天/弹幕默认 |
| SSE | 全平台（单向） | 只读观众流的降级 |
| WebTransport | Chrome 97+ / Firefox 114+ / Safari 26.4+（2026-03）；Baseline（[caniuse](https://caniuse.com/webtransport)） | 渐进增强，仍需 WS 回退 |

### 1.2 Node 后端选型

| 方案 | 版本 | 要点 |
|---|---|---|
| `ws` | 8.21.3 | 标准库级；2026 年有两个 CVE 已修 |
| uWebSockets.js | v20.69.0（2024-07） | 单作者；~5 KB/连接、单节点 ~100 万连接 vs Socket.IO ~52 KB/连接（[AnyCable benchmark](https://anycable.io/compare/nodejs-websocket/)） |
| Socket.IO | 4.8.3 | Connection State Recovery（offset，默认 2 min）；Redis Streams 适配器 |
| Centrifugo | v6.9.5（2026-09-13）；JS SDK `centrifuge` 5.7.4 | Go 单体，channels/presence/history/JWT 内置；`offset`+`epoch` 恢复；v6 支持 WebTransport（[docs](https://centrifugal.dev/docs/server/history_and_recovery)） |

### 1.3 大厂公开架构

- Twitch：Edge（IRC over WS）+ Pubsub 分层树状扇出（[Twitch Engineering](https://blog.twitch.tv/en/2015/12/18/twitch-engineering-an-introduction-and-overview-a23917b71a25/)）。
- B站 goim：Comet（接入）/ Logic（鉴权路由）/ Job（消费 Kafka 按房间推送）；弹幕 WS 协议 16 字节头、30 s 心跳、body zlib/brotli（[腾讯云文章](https://cloud.tencent.cn/developer/article/1679213)、[协议分析](https://daidr.me/archives/code-526.html)）。
- 美拍：大房间按时间窗和条数收紧；房间过大时从"定向通知"降级为"广播"（[腾讯云文章](https://cloud.tencent.com/developer/article/1194235)）。

### 1.4 热门房间消息速率控制模式

1. 服务端分档：按在线人数分级每秒下发上限；礼物/系统/主播消息 100% 下发，普通弹幕抽样。
2. 优先级通道：`room:123:gift` / `room:123:chat` 分离。
3. 批量帧：100–200 ms tick 聚合成数组一次下发。
4. 客户端限流：只 render 可见轨道容量（30–50 条/s）。
5. 重连：指数退避 + jitter（1 s→20 s），`offset/epoch` 恢复。
6. 心跳：客户端 25–30 s ping，服务端 2 倍超时踢出。

## 2. Web 弹幕渲染

| 库 | 版本 | 状态 |
|---|---|---|
| `danmaku`（weizhenye） | 2.0.10（2026-08） | 活跃；DOM 与 Canvas 双引擎，支持绑定 `<video>` 或实时模式（[repo](https://github.com/weizhenye/Danmaku)） |
| CommentCoreLibrary | 0.11.1，7 年未更新 | 停滞 |
| rc-danmaku | 1.2.0-alpha.1（2024-08），仅 React 17/18 | 不建议 |

性能技术：
- DOM 路线：`transform: translate3d` + `will-change`；节点池复用；文本可选。
- Canvas 路线：单层 canvas + rAF；`OffscreenCanvas.transferControlToOffscreen()` 移到 Worker。
- 轨道分配：N 条 lane，每 lane 记录"最后一条弹幕右端离开时刻"，追尾判定 `(lane.lastEndX - stageWidth) / lastSpeed < newWidth / newSpeed`。
- 掉帧适应：`dt = now - lastFrame`；`dt > 100 ms` 清空积压。
- Tab 隐藏：`visibilitychange` 暂停 rAF 并丢弃队列。

## 3. 主播互动功能与礼物动画

- TikTok LIVE：Multi-guest 5 人、Co-host 3 位；投票/Q&A。
- B站：PK、天选抽奖、连麦、红包；网页端观众无连麦入口。
- YouTube：Super Chat 置顶；主播置顶单条消息；投票。
- Twitch：Slow/Followers-only/Subs-only、Shield Mode、AutoMod。

连麦信令：邀请 → 接受 → 服务端发 `cohost.token` → join RTC → 广播 `cohost.state` → 挂断清理。

礼物动画格式（[YYEVA 对比](https://github.com/yylive/YYEVA/blob/main/Live%20room%20animation%20solutions.md)）：

| 格式 | Web 库 | 版本 | 定位 |
|---|---|---|---|
| Lottie | `lottie-web` | 5.13.0 | 小体积，简单特效 |
| PAG | `libpag`（WASM） | 4.5.85 | AE 导出更全 |
| SVGA | `svga` | 2.1.1（2026-08） | 压缩 85–90%，性能好 |
| Alpha-MP4 / YYEVA / VAP | yyeva-web | — | 任意效果含 3D，适合大礼物 |

## 4. 虚拟币支付流程与本地 Mock

- Stripe 2026：Checkout 与 Payment Element 合并为 Checkout Sessions API 三种 `ui_mode`；API 版本 `2026-06-24.dahlia`（[Stripe](https://docs.stripe.com/payments/payment-element/migration)）。
- 支付宝手机网站支付 Form 跳转回跳；微信 H5 支付仅限手机浏览器非微信内（[微信支付文档](https://pay.weixin.qq.com/doc/v3/merchant/4012791832)）。

推荐流程：`充值下单(orderId=ULID)` → 支付渠道 → Webhook 验签 → 幂等入账（`payment_events` 唯一键 = provider event id）→ 双式账本 → 送礼 `POST /gifts {giftId, roomId, idempotencyKey}` → 服务端查价 → 单事务 `wallet debit + creator credit + gift_orders` → 发布 `gift.sent`。

本地 Mock：自建 `mock-pay` 页面点"支付成功"后异步 POST 带 HMAC 的 webhook，可注入重复投递、乱序、延迟。

反欺诈基线：服务端定价、订单幂等、`UPDATE ... WHERE balance >= price`、速率限制；前端乐观扣减 + 失败回滚。

## 5. 运营工具

主播控制台：推流地址/Stream Key、健康度（码率/帧率/丢帧）、禁言/踢出/关键词过滤/慢速模式、置顶、公告、投票/抽奖、连麦邀请、收益。
管理后台：房间列表 + 实时在线、消息速率、礼物流水、QoE、审核队列。
React 后台 UI：Ant Design 6.6.3 + Pro Components；Refine 5.0.12；shadcn-admin 模板。

## 6. 前端栈版本（2026-09-13）

| 包 | 版本 |
|---|---|
| react / react-dom | 19.3.0 |
| vite | 8.3.0（Rolldown，Node 20.19+/22.12+） |
| tailwindcss | 4.3.3 |
| zustand | 5.0.15 |
| jotai | 3.0.0（刚出大版本，谨慎） |
| @tanstack/react-query | 5.102.8 |
| partysocket | 1.3.0 |

## 7. Recommendations

1. 传输 + 扇出：WebSocket；后端 Centrifugo v6.9.x 作接入层 或 纯 Node `ws` + Redis Pub/Sub 自建。
2. 速率控制：每房间 `gift`/`chat` 两个 channel；150 ms 批帧；大房间抽样普通弹幕；心跳 25 s。
3. 弹幕渲染：`danmaku` 2.0.10 Canvas 引擎 或 自研 Canvas；超过 500 条/s 移入 Worker。
4. 礼物动画：默认 SVGA，大礼物 alpha-MP4，轻量用 Lottie。
5. 支付 Mock：自建 `mock-pay` + HMAC webhook + 双式账本 + 幂等表。
6. 后台：Ant Design 6 + Refine 5；主播台与观众端共用 shadcn/ui + Tailwind 4。
7. 前端栈：React 19.3 + Vite 8.3 + TS + Tailwind 4.3；Zustand 5 + TanStack Query 5。
