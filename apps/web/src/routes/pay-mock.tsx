import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { z } from 'zod';
import { Order } from '@livelab/protocol';
import { api } from '../lib/api';

/**
 * Mock cashier. Stands in for Stripe Checkout / 支付宝 H5 / 微信 H5: the user "pays" here, the
 * provider (our api's pay-mock module) delivers a signed webhook asynchronously — possibly late,
 * possibly twice — and the order flips to paid only when the webhook is accepted idempotently.
 */
export default function PayMockPage() {
  const { orderId = '' } = useParams();
  const order = useQuery({
    queryKey: ['order', orderId],
    queryFn: () => api.get(`/v1/pay/mock/${orderId}`, Order),
    refetchInterval: (q) => (q.state.data?.status === 'created' ? 1000 : false),
  });
  const complete = useMutation({
    mutationFn: (outcome: 'paid' | 'failed') => api.post(`/v1/pay/mock/${orderId}/complete`, { outcome }, z.object({ accepted: z.literal(true) })),
  });

  const o = order.data;
  return (
    <div className="mx-auto max-w-md p-6">
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6">
        <div className="mb-4 flex items-center gap-2 text-sm text-zinc-400"><span className="rounded bg-zinc-800 px-2 py-0.5">MOCK PAY</span> 模拟收银台</div>
        {order.isError && <p className="text-red-400">{(order.error as Error).message}</p>}
        {o && (
          <>
            <div className="text-3xl font-semibold">¥{(o.priceCents / 100).toFixed(2)}</div>
            <div className="mt-1 text-zinc-400">购买 🪙 {o.coins} 金币 · 订单 {o.id}</div>
            <div className="mt-4 rounded bg-zinc-950 p-3 text-sm">
              状态：<b className={o.status === 'paid' ? 'text-green-400' : o.status === 'created' ? 'text-amber-300' : 'text-red-400'}>{o.status}</b>
              {o.status === 'created' && complete.isSuccess && <span className="ml-2 text-zinc-400">等待 webhook 回调（0–3s，可能重复投递）…</span>}
            </div>
            {o.status === 'created' && !complete.isSuccess && (
              <div className="mt-4 flex gap-2">
                <button onClick={() => complete.mutate('paid')} className="flex-1 rounded bg-green-600 py-2 font-medium hover:bg-green-500">支付成功</button>
                <button onClick={() => complete.mutate('failed')} className="flex-1 rounded bg-zinc-700 py-2 font-medium hover:bg-zinc-600">支付失败</button>
              </div>
            )}
            {o.status === 'paid' && <p className="mt-4 text-sm text-green-400">已到账，可以关闭此页回到直播间（钱包会自动刷新）。</p>}
            {o.status === 'expired' && <p className="mt-4 text-sm text-zinc-400">订单已过期（15 分钟）。</p>}
          </>
        )}
      </div>
      <p className="mt-4 text-xs text-zinc-500">教程要点：客户端永远不决定"已支付"。前端只轮询订单状态；只有服务端验签通过、事件 ID 首次出现时才入账。</p>
    </div>
  );
}
