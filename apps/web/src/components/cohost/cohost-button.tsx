import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { CohostOverview } from '@livelab/protocol';
import { api } from '../../lib/api';
import { useRoomStore } from '../../stores/room';
import { useSession } from '../../stores/session';
import { CohostPublisher } from './cohost-publisher';

/**
 * Viewer side of 连麦: request → (host accepts) → we appear in `state.cohosts` → publish.
 * Rejection / ending arrives as a `system{cohost}` message addressed to our userId.
 */
export function CohostControl({ roomId, onLogin }: { roomId: string; onLogin: () => void }) {
  const me = useSession((s) => s.user);
  const mine = useRoomStore((s) => s.state.cohosts.find((c) => c.userId === me?.id) ?? null);
  const messages = useRoomStore((s) => s.messages);
  const [requested, setRequested] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const request = useMutation({ mutationFn: () => api.post(`/v1/rooms/${roomId}/cohost/request`, {}, CohostOverview), onSuccess: () => { setRequested(true); setNotice('已申请，等待主播接受'); } });
  const cancel = useMutation({ mutationFn: () => api.del(`/v1/rooms/${roomId}/cohost/request`, CohostOverview), onSuccess: () => { setRequested(false); setNotice(null); } });
  const end = useMutation({ mutationFn: () => api.post(`/v1/rooms/${roomId}/cohost/end`, {}, CohostOverview) });

  // Watch for rejected/ended notices addressed to me.
  useEffect(() => {
    const last = messages.at(-1);
    if (!last || last.t !== 'system' || last.kind !== 'cohost' || last.payload['userId'] !== me?.id) return;
    const state = String(last.payload['state']);
    if (state === 'rejected') { setRequested(false); setNotice('主播暂未接受'); }
    if (state === 'ended') { setRequested(false); setNotice('连麦已结束'); }
    if (state === 'accepted') { setRequested(false); setNotice(null); }
  }, [messages, me?.id]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  if (!me) return <button onClick={onLogin} className="rounded-full bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700">🎙 连麦</button>;

  return (
    <>
      <div className="flex items-center gap-2">
        {mine ? (
          <button onClick={() => end.mutate()} className="rounded-full bg-brand px-3 py-1.5 text-sm">🎙 麦上 · 挂断</button>
        ) : requested ? (
          <button onClick={() => cancel.mutate()} className="rounded-full bg-zinc-700 px-3 py-1.5 text-sm">⏳ 等待接受 · 取消</button>
        ) : (
          <button onClick={() => request.mutate()} disabled={request.isPending} className="rounded-full bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700">🎙 申请连麦</button>
        )}
        {notice && <span className="text-xs text-zinc-400">{notice}</span>}
        {request.isError && <span className="text-xs text-red-400">{(request.error as Error).message}</span>}
      </div>
      {mine && <CohostPublisherPortal cohost={mine} onEnd={() => end.mutate()} />}
    </>
  );
}

/** The publisher renders inside the player overlay; exposed via a store so RoomPage can place it. */
import { create } from 'zustand';
import type { Cohost } from '@livelab/protocol';
export const usePublisherSlot = create<{ cohost: Cohost | null; onEnd: (() => void) | null; set(c: Cohost | null, onEnd: (() => void) | null): void }>((set) => ({
  cohost: null, onEnd: null, set: (cohost, onEnd) => set({ cohost, onEnd }),
}));
function CohostPublisherPortal({ cohost, onEnd }: { cohost: Cohost; onEnd: () => void }) {
  const set = usePublisherSlot((s) => s.set);
  useEffect(() => { set(cohost, onEnd); return () => set(null, null); }, [cohost, onEnd, set]);
  return null;
}
export function CohostPublisherSlot() {
  const cohost = usePublisherSlot((s) => s.cohost);
  const onEnd = usePublisherSlot((s) => s.onEnd);
  if (!cohost || !onEnd) return null;
  return <CohostPublisher cohost={cohost} onEnd={onEnd} />;
}
