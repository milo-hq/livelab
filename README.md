# LiveLab · 直播 / 视频播放前端全链路实践

一个可在笔记本上一键跑通、与线上架构同构的直播平台教学项目，覆盖：直播间播放（LL-HLS / HTTP-FLV / WebRTC）、弹幕与 IM、主播互动、虚拟币付费、运营工具、起播/卡顿/弱网/跨境优化，以及播放质量监控（ClickHouse + Grafana）。

技术选型于 2026-09-13 逐项核实版本（详见 `docs/research/`）：React 19.3 · Vite 8.3 · TypeScript 5.9.3 · Tailwind 4.3 · hls.js 1.7.3 · mpegts.js 1.8.2 · media-chrome 4.19 · Fastify 5.12 · Node `node:sqlite` · MediaMTX 1.21.0 · SRS 6 · ClickHouse 26.8 · Grafana 13.2。

## 快速开始

```bash
pnpm install
pnpm infra:up        # MediaMTX + 测试推流(带 UTC 时钟) + Redis + ClickHouse + Grafana
pnpm infra:flv       # 可选：SRS，提供 HTTP-FLV
pnpm dev             # api :8787 · web :5174
```

- 直播间 http://localhost:5174/room/demo （互动房间 `/room/demo-rt` 走 WebRTC）
- 播放实验室 http://localhost:5174/lab （三协议并排 + 弱网代理）
- 主播控制台 `/host/demo`（以"主播"角色登录）· 管理后台 `/admin`（"管理员"）
- Grafana http://localhost:3000 （admin/admin）· MediaMTX API http://localhost:9997/v3/paths/list

```bash
pnpm typecheck && pnpm test          # 单元 + 服务测试
pnpm --filter @livelab/web e2e       # Playwright 冒烟（需 infra + dev 运行）
```

## 仓库结构

```
apps/web            React 19 SPA：直播间 / 主播台 / 后台 / 实验室 / Mock 收银台
apps/api            Fastify 5：房间与播放策略、IM 网关、钱包与 Mock 支付、礼物、遥测入库、弱网代理
packages/protocol   zod schema：IM 帧、REST DTO、遥测事件（前后端唯一真相）
packages/player-core  播放器内核：HlsEngine / FlvEngine / WhepEngine / NativeHls、控制器、QoE 探针
packages/danmaku    Canvas 弹幕引擎（轨道分配、限流、Worker 可选）
packages/telemetry  浏览器遥测 SDK（批量、采样、环形日志、报障）
infra               docker-compose、MediaMTX/SRS 配置、ClickHouse 表、Grafana 看板与告警
docs/tutorial       教程 00–13（Markdown 源）；`docs/tutorial/index.html` 为单页交互式版本
docs/research       2026-09 技术调研报告（四份）
docs/superpowers    设计文档与实施计划
```

## 教程

`docs/tutorial/README.md` 是章节目录；`pnpm tutorial:build` 生成手机可读的单页 `docs/tutorial/index.html`。

## 许可

MIT。
