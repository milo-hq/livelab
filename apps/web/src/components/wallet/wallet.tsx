import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Wallet, RechargeResponse } from '@livelab/protocol';
import { api } from '../../lib/api';
import { useSession } from '../../stores/session';

export function useWallet() {
  const user = useSession((s) => s.user);
  return useQuery({ queryKey: ['wallet', user?.id], queryFn: () => api.get('/v1/wallet', Wallet), enabled: !!user, staleTime: 10_000 });
}

export function WalletBadge({ onRecharge }: { onRecharge: () => void }) {
  const w = useWallet();
  if (!w.data) return null;
  return (
    <button onClick={onRecharge} className="flex items-center gap-1 rounded-full bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700">
      🪙 <span className="tabular-nums">{w.data.balance}</span> <span className="text-xs text-zinc-400">充值</span>
    </button>
  );
}

const PACKS = [100, 500, 2000, 10000];

export function RechargeDialog({ onClose }: { onClose: () => void }) {
  const [coins, setCoins] = useState(500);
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (c: number) => api.post('/v1/wallet/recharge', { coins: c }, RechargeResponse),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['wallet'] });
      // The mock cashier opens in a new tab so the room keeps playing; the wallet refetches on focus.
      window.open(r.payUrl, '_blank', 'noopener');
      onClose();
    },
  });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-80 space-y-4 rounded-lg border border-zinc-800 bg-zinc-900 p-5">
        <h2 className="text-lg font-semibold">充值金币</h2>
        <p className="text-xs text-zinc-400">1 金币 = ¥0.10。本项目使用 Mock 收银台，不产生真实扣款。</p>
        <div className="grid grid-cols-2 gap-2">
          {PACKS.map((p) => (
            <button key={p} onClick={() => setCoins(p)} className={`rounded border px-3 py-2 text-sm ${coins === p ? 'border-brand bg-brand/10' : 'border-zinc-700'}`}>
              🪙 {p} <span className="text-zinc-400">¥{(p / 10).toFixed(0)}</span>
            </button>
          ))}
        </div>
        {m.isError && <p className="text-sm text-red-400">{(m.error as Error).message}</p>}
        <button disabled={m.isPending} onClick={() => m.mutate(coins)} className="w-full rounded bg-brand py-2 font-medium disabled:opacity-50">
          去支付（Mock）
        </button>
      </div>
    </div>
  );
}
