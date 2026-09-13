import { beforeEach, describe, expect, it } from 'vitest';
import { useRoomStore, MAX_MESSAGES } from './room';

const user = { id: 'u', name: 'n', role: 'viewer' as const };
const chat = (seq: number, cid?: string) => ({ t: 'chat' as const, lane: 'chat' as const, seq, room: 'r', ts: seq, id: `m${seq}`, cid, user, text: 'x' });

describe('room store', () => {
  beforeEach(() => useRoomStore.getState().reset('r'));

  it('applies welcome state and history', () => {
    useRoomStore.getState().applyFrame({ t: 'welcome', seq: 2, state: { online: 3, slowModeSec: 5, pinned: null, announce: 'hi', poll: null, likes: 9 }, history: [chat(1), chat(2)] });
    const s = useRoomStore.getState();
    expect(s.state.online).toBe(3);
    expect(s.likeTotal).toBe(9);
    expect(s.messages.map((m) => m.seq)).toEqual([1, 2]);
  });

  it('caps the message list', () => {
    const msgs = Array.from({ length: MAX_MESSAGES + 50 }, (_, i) => chat(i + 1));
    useRoomStore.getState().applyFrame({ t: 'batch', msgs });
    const s = useRoomStore.getState();
    expect(s.messages).toHaveLength(MAX_MESSAGES);
    expect(s.messages[0]!.seq).toBe(51);
  });

  it('clears optimistic message when its cid is echoed and routes gifts/likes to dedicated fields', () => {
    const st = useRoomStore.getState();
    st.addOptimistic({ ...chat(0, 'c1'), seq: 0 });
    expect(Object.keys(useRoomStore.getState().pendingCids)).toEqual(['c1']);
    st.applyFrame({ t: 'batch', msgs: [
      chat(1, 'c1'),
      { t: 'gift', lane: 'gift', seq: 2, room: 'r', ts: 2, id: 'g', user, count: 2, gift: { id: 'rose', name: 'Rose', price: 1, animation: 'hearts', icon: '🌹' } },
      { t: 'like_agg', lane: 'system', seq: 3, room: 'r', ts: 3, count: 4, total: 40 },
    ] });
    const s = useRoomStore.getState();
    expect(s.pendingCids).toEqual({});
    expect(s.lastGift?.id).toBe('g');
    expect(s.likeTotal).toBe(40);
    expect(s.likeBurst).toBe(4);
    expect(s.messages.map((m) => m.t)).toEqual(['chat', 'gift']);
  });

  it('records errors and drops the rejected optimistic message', () => {
    const st = useRoomStore.getState();
    st.addOptimistic({ ...chat(0, 'c9'), seq: 0 });
    st.applyFrame({ t: 'error', code: 'slow_mode', message: 'slow', retryAfterMs: 3000, cid: 'c9' });
    const s = useRoomStore.getState();
    expect(s.lastError?.code).toBe('slow_mode');
    expect(s.pendingCids).toEqual({});
  });
});
