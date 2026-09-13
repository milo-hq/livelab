import { create } from 'zustand';
import type { ChatMsg, GiftMsg, RoomState, ServerFrame, ServerMsg } from '@livelab/protocol';
import type { ImStatus } from '../lib/im-client';

export const MAX_MESSAGES = 300;

export interface ImError { code: string; message: string; retryAfterMs?: number; at: number }

export interface RoomStore {
  roomId: string | null;
  status: ImStatus;
  reconnectAttempt: number;
  state: RoomState;
  messages: ServerMsg[];
  /** Newest gift (drives the animation layer). */
  lastGift: GiftMsg | null;
  /** Total likes (from like_agg) and a bump counter for burst animation. */
  likeTotal: number;
  likeBurst: number;
  lastError: ImError | null;
  /** cids of our own optimistic messages not yet echoed by the server. */
  pendingCids: Record<string, ChatMsg>;
  reset(roomId: string): void;
  setStatus(s: ImStatus, attempt?: number): void;
  applyFrame(frame: ServerFrame): void;
  addOptimistic(msg: ChatMsg): void;
  dropOptimistic(cid: string): void;
  clearError(): void;
}

export const emptyState: RoomState = { online: 0, slowModeSec: 0, pinned: null, announce: null, poll: null, likes: 0, cohosts: [] };

function appendMessages(list: ServerMsg[], incoming: ServerMsg[]): ServerMsg[] {
  if (incoming.length === 0) return list;
  const next = list.concat(incoming);
  return next.length > MAX_MESSAGES ? next.slice(next.length - MAX_MESSAGES) : next;
}

/**
 * Room realtime state. A `batch` frame is applied in ONE `set` call so React re-renders once per
 * 150ms server tick regardless of how many messages it carried.
 */
export const useRoomStore = create<RoomStore>()((set, get) => ({
  roomId: null,
  status: 'connecting',
  reconnectAttempt: 0,
  state: emptyState,
  messages: [],
  lastGift: null,
  likeTotal: 0,
  likeBurst: 0,
  lastError: null,
  pendingCids: {},

  reset: (roomId) => set({ roomId, status: 'connecting', reconnectAttempt: 0, state: emptyState, messages: [], lastGift: null, likeTotal: 0, likeBurst: 0, lastError: null, pendingCids: {} }),
  setStatus: (status, attempt = 0) => set({ status, reconnectAttempt: attempt }),

  applyFrame: (frame) => {
    switch (frame.t) {
      case 'welcome': {
        // History replaces what we have only when we had nothing (first join); on resume it appends.
        const { messages } = get();
        set({ state: frame.state, likeTotal: frame.state.likes, messages: messages.length === 0 ? frame.history.slice(-MAX_MESSAGES) : appendMessages(messages, frame.history) });
        return;
      }
      case 'batch': {
        const { messages, pendingCids, likeTotal, lastGift, likeBurst } = get();
        let gift = lastGift;
        let likes = likeTotal;
        let burst = likeBurst;
        const pend = { ...pendingCids };
        const visible: ServerMsg[] = [];
        for (const m of frame.msgs) {
          if (m.t === 'chat' && m.cid && pend[m.cid]) delete pend[m.cid];
          if (m.t === 'gift') gift = m;
          if (m.t === 'like_agg') {
            likes = m.total;
            burst += m.count;
            continue; // not shown in the chat list
          }
          if (m.t === 'system' && m.kind === 'online') continue;
          visible.push(m);
        }
        set({ messages: appendMessages(messages, visible), pendingCids: pend, lastGift: gift, likeTotal: likes, likeBurst: burst });
        return;
      }
      case 'state':
        set((s) => ({ state: { ...s.state, ...frame.state }, likeTotal: frame.state.likes ?? s.likeTotal }));
        return;
      case 'error':
        set({ lastError: { code: frame.code, message: frame.message, retryAfterMs: frame.retryAfterMs, at: Date.now() } });
        if (frame.cid) get().dropOptimistic(frame.cid);
        return;
      case 'pong':
        return;
    }
  },

  addOptimistic: (msg) => set((s) => ({ pendingCids: { ...s.pendingCids, [msg.cid!]: msg } })),
  dropOptimistic: (cid) => set((s) => {
    const p = { ...s.pendingCids };
    delete p[cid];
    return { pendingCids: p };
  }),
  clearError: () => set({ lastError: null }),
}));
