import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { AdminOverview } from '@livelab/protocol';
import { api } from '../lib/api';
import { useSession } from '../stores/session';

function Tile({ label, value, unit, hint }: { label: string; value: number | null | undefined; unit?: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="text-xs text-zinc-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value == null ? '—' : `${Math.round(value * 10) / 10}${unit ?? ''}`}</div>
      {hint && <div className="mt-1 text-[11px] text-zinc-500">{hint}</div>}
    </div>
  );
}

export default function AdminPage() {
  const user = useSession((s) => s.user);
  const q = useQuery({ queryKey: ['admin-overview'], queryFn: () => api.get('/v1/admin/overview', AdminOverview), refetchInterval: 10_000, enabled: user?.role === 'admin' });

  if (user?.role !== 'admin') return <div className="p-8 text-zinc-400">请以「管理员」角色登录。</div>;
  const d = q.data;
  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">管理后台</h1>
        <div className="flex gap-3 text-sm">
          <a className="text-sky-400 hover:underline" href="http://localhost:3000/d/livelab-qoe-overview" target="_blank" rel="noreferrer">Grafana · QoE 总览 ↗</a>
          <a className="text-sky-400 hover:underline" href="http://localhost:3000/d/livelab-errors" target="_blank" rel="noreferrer">错误分析 ↗</a>
        </div>
      </div>
      {q.isError && <p className="text-red-400">{(q.error as Error).message}</p>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Tile label="播放会话（15m）" value={d?.qoe.sessions} />
        <Tile label="起播 p50" value={d?.qoe.ttffP50} unit="ms" />
        <Tile label="起播 p95" value={d?.qoe.ttffP95} unit="ms" hint="目标 < 3000" />
        <Tile label="秒开率" value={d?.qoe.fastStartPct} unit="%" hint="TTFF ≤ 1s" />
        <Tile label="百秒卡顿时长" value={d?.qoe.stallPer100s} hint="目标 < 1" />
        <Tile label="播放失败率" value={d?.qoe.failurePct} unit="%" hint="目标 < 0.5%" />
      </div>
      <p className="mt-2 text-xs text-zinc-500">数据源：{d?.qoe.source === 'clickhouse' ? 'ClickHouse qoe.events' : '未配置 ClickHouse（api 退化为控制台输出）'}</p>

      <h2 className="mb-2 mt-8 text-lg font-semibold">房间</h2>
      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900 text-left text-xs text-zinc-400">
            <tr><th className="p-3">房间</th><th className="p-3">状态</th><th className="p-3">模式</th><th className="p-3">在线</th><th className="p-3">消息/秒</th><th className="p-3">操作</th></tr>
          </thead>
          <tbody>
            {d?.rooms.map((r) => (
              <tr key={r.id} className="border-t border-zinc-800">
                <td className="p-3">{r.title}<div className="text-xs text-zinc-500">{r.id} · {r.hostName}</div></td>
                <td className="p-3">{r.status === 'live' ? <span className="text-brand">LIVE</span> : <span className="text-zinc-500">离线</span>}</td>
                <td className="p-3">{r.mode}</td>
                <td className="p-3 tabular-nums">{r.online}</td>
                <td className="p-3 tabular-nums">{r.msgRate.toFixed(2)}</td>
                <td className="p-3 space-x-3"><Link className="text-sky-400 hover:underline" to={`/room/${r.id}`}>观看</Link><Link className="text-sky-400 hover:underline" to={`/host/${r.id}`}>主播台</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
