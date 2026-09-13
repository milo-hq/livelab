# 09 · 付费与钱包：Mock 支付、签名 Webhook、幂等、双式账本

## 目标

实现一个"客户端永远不决定已支付"的付费链路，并能在本地复现支付里最常见的三个坑：Webhook 迟到、重复投递、并发扣减。

## 原理

```
充值：下单 → 收银台(Stripe Checkout / 支付宝H5 / 微信H5) → 提供方回调 Webhook(签名) → 验签 → 幂等入账 → 账本
送礼：POST /v1/gifts (Idempotency-Key) → 服务端查价 → 事务：余额>=价格才扣 → 账本 → 礼物订单 → 广播
```

- **Stripe 2026**：Checkout 与 Payment Element 合并为 Checkout Sessions API（`ui_mode`: hosted/embedded/elements），只需监听 `checkout.session.completed`。
- **支付宝手机网站支付**：表单跳转 + 回跳；**微信 H5**：仅限手机浏览器（非微信内），后端下单拿 `h5_url`。
- 共同点：**最终状态来自服务端回调**，前端只能轮询订单状态。

## 代码走读（`apps/api/src/modules/wallet|pay-mock|gifts`）

### 订单与钱包

1 金币 = 10 分。`POST /v1/wallet/recharge {coins}` 创建 `orders(created)`，返回 `payUrl: /pay/mock/<id>`；订单 15 分钟未支付惰性转 `expired`。

### Mock 收银台（`routes/pay-mock.tsx` + `pay-mock/deliver.ts`）

点击"支付成功"后 api 扮演支付提供方：随机延迟 0–3s 投递 Webhook，**30% 概率再投一次**，非 2xx 重试 3 次。Webhook 体：

```json
{ "eventId": "evt_…", "orderId": "ord_…", "status": "paid", "signature": "HMAC-SHA256(secret, eventId.orderId.status)" }
```

### 幂等入账（`wallet/service.ts#applyPaymentEvent`）

```
验签失败 → 'invalid'（400）
事务内：payment_events 已有 eventId → 'duplicate'（200，什么都不做）
        插入 eventId；订单 created→paid；钱包 +coins；账本两条（platform_cash −，user_wallet:<uid> +）
→ 'applied'
```

唯一键是**提供方的事件 ID**，不是订单 ID——同一订单可能有多个事件（支付成功、退款）。

### 扣减与送礼（`wallet/service.ts#debit` + `gifts/routes.ts`）

- 价格**永远**由服务端目录决定（`GIFTS`），客户端只传 `giftId, count`。
- `Idempotency-Key` 请求头必填；`gift_orders(user_id, idem_key)` 唯一，重放返回同一个 `msgId`，不重复扣款、不重复广播。
- 扣减用一条 SQL 保证不透支：`UPDATE wallets SET balance = balance - ? WHERE user_id = ? AND balance >= ?`，`changes === 0` 即余额不足（402）。
- 账本：`user_wallet:<uid>` −amount、`creator_earnings:<hostId>` +amount，同一 `tx_id`，任何时刻 Σdelta = 0。

### 前端乐观更新（`gift-panel.tsx`）

TanStack Query `useMutation` 的 `onMutate` 先扣本地余额，`onError` 回滚并在 402 时打开充值框，`onSuccess` 用服务端返回的 `balance` 覆盖。每次点击生成一个新的 `Idempotency-Key`，网络重试复用同一个 key。

## 动手实验

1. 充值 500 → Mock 收银台 → "支付成功" → 观察状态在 0–3s 后变 paid；api 日志里偶尔会看到第二次投递返回 `duplicate`。
2. 用 curl 伪造 Webhook（签名错误）→ 400 invalid。
3. 把礼物面板的赠送按钮连点两次（同一 key）→ 只扣一次。
4. 余额 5 金币送 10 个玫瑰 → 402，余额本地回滚，弹出充值。
5. `pnpm --filter @livelab/api test -- src/modules/wallet`。

## 度量

`ledger_entries` 按账户汇总应恒为 0；`payment_events` 中 duplicate 比例反映提供方投递质量。

## 生产注意事项

- 接入 Stripe：把 `pay-mock` 换成 Checkout Session 创建 + `stripe.webhooks.constructEvent` 验签，其余不变。
- 反欺诈：每用户送礼速率限制、异常金额告警、退款事件的反向账本。
- 钱包与账本放同一事务；跨服务时用 outbox 模式发广播。
- 金额用整数（分/金币），永远不用浮点。

## 面试/复盘要点

- 幂等键选什么、放哪一层。
- 余额校验为什么必须在 UPDATE 的 WHERE 里。
- 乐观更新的回滚路径。
