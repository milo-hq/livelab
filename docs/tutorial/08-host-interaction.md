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

### 连麦（co-host）：信令走 IM，媒体走 WebRTC

```
观众 POST /v1/rooms/:id/cohost/request ──▶ system{cohost, state:'requested'} ──▶ 主播台"连麦"面板
主播 POST /cohost/accept {userId}      ──▶ 服务端分配 MediaMTX 路径 cohost/<room>/<user>
                                          state{cohosts:[…]} + system{cohost, state:'accepted', whip, whep}
观众浏览器 getUserMedia → WhipClient.publish(stream) → http://…:8889/cohost/<room>/<user>/whip
其他所有人 CohostLayer：对 state.cohosts 里的每一路用 WhepEngine 播 …/whep，作画中画
任一方 POST /cohost/end ──▶ state{cohosts} 移除 + system{cohost, state:'ended'} → 推流端 DELETE 资源、停摄像头
```

代码：`apps/api/src/modules/interaction/cohost.ts`（内存态请求/在麦列表，最多 3 人；访客只能结束自己）、`packages/player-core/src/engines/whip-client.ts`（RFC 9725 的 WHIP 客户端，与 WHEP 互为镜像：sendonly 轨道 → POST offer → 201 + Location → DELETE 挂断）、`apps/web/src/components/cohost/*`（观众按钮 + 推流预览、画中画层）、`apps/web/src/components/host/cohost-panel.tsx`（主播接受/拒绝/下麦）。

两个设计点：**在麦名单放进 `RoomState.cohosts`**，迟到的观众从 `welcome` 就能拿到并渲染画中画；**推流地址由服务端分配**（路径含房间与用户 ID），生产上在 MediaMTX `authHTTPAddress` 回调里校验"该用户是否在麦"即可防止冒名推流。

## 动手实验

1. 主播台发起投票，观众端投票，看票数实时变化与 60s 自动结束。
2. 连送 5 个玫瑰再送 1 个火箭：火箭插队先播。
3. 主播台"置顶其最新消息"，新开一个窗口进房，置顶条在 `welcome` 后立即出现。
4. 连麦：观众窗口点"申请连麦"，主播台"连麦"面板点"接受"，观众允许摄像头后左下角出现本地预览，其他窗口右上角出现画中画；主播点"下麦"或观众点"挂断"结束。没有摄像头时可用 ffmpeg 模拟访客：`ffmpeg -re -f lavfi -i testsrc=size=640x360:rate=24 -f lavfi -i sine -c:v libx264 -tune zerolatency -c:a aac -f flv rtmp://localhost:1935/cohost/demo/<userId>`。

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
