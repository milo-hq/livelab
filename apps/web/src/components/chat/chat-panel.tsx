import { useEffect, useRef, useState } from 'react';
import type { ServerMsg } from '@livelab/protocol';
import { useRoomStore } from '../../stores/room';
import { useSession } from '../../stores/session';

const RENDER_WINDOW = 120;

function roleBadge(role: string) {
  if (role === 'host') return <span className="mr-1 rounded bg-brand px-1 text-[10px] font-semibold">主播</span>;
  if (role === 'admin') return <span className="mr-1 rounded bg-sky-600 px-1 text-[10px] font-semibold">管理</span>;
  return null;
}

function Message({ m, onUser }: { m: ServerMsg; onUser?: (userId: string, name: string) => void }) {
  if (m.t === 'chat') {
    return (
      <div className="px-3 py-1 text-sm leading-5 hover:bg-zinc-800/60">
        {roleBadge(m.user.role)}
        <button className="mr-1 text-zinc-400 hover:text-zinc-200" onClick={() => onUser?.(m.user.id, m.user.name)}>{m.user.name}:</button>
        <span className="break-words">{m.text}</span>
      </div>
    );
  }
  if (m.t === 'gift') {
    return (
      <div className="mx-2 my-1 rounded bg-gradient-to-r from-amber-500/30 to-transparent px-2 py-1 text-sm">
        <span className="text-amber-300">{m.user.name}</span> 送出 {m.gift.icon} {m.gift.name} ×{m.count}
      </div>
    );
  }
  if (m.t === 'system') {
    const text =
      m.kind === 'join' ? `${String(m.payload['name'] ?? '')} 进入直播间` :
      m.kind === 'announce' ? `公告：${String(m.payload['text'] ?? '')}` :
      m.kind === 'slow_mode' ? `慢速模式：${String(m.payload['seconds'] ?? 0)} 秒` :
      m.kind === 'mod' ? `管理操作：${String(m.payload['action'] ?? '')}` :
      m.kind === 'poll' ? `投票开始：${String(m.payload['question'] ?? '')}` :
      m.kind === 'poll_end' ? '投票结束' :
      m.kind === 'pin' ? '主播置顶了一条消息' :
      m.kind === 'cohost' ? ({ requested: `${String(m.payload['name'] ?? '')} 申请连麦`, accepted: `${String(m.payload['name'] ?? '')} 上麦了`, ended: `${String(m.payload['name'] ?? '')} 下麦了`, rejected: null, cancelled: null } as Record<string, string | null>)[String(m.payload['state'])] ?? null : null;
    if (!text) return null;
    return <div className="px-3 py-0.5 text-xs text-zinc-500">{text}</div>;
  }
  return null;
}

export function ChatPanel({ onUser }: { onUser?: (userId: string, name: string) => void }) {
  const messages = useRoomStore((s) => s.messages);
  const pending = useRoomStore((s) => s.pendingCids);
  const status = useRoomStore((s) => s.status);
  const attempt = useRoomStore((s) => s.reconnectAttempt);
  const me = useSession((s) => s.user);
  const listRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStick] = useState(true);
  const [unseen, setUnseen] = useState(0);

  // Only the tail is rendered; 300 messages are kept in the store for scroll-back.
  const visible = messages.slice(-RENDER_WINDOW);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (stickToBottom) el.scrollTop = el.scrollHeight;
    else setUnseen((n) => n + 1);
  }, [messages, stickToBottom]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setStick(atBottom);
    if (atBottom) setUnseen(0);
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {status !== 'open' && (
        <div className="bg-amber-900/40 px-3 py-1 text-xs text-amber-200">
          {status === 'connecting' ? '连接中…' : status === 'reconnecting' ? `连接断开，第 ${attempt} 次重连…` : '已断开'}
        </div>
      )}
      <div ref={listRef} onScroll={onScroll} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto py-1">
        {visible.map((m) => <Message key={`${m.seq}`} m={m} onUser={onUser} />)}
        {Object.values(pending).map((m) => (
          <div key={m.cid} className="px-3 py-1 text-sm text-zinc-500">
            <span className="mr-1">{me?.name}:</span>{m.text} <span className="text-[10px]">发送中…</span>
          </div>
        ))}
      </div>
      {!stickToBottom && unseen > 0 && (
        <button
          onClick={() => { setStick(true); setUnseen(0); listRef.current && (listRef.current.scrollTop = listRef.current.scrollHeight); }}
          className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-brand px-3 py-1 text-xs shadow">
          {unseen} 条新消息 ↓
        </button>
      )}
    </div>
  );
}
