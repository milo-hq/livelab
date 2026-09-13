# 07 · IM 网关与弹幕协议

## 目标

设计并实现一个"断线能续、热门房间不炸、多实例可扩"的房间消息通道，并理解每个设计点在百万连接场景下对应的取舍。

## 原理：大厂怎么做

- **Twitch**：Edge（长连接）+ Pubsub 树状扇出，日均数千亿条消息。
- **B 站 goim**：Comet（只管长连）/ Logic（鉴权路由）/ Job（消费 Kafka 按房间推）；弹幕协议 16 字节头 + 30s 心跳 + body zlib/brotli。
- **美拍**：大房间按时间窗和条数收紧，房间过大时从"定向通知"降级为"广播"。

抽象出来是四条规律：**接入层无业务、消息有序号、下行要批处理、大房间要抽样**。本项目用 TypeScript 在一个 Fastify 进程里实现了这四条（`apps/api/src/modules/im/`），Redis 作扇出总线后可多实例。

## 协议（`packages/protocol/src/im.ts`）

```
客户端 → 服务端                     服务端 → 客户端
hello { room, lastSeq? }            welcome { seq, state, history[] }
ping  { ts }                        pong { ts, serverTs }
chat  { cid, text }                 batch { msgs[] }         ← 每 150ms 一帧
like  { n }                         state { ...partial }     ← 置顶/公告/慢速/投票/在线数
vote  { pollId, option }            error { code, message, retryAfterMs?, cid? }
```

每条 `ServerMsg` 带房间内单调递增的 `seq` 与 `lane`（`chat | gift | system`）。zod schema 是前后端唯一真相，服务端对每个入站帧 `safeParse`，非法帧回 `error{bad_frame}` 而不断连。

关闭码：4401 未鉴权、4400 5s 内无 `hello`、4404 房间不存在、4408 60s 无 `ping`。

## 代码走读

### 有序与续传（`history.ts` + `hub.ts`）

- `seq` 由内存计数器或 Redis `INCR seq:<room>` 产生；每条消息进 `hist:<room>` 环形历史（500 条）。
- `hello.lastSeq` 存在 → `welcome.history` 返回 `seq > lastSeq` 的消息（最多 200）；不存在 → 最近 50 条。
- 连接先注册、再读历史，并丢弃队列里 `seq <= welcome.seq` 的项，保证**不丢不重**。
- 客户端 `im-client.ts` 记录见过的最大 `seq`，重连时带上；指数退避 1s→20s + 0–500ms 抖动，避免网关重启后的重连风暴。

### 批处理与抽样（`hub.ts` + `sampling.ts`）

- 每个连接一个出站队列，每 150ms 合成**一个** `batch` 帧；前端 `applyFrame` 一次 `set`，React 每 150ms 最多渲染一次。
- 队列上限 200：超限先丢最旧的 `chat`，永不丢 `gift`/`system`。
- 抽样率按在线人数分档：<100 → 100%，<1000 → 50%，<10000 → 20%，其余 5%；只抽 `chat` 车道。
- `system{join}` 只在在线 <100 的房间广播；`system{online}` 每房间每 2s 最多一次。

### 治理（`moderation.ts`）

`canPost` 顺序：封禁 → 禁言 → 慢速模式（按用户记上次发言时间）→ 频率限制（5 条/10s）；主播/管理员跳过后两项。关键词过滤大小写不敏感，命中替换为 `***`，整条即关键词时拒绝（`error{filtered}`）。状态持久化在 SQLite `mod_state`。

### 点赞聚合（`likes.ts`）

客户端 500ms 合并点击发 `like{n}`；服务端每房间每秒合成一个 `like_agg{count,total}`；前端用 `count` 触发飘心动画、`total` 显示。两级聚合把最高频的交互压到每秒一条消息。

### 扇出总线（`bus.ts`）

`Bus.publish/subscribe`：内存实现用于单实例；Redis 实现 `PUBLISH room:<id>`，每个实例订阅并投递给本地连接。`REDIS_URL` 可达时自动选 Redis（2s 探测），否则回退内存并打日志。

## 动手实验

1. 两个浏览器登录不同账号进同一房间，发消息、点赞，观察 150ms 批量到达与 `like_agg`。
2. 断网重连：DevTools → Network → Offline 10 秒后恢复，聊天区显示"第 N 次重连"，恢复后补齐漏掉的消息（对比另一窗口）。
3. 主播台开慢速模式 10s，用观众账号连发两条，第二条得到 `error{slow_mode, retryAfterMs}` 与输入框倒计时。
4. `wscat -c 'ws://localhost:8787/ws?room=demo&token=<jwt>'` 手工发 `{"t":"hello","room":"demo"}` 看 `welcome`。

## 度量

管理后台 `msgRate`（60s 滑窗）；服务端可补充每连接队列丢弃计数、批帧大小分布。

## 生产注意事项

- 生产替代：**Centrifugo v6**（channels/presence/history/JWT、offset+epoch 续传、WebTransport 回退）+ Node 业务服务通过 HTTP API 发布；或保留本实现并把 `bus`/`history` 换成 Kafka/Redis Streams。
- 单连接 JSON 帧在百万连接下带宽可观：上 binary + brotli（B 站做法），协议层保持不变。
- 在线数、`state` 帧目前是单实例内存；多实例需把在线态放 Redis（HLL/ZSET）。
- 鉴权 token 走 query 会进日志，生产改 `Sec-WebSocket-Protocol` 或首帧携带。

## 面试/复盘要点

- `seq` + `lastSeq` 续传为什么不丢不重（先注册后读史 + 去重）。
- 批帧 150ms 与抽样分档的数值依据。
- 两级点赞聚合。
