# 10 · 运营工具：主播控制台与管理后台

## 目标

理解运营工具的两个用户（主播、平台运营）分别需要哪些"实时"数据，以及这些数据从哪条链路来。

## 原理：运营工具是数据的"汇聚层"

| 数据 | 来源 | 刷新方式 | 页面 |
|---|---|---|---|
| 推流健康度（是否在推、轨道、入站字节、观看连接） | MediaMTX API `/v3/paths/get/live/<path>` | api 缓存 2s，前端每 2s 轮询 | 主播台 |
| 在线人数、消息速率 | IM hub 内存计数 | WS `state{online}`（≤1 次/2s）；后台 10s 轮询 | 主播台 / 后台 |
| 治理状态（禁言、封禁、关键词、慢速） | SQLite `mod_state` | REST + WS `state` | 主播台 |
| 投票、置顶、公告 | hub 房间状态 | WS `state` | 主播台 / 直播间 |
| QoE 汇总（TTFF、卡顿、失败率） | ClickHouse 15 分钟窗口 | 后台 10s 轮询；Grafana 30s | 后台 / Grafana |
| 礼物流水 | SQLite `gift_orders` + 账本 | 按需查询 | 后台（扩展） |

## 代码走读

### 主播控制台（`apps/web/src/routes/host.tsx`）

- **推流设置**：`GET /v1/rooms/:id/key`（host/admin）返回 RTMP/WHIP/SRT 三种入口与密钥，密钥默认打码、可重置；附 OBS/FFmpeg 命令。
- **健康度卡片**：入站码率由两次采样的 `bytesReceived` 差分计算。
- **预览播放器**：复用 `LivePlayer`（`compact`、静音）。
- **聊天治理**：点击昵称 → 禁言 5 分钟 / 封禁 / 置顶其最新消息；慢速模式 0/5/10/30s；关键词增删；公告发布。全部走 `POST /v1/rooms/:id/mod`（`ModAction` 是 zod 判别联合）。
- **投票面板**：发起、实时票数条、结束。

### 管理后台（`apps/web/src/routes/admin.tsx`）

`GET /v1/admin/overview`（admin）= 房间列表（在线、消息/秒）+ `QoeSummary`；QoE 数字来自 `GET /v1/telemetry/summary` 的三条 ClickHouse SQL（第 11 章）。页面右上角直达 Grafana 看板。

### 权限

演示鉴权：任何人可用任意角色登录（`POST /v1/auth/demo`），JWT 里带 `role`；`requireRole('host','admin')` 保护治理与密钥接口。生产替换点：接入你的 SSO，把 `role` 换成"房间-用户"级权限表。

## 动手实验

1. 以主播登录进 `/host/demo`，用 OBS 推流覆盖测试流（先 `docker stop livelab-pusher`），健康度卡片 2s 内变化。
2. 在治理面板加关键词"广告"，观众发"这是广告"→ 显示"这是***"。
3. 以管理员登录 `/admin`，对比 Grafana 总览的数值（同一 SQL，15 分钟窗口）。

## 生产注意事项

- 主播台的健康度应来自编码器侧上报（丢帧、RTT、编码延迟），MediaMTX 只知道收到了多少字节。
- 治理动作要留审计日志（谁、何时、对谁、依据）。
- 后台的实时数据订阅可以直接复用 IM 的 `admin:*` channel，而不是轮询。
- 后台 UI 可用 Ant Design 6 + Pro Components 或 Refine 5 快速搭建；本项目为保持一套设计系统沿用 Tailwind。

## 面试/复盘要点

- 运营工具的数据来源清单与刷新策略。
- 治理动作的协议表达（`ModAction`）与广播方式（`system{mod}` + `state`）。
