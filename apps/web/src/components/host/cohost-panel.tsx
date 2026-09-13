import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CohostOverview } from '@livelab/protocol';
import { api } from '../../lib/api';

export function CohostPanel({ roomId }: { roomId: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['cohost', roomId], queryFn: () => api.get(`/v1/rooms/${roomId}/cohost`, CohostOverview), refetchInterval: 2000 });
  const act = (action: 'accept' | 'reject' | 'end') =>
    useMutation({ mutationFn: (userId: string) => api.post(`/v1/rooms/${roomId}/cohost/${action}`, { userId }, CohostOverview), onSuccess: (d) => qc.setQueryData(['cohost', roomId], d) });
  const accept = act('accept');
  const reject = act('reject');
  const end = act('end');
  const d = q.data;
  return (
    <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex items-center justify-between"><h3 className="font-semibold">连麦</h3><span className="text-xs text-zinc-400">{d ? `${d.active.length}/${d.max} 在麦` : ''}</span></div>
      {d && d.requests.length === 0 && d.active.length === 0 && <p className="text-sm text-zinc-500">暂无申请。观众在直播间点"申请连麦"后会出现在这里。</p>}
      {d?.requests.map((r) => (
        <div key={r.userId} className="flex items-center justify-between rounded bg-zinc-950 px-2 py-1.5 text-sm">
          <span>🙋 {r.name} <span className="text-xs text-zinc-500">{Math.round((Date.now() - r.at) / 1000)}s 前</span></span>
          <span className="flex gap-1">
            <button onClick={() => accept.mutate(r.userId)} disabled={d.active.length >= d.max} className="rounded bg-brand px-2 py-0.5 text-xs disabled:opacity-40">接受</button>
            <button onClick={() => reject.mutate(r.userId)} className="rounded bg-zinc-700 px-2 py-0.5 text-xs">拒绝</button>
          </span>
        </div>
      ))}
      {d?.active.map((c) => (
        <div key={c.userId} className="flex items-center justify-between rounded bg-zinc-950 px-2 py-1.5 text-sm">
          <span>🎙 {c.name} <span className="text-xs text-zinc-500">{c.path}</span></span>
          <button onClick={() => end.mutate(c.userId)} className="rounded bg-zinc-700 px-2 py-0.5 text-xs hover:bg-red-700">下麦</button>
        </div>
      ))}
      {accept.isError && <p className="text-xs text-red-400">{(accept.error as Error).message}</p>}
    </div>
  );
}
