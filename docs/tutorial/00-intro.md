# 00 · 导读：这份教程要带你做成什么

## 目标画像

这份教程对应的是"直播及视频播放前端"岗位的完整能力面：

| 岗位要求 | 教程对应章节 | 项目里的落点 |
|---|---|---|
| 直播间播放（HLS / 播放器内核 / CDN / 缓存 / 流媒体链路） | 01–05 | `packages/player-core`、`infra/mediamtx.yml` |
| 弹幕 / IM | 06–07 | `packages/danmaku`、`apps/api/src/modules/im` |
| 主播互动 | 08 | 点赞聚合、礼物动画、投票、置顶、公告、连麦信令 |
| 付费 | 09 | 钱包、Mock 收银台、签名 Webhook、幂等、双式账本 |
| 运营工具 | 10 | 主播控制台、管理后台、聊天治理 |
| 起播速度 / 卡顿率 / 弱网 / 跨境 | 04–05、13 | 起播预设、恢复阶梯、弱网代理、多 CDN 调度 |
| 播放质量监控 / 埋点 / 异常采集 | 11 | `packages/telemetry`、ClickHouse、Grafana 看板与告警 |
| 前端可观测性、性能 | 12 | web-vitals、分包、报障流程 |

不在范围内：Flutter、Android/iOS 原生（按你的要求剔除）；真实支付渠道联调（只做 Mock，并说明生产接入点）；DRM。

## 我们要搭的东西（一张图）

```
 OBS / ffmpeg ──RTMP──▶ MediaMTX ──┬─ LL-HLS ─────┐
                        (SRS 可选) ├─ WHEP ───────┤          ┌────────── Grafana
                                   └─ HTTP-FLV ───┤          │
                                                  ▼          │
      ┌─────────────┐    REST + WebSocket    ┌──────────┐  ClickHouse
      │  apps/web   │◀──────────────────────▶│ apps/api │──────┘
      │ React 19    │                        │ Fastify 5│◀─── Redis（可选，扇出）
      └─────────────┘                        └──────────┘
        观众直播间 / 主播控制台 / 管理后台 / 播放实验室 / Mock 收银台
```

每一层都能在你的笔记本上跑起来，且与线上架构同构：本地 MediaMTX 之于阿里云直播 / Cloudflare Stream，就像 SQLite 之于 PostgreSQL。教程的每一章都以"这段代码在生产里换成什么"结尾。

## 技术选型的原则

所有版本号均在 2026-09-13 通过 npm registry、GitHub Releases、Docker Hub 实时核对（见附录调研报告），原则是**最新且成熟**：

- 采用：React 19.3、Vite 8.3（Rolldown）、TypeScript 5.9.3、Tailwind 4.3、react-router 8.3、Zustand 5、TanStack Query 5、hls.js 1.7.3、mpegts.js 1.8.2、media-chrome 4.19、Fastify 5.12、Node `node:sqlite`、MediaMTX 1.21.0、SRS 6、ClickHouse 26.8 LTS、Grafana 13.2。
- 刻意不用：TypeScript 7.0（发布当天，生态未跟上）、MoQ（Cloudflare 仍是 tech preview）、Video.js v10（RC，GA 后可平滑迁移）、Vidstack（进入轻维护）、nginx-rtmp（20 个月无提交）。

## 你需要的环境

- macOS / Linux / WSL2；Node ≥ 22.13（教程机器是 25.8）；pnpm 10；Docker Desktop（含 Compose v2）。
- 可选：OBS 32（用真实推流替换测试图）。

```bash
git clone <本仓库> livelab && cd livelab
pnpm install
pnpm infra:up          # MediaMTX + 测试推流 + Redis + ClickHouse + Grafana
pnpm infra:flv         # 可选：再起 SRS，提供 HTTP-FLV
pnpm dev               # api :8787 + web :5174
```

打开 http://localhost:5174 ，进入 `demo` 房间。画面左上角烧录了推流端的时钟，用它减去你手机/电脑当前时间，就是端到端延迟。

## 怎么读

每章结构固定：**目标 → 原理 → 代码走读 → 动手实验 → 度量 → 生产注意事项 → 面试/复盘要点**。建议按顺序读 01–05（播放主线），06–10 可按兴趣跳读，11–13 是能力上限所在，也是岗位描述里"加分项"集中的地方。
