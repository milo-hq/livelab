import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { z } from 'zod';
import { Room } from '@livelab/protocol';
import { api } from '../lib/api';

export function HomePage() {
  const rooms = useQuery({ queryKey: ['rooms'], queryFn: () => api.get('/v1/rooms', z.array(Room)), refetchInterval: 10_000 });
  return (
    <div className="mx-auto max-w-5xl p-6">
      <h1 className="mb-1 text-2xl font-semibold">直播间</h1>
      <p className="mb-6 text-sm text-zinc-400">先运行 <code className="rounded bg-zinc-800 px-1">pnpm infra:up</code>，测试流会自动推到 MediaMTX。</p>
      {rooms.isError && <p className="text-red-400">无法连接 api：{(rooms.error as Error).message}</p>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {rooms.data?.map((r) => (
          <Link key={r.id} to={`/room/${r.id}`} className="group overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 transition hover:border-zinc-600">
            <div className="relative aspect-video bg-zinc-800">
              <img src={r.coverUrl} alt="" className="h-full w-full object-cover" />
              <span className={`absolute left-2 top-2 rounded px-1.5 py-0.5 text-xs font-semibold ${r.status === 'live' ? 'bg-brand' : 'bg-zinc-700'}`}>
                {r.status === 'live' ? 'LIVE' : '未开播'}
              </span>
              <span className="absolute bottom-2 right-2 rounded bg-black/60 px-1.5 py-0.5 text-xs">{r.viewers} 在线</span>
            </div>
            <div className="p-3">
              <div className="font-medium group-hover:text-brand">{r.title}</div>
              <div className="mt-1 text-xs text-zinc-400">{r.hostName} · {r.mode === 'interactive' ? 'WebRTC 互动' : 'LL-HLS'}</div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
