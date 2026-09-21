import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { Room } from '@livelab/protocol';
import { api } from '../lib/api';
import { useRoomConnection } from '../hooks/use-room-connection';
import { useRoomStore } from '../stores/room';
import { useSession } from '../stores/session';
import { ChatPanel } from '../components/chat/chat-panel';
import { ChatInput } from '../components/chat/chat-input';
import { LikeButton } from '../components/chat/like-button';
import { DanmakuLayer, type DanmakuDensity } from '../components/danmaku-layer';
import { GiftLayer } from '../components/gifts/gift-layer';
import { GiftPanel } from '../components/gifts/gift-panel';
import { RechargeDialog, WalletBadge } from '../components/wallet/wallet';
import { LoginDialog } from '../components/login-dialog';
import { LivePlayer } from '../components/player/live-player';
import { CohostControl, CohostPublisherSlot } from '../components/cohost/cohost-button';
import { CohostLayer } from '../components/cohost/cohost-layer';

function PollCard({ send }: { send: ReturnType<typeof useRoomConnection>['send'] }) {
  const poll = useRoomStore((s) => s.state.poll);
  const [voted, setVoted] = useState<string | null>(null);
  if (!poll) return null;
  const total = poll.votes.reduce((a, b) => a + b, 0);
  return (
    <div className="m-2 rounded-lg border border-zinc-700 bg-zinc-950 p-3 text-sm">
      <div className="mb-1 font-medium">📊 {poll.question}</div>
      {poll.options.map((o, i) => {
        const pct = total ? Math.round(((poll.votes[i] ?? 0) / total) * 100) : 0;
        return (
          <button key={i} disabled={voted === poll.id} onClick={() => { send({ t: 'vote', pollId: poll.id, option: i }); setVoted(poll.id); }}
            className="relative mb-1 block w-full overflow-hidden rounded bg-zinc-900 px-2 py-1 text-left disabled:opacity-80">
            <span className="absolute inset-y-0 left-0 bg-brand/30" style={{ width: `${pct}%` }} />
            <span className="relative">{o} <span className="text-zinc-400">{pct}%</span></span>
          </button>
        );
      })}
      <div className="text-xs text-zinc-500">{total} 票</div>
    </div>
  );
}

export default function RoomPage() {
  const { id = 'demo' } = useParams();
  const room = useQuery({ queryKey: ['room', id], queryFn: () => api.get(`/v1/rooms/${id}`, Room), refetchInterval: 15_000 });
  const user = useSession((s) => s.user);
  const { send } = useRoomConnection(id);
  const online = useRoomStore((s) => s.state.online);
  const pinned = useRoomStore((s) => s.state.pinned);
  const announce = useRoomStore((s) => s.state.announce);
  const [login, setLogin] = useState(false);
  const [recharge, setRecharge] = useState(false);
  const [density, setDensity] = useState<DanmakuDensity>('normal');

  return (
    <div className="mx-auto flex h-full max-w-[1400px] flex-col gap-3 p-3 lg:flex-row">
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black">
          <LivePlayer roomId={id} muted={false}>
            <DanmakuLayer density={density} />
            <GiftLayer />
            <CohostLayer />
            <CohostPublisherSlot />
          </LivePlayer>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold">{room.data?.title ?? id}</h1>
            <div className="truncate whitespace-nowrap text-xs text-zinc-400">{room.data?.hostName} · {online} 在线 · {room.data?.mode === 'interactive' ? 'WebRTC 互动' : 'LL-HLS'}</div>
          </div>
          <select value={density} onChange={(e) => setDensity(e.target.value as DanmakuDensity)} className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs">
            <option value="off">弹幕关</option><option value="low">弹幕少</option><option value="normal">弹幕中</option><option value="high">弹幕多</option>
          </select>
          {user && <WalletBadge onRecharge={() => setRecharge(true)} />}
          <LikeButton send={send} />
          <CohostControl roomId={id} onLogin={() => setLogin(true)} />
          {user?.role !== 'viewer' && user && <Link to={`/host/${id}`} className="text-xs text-sky-400">主播台 →</Link>}
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
          <GiftPanel roomId={id} onNeedCoins={() => setRecharge(true)} onLogin={() => setLogin(true)} />
        </div>
      </div>
      <aside className="flex h-[60vh] w-full flex-col rounded-lg border border-zinc-800 bg-zinc-900 lg:h-auto lg:w-[340px]">
        {announce && <div className="border-b border-zinc-800 bg-sky-900/30 px-3 py-1.5 text-xs text-sky-200">📢 {announce}</div>}
        {pinned && <div className="border-b border-zinc-800 bg-amber-900/20 px-3 py-1.5 text-xs text-amber-100">📌 {pinned.user.name}: {pinned.text}</div>}
        <PollCard send={send} />
        <ChatPanel />
        <ChatInput roomId={id} send={send} onLogin={() => setLogin(true)} />
      </aside>
      {login && <LoginDialog onClose={() => setLogin(false)} />}
      {recharge && <RechargeDialog onClose={() => setRecharge(false)} />}
    </div>
  );
}
