import { useEffect, useState } from 'react';
import type { ClientFrame } from '@livelab/protocol';
import { useRoomStore } from '../../stores/room';
import { useSession } from '../../stores/session';

export function ChatInput({ roomId, send, onLogin }: { roomId: string; send: (f: ClientFrame) => boolean; onLogin: () => void }) {
  const [text, setText] = useState('');
  const user = useSession((s) => s.user);
  const status = useRoomStore((s) => s.status);
  const slow = useRoomStore((s) => s.state.slowModeSec);
  const error = useRoomStore((s) => s.lastError);
  const clearError = useRoomStore((s) => s.clearError);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (!error) return;
    if (error.retryAfterMs) setCooldown(Math.ceil(error.retryAfterMs / 1000));
    const t = setTimeout(clearError, 4000);
    return () => clearTimeout(t);
  }, [error, clearError]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || !user) return;
    const cid = crypto.randomUUID();
    // Optimistic echo: shown immediately as "sending…", replaced by the server copy carrying the same cid.
    useRoomStore.getState().addOptimistic({ t: 'chat', lane: 'chat', seq: 0, room: roomId, ts: Date.now(), id: cid, cid, user, text: t });
    if (!send({ t: 'chat', cid, text: t })) useRoomStore.getState().dropOptimistic(cid);
    setText('');
    if (slow > 0 && user.role === 'viewer') setCooldown(slow);
  };

  if (!user) {
    return <button onClick={onLogin} className="m-2 rounded bg-zinc-800 py-2 text-sm text-zinc-300 hover:bg-zinc-700">登录后参与聊天</button>;
  }

  const disabled = status !== 'open' || cooldown > 0;
  return (
    <form onSubmit={submit} className="border-t border-zinc-800 p-2">
      {error && <div className="mb-1 text-xs text-red-400">{error.message}</div>}
      <div className="flex gap-2">
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={200} disabled={disabled}
          placeholder={cooldown > 0 ? `慢速模式，${cooldown}s 后可发言` : slow > 0 ? `慢速模式 ${slow}s · 说点什么…` : '说点什么…'}
          className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm outline-none focus:border-brand disabled:opacity-60" />
        <button disabled={disabled || !text.trim()} className="rounded bg-brand px-3 text-sm font-medium disabled:opacity-40">发送</button>
      </div>
    </form>
  );
}
