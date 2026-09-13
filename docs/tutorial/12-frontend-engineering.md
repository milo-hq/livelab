# 12 · 前端性能与工程化

## 目标

直播间页面自身也要快、要可测、要可维护：分包、状态管理、测试金字塔与 CI 门禁。

## 原理与代码走读

### 分包与加载顺序

- 路由级 `lazy()`：首页不带播放器与 IM 代码；直播间进入时才下载。
- 引擎级 `import()`：`createEngine(kind)` 只下载用到的内核（hls.js 71KB gz vs Shaka 140KB）；Vite 8（Rolldown）自动拆 chunk。
- `preconnect` 三个媒体域；海报图作 LCP。

### 状态：Zustand 与 TanStack Query 的分工

| 数据 | 工具 | 理由 |
|---|---|---|
| 房间实时状态、消息列表、点赞、礼物 | Zustand（`stores/room.ts`） | 高频写入；`subscribe` 可绕过 React 渲染（弹幕层、礼物层） |
| REST 数据（房间、钱包、礼物目录、健康度） | TanStack Query | 缓存、轮询、乐观更新、失效 |
| 登录态 | Zustand persist | localStorage 持久化 |

一个 `batch` 帧 = 一次 `set`；聊天列表只渲染尾部 120 条；覆盖层 canvas 不进 React。

### 类型安全的边界

所有网络数据经 zod：`api.get(path, schema)` 在运行时校验响应；WS 帧 `ServerFrame.safeParse`。前后端共享 `@livelab/protocol`，改协议先改 schema，typecheck 会指出所有需要改的地方。

### 测试金字塔

| 层 | 工具 | 覆盖 |
|---|---|---|
| 单元 | Vitest 5（jsdom） | 轨道分配、QoE 探针（假定时器）、遥测批量/采样、IM 客户端退避、房间 store、礼物队列、协议 schema |
| 服务 | Vitest + `app.inject()` + 真实 `ws` 客户端 | IM 握手/续传/治理、钱包幂等、礼物、遥测入库、弱网代理、健康度 |
| 端到端 | Playwright 1.63 | 登录 → 进房 → 视频 `currentTime` 增长 → QoE 浮层显示线路 → 聊天回显；MediaMTX 不在线时自动跳过 |

```bash
pnpm typecheck && pnpm test        # 275+ 单元/服务用例
pnpm --filter @livelab/web e2e     # 需要 pnpm infra:up && pnpm dev
```

### 依赖策略

TypeScript 锁 5.9.3（7.0 发布当天，生态未跟上）；hls.js/mpegts.js 精确小版本；`node:sqlite`、`process.loadEnvFile` 等 Node 内置能力代替第三方包。

## 动手实验

1. `pnpm --filter @livelab/web build`，看 `dist/assets` 里 hls.js、mpegts.js 各自独立 chunk。
2. React DevTools Profiler：刷屏时直播间只有聊天列表重渲染，播放器与覆盖层不动。
3. 改 `packages/protocol/src/im.ts` 给 `ChatMsg` 加字段，跑 `pnpm typecheck` 看影响面。

## 生产注意事项

- CI：typecheck + unit + build 作为 PR 门禁；E2E 在有 Docker 的 job 里跑。
- Source map 上传到错误平台（Sentry/PostHog）以便 `attrs.log` 里的栈可读。
- 把 `apps/web` 的 `/v1` 代理换成网关域名；WS 走 `wss://`。

## 面试/复盘要点

- 高频实时数据为什么不用 React state。
- zod 在边界上的价值。
- 测试金字塔各层测什么、不测什么。
