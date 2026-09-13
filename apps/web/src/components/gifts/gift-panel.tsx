import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { z } from 'zod';
import { Gift, SendGiftResponse, Wallet } from '@livelab/protocol';
import { api, ApiError } from '../../lib/api';
import { useSession } from '../../stores/session';

export function GiftPanel({ roomId, onNeedCoins, onLogin }: { roomId: string; onNeedCoins: () => void; onLogin: () => void }) {
  const user = useSession((s) => s.user);
  const gifts = useQuery({ queryKey: ['gifts'], queryFn: () => api.get('/v1/gifts', z.array(Gift)), staleTime: Infinity });
  const [selected, setSelected] = useState<string | null>(null);
  const [count, setCount] = useState(1);
  const qc = useQueryClient();
  // One idempotency key per click so a network retry can never double-charge; a new click = new key.
  const keyRef = useRef<string | null>(null);

  const send = useMutation({
    mutationFn: async (input: { giftId: string; count: number }) => {
      keyRef.current ??= crypto.randomUUID();
      return api.post('/v1/gifts', { roomId, giftId: input.giftId, count: input.count }, SendGiftResponse, { idempotencyKey: keyRef.current });
    },
    // Optimistic debit: balance drops instantly; rolled back if the server rejects.
    onMutate: async (input) => {
      const gift = gifts.data?.find((g) => g.id === input.giftId);
      const key = ['wallet', user?.id];
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<Wallet>(key);
      if (prev && gift) qc.setQueryData<Wallet>(key, { ...prev, balance: prev.balance - gift.price * input.count });
      return { prev };
    },
    onError: (err, _input, ctx) => {
      if (ctx?.prev) qc.setQueryData(['wallet', user?.id], ctx.prev);
      if (err instanceof ApiError && err.status === 402) onNeedCoins();
    },
    onSuccess: (r) => qc.setQueryData<Wallet>(['wallet', user?.id], (w) => (w ? { ...w, balance: r.balance } : w)),
    onSettled: () => {
      keyRef.current = null;
    },
  });

  if (!user) return <button onClick={onLogin} className="text-sm text-zinc-400">登录后送礼</button>;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {gifts.data?.map((g) => (
        <button key={g.id} onClick={() => setSelected(g.id)} title={`${g.price} 金币`}
          className={`flex flex-col items-center rounded-lg border px-3 py-1.5 text-xs ${selected === g.id ? 'border-brand bg-brand/10' : 'border-zinc-800 hover:border-zinc-600'}`}>
          <span className="text-xl">{g.icon}</span>
          <span>{g.name}</span>
          <span className="text-zinc-400">🪙{g.price}</span>
        </button>
      ))}
      {selected && (
        <div className="flex items-center gap-1">
          <select value={count} onChange={(e) => setCount(Number(e.target.value))} className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm">
            {[1, 5, 10, 30, 66, 99].map((n) => <option key={n} value={n}>×{n}</option>)}
          </select>
          <button disabled={send.isPending} onClick={() => send.mutate({ giftId: selected, count })}
            className="rounded bg-amber-500 px-3 py-1.5 text-sm font-semibold text-black hover:bg-amber-400 disabled:opacity-50">
            赠送
          </button>
        </div>
      )}
      {send.isError && !(send.error instanceof ApiError && send.error.status === 402) && (
        <span className="text-xs text-red-400">{(send.error as Error).message}</span>
      )}
    </div>
  );
}
