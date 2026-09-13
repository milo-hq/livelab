import { useState } from 'react';
import { useRoomStore } from '../../stores/room';
import { useModAction } from './moderation-panel';

export function PollPanel({ roomId }: { roomId: string }) {
  const poll = useRoomStore((s) => s.state.poll);
  const act = useModAction(roomId);
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState(['', '']);
  const total = poll ? poll.votes.reduce((a, b) => a + b, 0) : 0;

  return (
    <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="font-semibold">投票</h3>
      {poll ? (
        <div className="space-y-1 text-sm">
          <div className="font-medium">{poll.question}</div>
          {poll.options.map((o, i) => {
            const v = poll.votes[i] ?? 0;
            const pct = total ? Math.round((v / total) * 100) : 0;
            return (
              <div key={i} className="relative overflow-hidden rounded bg-zinc-950 px-2 py-1">
                <div className="absolute inset-y-0 left-0 bg-brand/30" style={{ width: `${pct}%` }} />
                <span className="relative">{o} · {v} ({pct}%)</span>
              </div>
            );
          })}
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>共 {total} 票 · {Math.max(0, Math.round((poll.endsAt - Date.now()) / 1000))}s 后结束</span>
            <button className="text-red-300" onClick={() => act.mutate({ action: 'poll_end' })}>结束</button>
          </div>
        </div>
      ) : (
        <div className="space-y-2 text-sm">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="问题" className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1" />
          {opts.map((o, i) => (
            <input key={i} value={o} onChange={(e) => setOpts(opts.map((x, j) => (j === i ? e.target.value : x)))} placeholder={`选项 ${i + 1}`} className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1" />
          ))}
          <div className="flex gap-2">
            {opts.length < 4 && <button className="rounded bg-zinc-700 px-2 py-1 text-xs" onClick={() => setOpts([...opts, ''])}>+ 选项</button>}
            <button disabled={!q.trim() || opts.filter((o) => o.trim()).length < 2} onClick={() => act.mutate({ action: 'poll_start', question: q.trim(), options: opts.filter((o) => o.trim()), seconds: 60 })}
              className="rounded bg-brand px-3 py-1 text-xs font-medium disabled:opacity-40">发起（60s）</button>
          </div>
        </div>
      )}
    </div>
  );
}
