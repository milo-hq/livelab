# 08 · 主播互动：点赞、礼物动画、投票、置顶、公告、连麦

## 目标

把互动从"消息"变成"体验"：每种互动在协议、状态、渲染三层各落在哪里，以及热门房间如何不被互动拖垮。

## 原理：互动的三种形态

| 形态 | 例子 | 传输 | 渲染 |
|---|---|---|---|
| 高频低价值 | 点赞 | 两级聚合（客户端 500ms、服务端 1s） | 飘心动画用聚合数驱动 |
| 低频高价值 | 礼物 | `gift` 车道，永不抽样/丢弃，REST 下单 + WS 广播 | 动画队列，大礼物插队 |
| 状态型 | 置顶、公告、投票、慢速、连麦 | `state` 帧（全量/增量），不进历史 | 直接绑定 UI |

平台参考：TikTok LIVE Multi-guest（5 人）与 Co-host（3 主播）；B 站 PK/天选/红包；YouTube Super Chat 置顶；Twitch Slow/Followers-only/Shield Mode。

## 代码走读

### 点赞（`components/chat/like-button.tsx`）

客户端只做两件事：累加点击、每 500ms 发一次 `like{n}`；动画由 `like_agg.count` 触发（`likeBurst` 递增），所以所有人看到的是"房间在热起来"，而不只是自己的点击。

### 礼物动画（`components/gifts/animations.ts` + `gift-layer.tsx`）

- 动画是纯函数 `(ctx, t∈[0,1], w, h, seed) => void`，可重放、可测试、可搬进 Worker。三种内置：`hearts`、`confetti`、`rocket`。
- `createGiftQueue({ maxConcurrent: 2, bigPrice: 500 })`：价格 ≥500 的礼物插到所有小礼物之前，最多同时播两个；有单元测试。
- `GiftLayer` 订阅 store 的 `lastGift`（不经 React 渲染），rAF 循环只在有动画时运行。
- 生产格式：默认 **SVGA**（压缩 85–90%），大礼物/3D 用 **alpha-MP4**（VAP/YYEVA），轻量特效 Lottie；把 `GiftDrawFn` 换成对应播放器即可，队列逻辑不变。

### 投票（`interaction/routes.ts` + `poll-panel.tsx` + 直播间 `PollCard`）

主播 `POST /v1/rooms/:id/mod {action:'poll_start', question, options, seconds}` → 服务端持有 `Poll`、广播 `system{poll}` + `state{poll}` → 观众 `vote{pollId, option}`（每人一票）→ `state{poll}` 增量更新票数 → 到时或手动 `poll_end`。

### 置顶与公告

`pin` 从历史里按 `msgId` 找到消息放进 `state.pinned`；`announce` 写 `state.announce` 并广播 `system{announce}`（弹幕层用蓝色描边条显示）。两者都是"状态"，新进房的观众从 `welcome.state` 直接拿到。

### 连麦（co-host）信令

流程：观众请求 → 主播接受 → 服务端广播 `system{cohost, payload:{userId, path, state}}` → 观众浏览器 `getUserMedia` + WHIP 推到 `http://localhost:8889/cohost/<room>/<user>/whip` → 其他人用 `WhepEngine` 播这一路作画中画 → 结束清理。信令走同一条 WebSocket，媒体走 WebRTC。本项目实现了协议里的 `cohost` 系统消息与 WHIP/WHEP 两端引擎；完整的连麦 UI 是留给读者的扩展练习（`WhepClient` 反过来就是 WHIP 客户端）。

## 动手实验

1. 主播台发起投票，观众端投票，看票数实时变化与 60s 自动结束。
2. 连送 5 个玫瑰再送 1 个火箭：火箭插队先播。
3. 主播台"置顶其最新消息"，新开一个窗口进房，置顶条在 `welcome` 后立即出现。
4. 用 OBS WHIP 推一路到 `live/demo`，体验浏览器外的"连麦上麦"。

## 度量

礼物：`gift_orders` 表即流水；互动率 = 有互动的 view ÷ 总 view（可从 IM 侧埋点）。

## 生产注意事项

- 礼物广播失败不能影响下单成功：本项目 `broadcast` 是 fire-and-forget 并记日志。
- 动画层要限并发与总时长，否则"火箭雨"会把低端机拖垮。
- 连麦要处理回声消除、上麦权限、举报与一键下麦。

## 面试/复盘要点

- 三种互动形态各自的传输与渲染策略。
- 礼物动画队列的插队规则。
- 连麦信令与媒体分离。
