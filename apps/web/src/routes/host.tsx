import { useState } from 'react';
import { useParams } from 'react-router';
import { useRoomConnection } from '../hooks/use-room-connection';
import { useSession } from '../stores/session';
import { ChatPanel } from '../components/chat/chat-panel';
import { ChatInput } from '../components/chat/chat-input';
import { StreamSetup } from '../components/host/stream-setup';
import { HealthCard } from '../components/host/health-card';
import { ModerationPanel, useModAction } from '../components/host/moderation-panel';
import { PollPanel } from '../components/host/poll-panel';
import { CohostPanel } from '../components/host/cohost-panel';
import { CohostLayer } from '../components/cohost/cohost-layer';
import { LoginDialog } from '../components/login-dialog';
import { useRoomStore } from '../stores/room';
import { LivePlayer } from '../components/player/live-player';

export default function HostPage() {
  const { id = 'demo' } = useParams();
  const user = useSession((s) => s.user);
  const { send } = useRoomConnection(id);
  const act = useModAction(id);
  const online = useRoomStore((s) => s.state.online);
  const [login, setLogin] = useState(false);
  const [target, setTarget] = useState<{ userId: string; name: string } | null>(null);

  if (!user || (user.role !== 'host' && user.role !== 'admin')) {
    return (
      <div className="p-8 text-zinc-400">
        主播控制台需要「主播」或「管理员」角色。<button className="ml-2 text-sky-400" onClick={() => setLogin(true)}>登录</button>
        {login && <LoginDialog onClose={() => setLogin(false)} />}
      </div>
    );
  }

  return (
    <div className="mx-auto grid max-w-7xl grid-cols-1 gap-4 p-4 lg:grid-cols-[1fr_360px]">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">主播控制台 · {id}</h1>
          <span className="text-sm text-zinc-400">在线 {online}</span>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <StreamSetup roomId={id} />
          <HealthCard roomId={id} />
        </div>
        <div className="aspect-video overflow-hidden rounded-lg bg-black">
          <LivePlayer roomId={id} muted compact><CohostLayer /></LivePlayer>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <ModerationPanel roomId={id} />
          <PollPanel roomId={id} />
          <CohostPanel roomId={id} />
        </div>
      </div>
      <div className="flex h-[70vh] flex-col rounded-lg border border-zinc-800 bg-zinc-900 lg:h-auto">
        <div className="border-b border-zinc-800 px-3 py-2 text-sm font-medium">聊天（点击昵称管理）</div>
        <ChatPanel onUser={(userId, name) => setTarget({ userId, name })} />
        <ChatInput roomId={id} send={send} onLogin={() => setLogin(false)} />
      </div>
      {target && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setTarget(null)}>
          <div onClick={(e) => e.stopPropagation()} className="w-72 space-y-2 rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-sm">
            <div className="font-medium">{target.name}</div>
            <button className="block w-full rounded bg-zinc-800 py-1.5 hover:bg-zinc-700" onClick={() => { act.mutate({ action: 'mute', targetUserId: target.userId, seconds: 300 }); setTarget(null); }}>禁言 5 分钟</button>
            <button className="block w-full rounded bg-zinc-800 py-1.5 hover:bg-zinc-700" onClick={() => { act.mutate({ action: 'ban', targetUserId: target.userId }); setTarget(null); }}>封禁</button>
            <button className="block w-full rounded bg-zinc-800 py-1.5 hover:bg-zinc-700" onClick={() => {
              const last = [...useRoomStore.getState().messages].reverse().find((m) => m.t === 'chat' && m.user.id === target.userId);
              if (last && last.t === 'chat') act.mutate({ action: 'pin', msgId: last.id });
              setTarget(null);
            }}>置顶其最新消息</button>
          </div>
        </div>
      )}
    </div>
  );
}
