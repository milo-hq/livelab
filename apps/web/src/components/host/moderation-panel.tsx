import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';
import { ModState, type ModAction } from '@livelab/protocol';
import { api } from '../../lib/api';
import { useRoomStore } from '../../stores/room';

export function useModAction(roomId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: ModAction) => api.post(`/v1/rooms/${roomId}/mod`, a, z.unknown()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mod', roomId] }),
  });
}

export function ModerationPanel({ roomId }: { roomId: string }) {
  const mod = useQuery({ queryKey: ['mod', roomId], queryFn: () => api.get(`/v1/rooms/${roomId}/mod`, ModState), refetchInterval: 5000 });
  const act = useModAction(roomId);
  const state = useRoomStore((s) => s.state);
  const [keyword, setKeyword] = useState('');
  const [announce, setAnnounce] = useState('');

  return (
    <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="font-semibold">聊天治理</h3>
      <div className="flex items-center gap-2 text-sm">
        <span className="text-zinc-400">慢速模式</span>
        {[0, 5, 10, 30].map((s) => (
          <button key={s} onClick={() => act.mutate({ action: 'slow_mode', seconds: s })}
            className={`rounded border px-2 py-0.5 text-xs ${state.slowModeSec === s ? 'border-brand' : 'border-zinc-700'}`}>{s === 0 ? '关' : `${s}s`}</button>
        ))}
      </div>
      <div className="flex gap-2">
        <input value={announce} onChange={(e) => setAnnounce(e.target.value)} placeholder="公告内容" className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm" />
        <button onClick={() => { act.mutate({ action: 'announce', text: announce }); setAnnounce(''); }} className="rounded bg-zinc-700 px-2 text-xs">发布</button>
      </div>
      <div className="flex gap-2">
        <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="屏蔽关键词" className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm" />
        <button onClick={() => { if (keyword.trim()) act.mutate({ action: 'keyword_add', text: keyword.trim() }); setKeyword(''); }} className="rounded bg-zinc-700 px-2 text-xs">添加</button>
      </div>
      <div className="flex flex-wrap gap-1 text-xs">
        {mod.data?.keywords.map((k) => (
          <span key={k} className="rounded bg-zinc-800 px-2 py-0.5">{k} <button className="text-zinc-400 hover:text-red-300" onClick={() => act.mutate({ action: 'keyword_remove', text: k })}>×</button></span>
        ))}
      </div>
      {state.pinned && (
        <div className="rounded bg-zinc-950 p-2 text-xs">
          置顶：{state.pinned.user.name}: {state.pinned.text} <button className="ml-2 text-zinc-400 hover:text-red-300" onClick={() => act.mutate({ action: 'unpin' })}>取消置顶</button>
        </div>
      )}
      {mod.data && mod.data.muted.length + mod.data.banned.length > 0 && (
        <div className="text-xs text-zinc-400">
          禁言 {mod.data.muted.length} · 封禁 {mod.data.banned.length}
          {mod.data.muted.map((m) => <button key={m.userId} className="ml-2 text-sky-400" onClick={() => act.mutate({ action: 'unmute', targetUserId: m.userId })}>解禁 {m.userId.slice(0, 8)}</button>)}
        </div>
      )}
      <p className="text-[11px] text-zinc-500">在聊天列表点击昵称可禁言 / 封禁 / 置顶。</p>
    </div>
  );
}
