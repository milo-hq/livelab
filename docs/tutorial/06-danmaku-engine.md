# 06 · 弹幕渲染引擎

## 目标

用 Canvas 实现一个能扛住每秒几十条、掉帧不堆积、后台不耗电的弹幕层，并理解轨道分配算法。

## 原理

### DOM 还是 Canvas

| 方案 | 优点 | 缺点 | 适用 |
|---|---|---|---|
| DOM + `transform: translate3d` + `will-change` | 文本可选、可点击、无障碍 | 每条弹幕一个合成层，数百条以上掉帧 | 互动弹幕（点赞、回复） |
| Canvas + rAF | 单层、上千条无压力 | 不可选中；需自绘描边 | 直播主弹幕层（本项目） |
| OffscreenCanvas + Worker | 主线程被 React 卡住也不掉帧 | 兼容性、消息开销 | 超热房间（>500 条/秒） |

### 轨道分配（`packages/danmaku/src/lanes.ts`）

每条弹幕以恒定时长 `durationMs` 横穿舞台，所以 **越宽的弹幕越快**：`speed = (stageWidth + width) / (durationMs / 1000)`。

某条轨道对新弹幕 N 可用，需同时满足：

1. 上一条 P 已完全进入舞台：`lastRight <= stageWidth`，其中 `lastRight = stageWidth + lastWidth − lastSpeed × elapsed`；
2. N 不会在 P 离场前追上它：若 `speed > lastSpeed`，令 `gap = stageWidth − lastRight`，追上用时 `tc = gap / (speed − lastSpeed)`，P 离场用时 `tl = lastRight / lastSpeed`，要求 `tc ≥ tl`。

取最小可用轨道索引；没有则返回 -1（进入待发队列或按限流丢弃）。这与 weizhenye/Danmaku 的策略一致，是各家实现的公约数。

### 帧循环里的三条规矩

- 用 `dt = now − last` 推进位置，`dt` 钳到 100ms；`dt > 100ms`（切页/卡顿回来）时**丢弃积压队列**而不是一口气全画出来。
- `document.hidden` 时暂停 rAF 并清空队列；回前台不补发——观众不需要看过去 30 秒的弹幕。
- 每秒上屏上限（`maxPerSecond`），超限的普通弹幕直接丢并计数；礼物/系统消息（`priority 2`）永不丢。

### 与 React 的边界

`DanmakuLayer` 用 `useRoomStore.subscribe` 在 React 渲染循环之外消费消息：每 150ms 一批 IM 消息变成几次 `emit()`，不会触发覆盖层组件重渲染。重挂载时从 store 里最新的 `seq` 开始，不重放历史。

## 代码走读

```ts
// packages/danmaku/src/index.ts
const handle = createDanmaku(canvas, { laneHeight: 34, durationMs: 8000, maxPerSecond: 25, area: 0.5 });
handle.emit({ id, text, color, size: 'md', priority: 0, border: false });
handle.pause(); handle.resume(); handle.resize(); handle.setOptions({ area: 1 }); handle.destroy();
handle.stats // { onScreen, dropped, emitted }
```

`renderer-core.ts` 与画布/DOM 无关（接受 `HTMLCanvasElement | OffscreenCanvas` 和注入的 `now/raf`），因此单元测试可以精确地驱动帧；`worker.ts` 把同一核心放进 Worker（`new Worker(new URL('./danmaku.worker.ts', import.meta.url), { type: 'module' })`），不支持 OffscreenCanvas 时自动回退主线程。

文本宽度测量是 Canvas 弹幕最大的 CPU 开销，用 `Map` 缓存（上限 2000 条 FIFO）。描边 + 填充两次绘制保证在任何画面上可读。

## 动手实验

1. 直播间弹幕密度切到"多"，用另一个浏览器窗口登录第二个账号刷屏，看右下角"弹幕 N · 丢弃 M"。
2. 切到别的标签页 10 秒再回来：弹幕不会补发。
3. `pnpm --filter @livelab/danmaku test`：看 `lanes.test.ts` 里追尾判定的四个分支。
4. 把 `durationMs` 改成 4000（更快）与 16000（更慢），体会"恒定时长"模型对拥挤度的影响。

## 度量

前端埋点可上报 `danmaku.dropped / emitted` 与 `onScreen` 峰值（本项目在覆盖层左下角展示）。

## 生产注意事项

- 弹幕字体要预加载（`font-display: swap` 会让首批弹幕用回退字体测量宽度，导致重叠）。
- 高分屏用 `devicePixelRatio` 缩放画布，否则模糊。
- 移动端把 `area` 限制在 0.25–0.5，避免遮住商品/主播。
- 高级弹幕（定位、逆向、彩色描边）用 DOM 层单独渲染。

## 面试/复盘要点

- 追尾判定公式与推导。
- `dt` 钳制与丢弃积压的原因。
- 为什么弹幕层不走 React state。
