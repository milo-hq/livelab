import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerFrame, ServerMsg, UserRef } from '@livelab/protocol';
import { createMemoryBus } from './bus.js';
import { createMemoryHistory } from './history.js';
import { RoomHub, type Conn } from './hub.js';

const u = (id: string): UserRef => ({ id, name: id, role: 'viewer' });
const gift = { id: 'g', name: 'Rocket', price: 100, animation: 'rocket' as const, icon: '🚀' };

function conn(id: string): Conn & { frames: ServerFrame[] } {
  const frames: ServerFrame[] = [];
  return { id, user: u(id), frames, send: (f) => frames.push(f) };
}
const batches = (c: { frames: ServerFrame[] }) => c.frames.filter((f): f is Extract<ServerFrame, { t: 'batch' }> => f.t === 'batch');
const msgs = (c: { frames: ServerFrame[] }) => batches(c).flatMap((b) => b.msgs);

function makeHub(over: Partial<ConstructorParameters<typeof RoomHub>[0]> = {}) {
  return new RoomHub({ bus: createMemoryBus(), history: createMemoryHistory(), joinNoticeBelow: 0, ...over });
}

describe('RoomHub', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('welcome carries state, latest seq and last 50 messages; nothing is flushed before batchMs', async () => {
    const hub = makeHub();
    for (let i = 0; i < 60; i++) await hub.broadcast('r', { t: 'chat', lane: 'chat', room: 'r', id: `m${i}`, user: u('x'), text: `${i}` });
    const a = conn('a');
    await hub.join('r', a);
    const w = a.frames[0];
    expect(w?.t).toBe('welcome');
    if (w?.t !== 'welcome') return;
    expect(w.seq).toBe(60);
    expect(w.history).toHaveLength(50);
    expect(w.history[0]!.seq).toBe(11);
    expect(w.state).toEqual({ online: 1, slowModeSec: 0, pinned: null, announce: null, poll: null, likes: 0, cohosts: [] });
    await hub.close();
  });

  it('two conns receive one batch after 150ms containing the message with seq 1; seq strictly increases', async () => {
    const hub = makeHub();
    const a = conn('a');
    const b = conn('b');
    await hub.join('r', a);
    await hub.join('r', b);
    expect(hub.online('r')).toBe(2);
    const m1 = await hub.broadcast('r', { t: 'chat', lane: 'chat', room: 'r', id: 'm1', cid: 'c1', user: u('a'), text: 'hi' });
    const m2 = await hub.broadcast('r', { t: 'chat', lane: 'chat', room: 'r', id: 'm2', user: u('b'), text: 'yo' });
    expect(m1.seq).toBe(1);
    expect(m2.seq).toBe(2);
    expect(batches(a)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(149);
    expect(batches(a)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(batches(a)).toHaveLength(1);
    expect(batches(b)).toHaveLength(1);
    expect(batches(a)[0]!.msgs.map((m) => m.seq)).toEqual([1, 2]);
    expect(batches(a)[0]!.msgs[0]).toMatchObject({ t: 'chat', cid: 'c1', text: 'hi' });
    // A later message goes in a fresh batch, later seq.
    const m3 = await hub.broadcast('r', { t: 'system', lane: 'system', room: 'r', kind: 'announce', payload: {} });
    expect(m3.seq).toBe(3);
    await vi.advanceTimersByTimeAsync(150);
    expect(batches(a)).toHaveLength(2);
    expect(msgs(a).map((m) => m.seq)).toEqual([1, 2, 3]);
    await hub.close();
  });

  it('a late joiner with lastSeq 0 gets the earlier message in welcome.history and is not sent it twice', async () => {
    const hub = makeHub();
    const a = conn('a');
    await hub.join('r', a);
    await hub.broadcast('r', { t: 'chat', lane: 'chat', room: 'r', id: 'm1', user: u('a'), text: 'first' });
    const late = conn('late');
    await hub.join('r', late, 0);
    const w = late.frames[0];
    expect(w?.t === 'welcome' && w.history.map((m) => m.seq)).toEqual([1]);
    await vi.advanceTimersByTimeAsync(300);
    expect(msgs(late)).toHaveLength(0);
    // resume from seq 1 → nothing to replay
    const resumed = conn('resumed');
    await hub.join('r', resumed, 1);
    expect(resumed.frames[0]?.t === 'welcome' && resumed.frames[0].history).toEqual([]);
    await hub.close();
  });

  it('drops the oldest chat when the queue exceeds 200 but keeps gift and system', async () => {
    const hub = makeHub({ queueCap: 200 });
    const a = conn('a');
    await hub.join('r', a);
    await hub.broadcast('r', { t: 'gift', lane: 'gift', room: 'r', id: 'g1', user: u('a'), gift, count: 1 });
    await hub.broadcast('r', { t: 'system', lane: 'system', room: 'r', kind: 'announce', payload: {} });
    for (let i = 0; i < 250; i++) await hub.broadcast('r', { t: 'chat', lane: 'chat', room: 'r', id: `m${i}`, user: u('a'), text: `${i}` });
    await vi.advanceTimersByTimeAsync(150);
    const got = msgs(a);
    expect(got).toHaveLength(200);
    expect(got[0]!.t).toBe('gift');
    expect(got[1]!.t).toBe('system');
    const chats = got.filter((m) => m.t === 'chat');
    expect(chats).toHaveLength(198);
    expect(chats[0]!.seq).toBe(55); // seqs 3..54 (52 oldest chats) were dropped
    expect(chats[197]!.seq).toBe(252);
    await hub.close();
  });

  it('broadcasts join notices only in small rooms and coalesces online counts to one per 2s', async () => {
    const hub = makeHub({ joinNoticeBelow: 3 });
    const a = conn('a');
    const b = conn('b');
    const c = conn('c');
    await hub.join('r', a);
    await hub.join('r', b);
    await hub.join('r', c); // third conn: room is now >= joinNoticeBelow → no notice
    await vi.advanceTimersByTimeAsync(150);
    const joins = msgs(a).filter((m) => m.t === 'system' && m.kind === 'join');
    expect(joins).toHaveLength(2);
    expect(joins.map((m) => m.t === 'system' && (m.payload['user'] as UserRef).id)).toEqual(['a', 'b']);
    expect(msgs(a).filter((m) => m.t === 'system' && m.kind === 'online')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);
    const online = msgs(a).filter((m): m is Extract<ServerMsg, { t: 'system' }> => m.t === 'system' && m.kind === 'online');
    expect(online).toHaveLength(1);
    expect(online[0]!.payload).toEqual({ online: 3 });
    hub.leave('r', c);
    expect(hub.online('r')).toBe(2);
    await vi.advanceTimersByTimeAsync(2200);
    const online2 = msgs(a).filter((m): m is Extract<ServerMsg, { t: 'system' }> => m.t === 'system' && m.kind === 'online');
    expect(online2).toHaveLength(2);
    expect(online2[1]!.payload).toEqual({ online: 2 });
    await hub.close();
  });

  it('setState pushes a state frame immediately (not sequenced) and welcome reflects it', async () => {
    const hub = makeHub();
    const a = conn('a');
    await hub.join('r', a);
    hub.setState('r', { announce: 'hello', slowModeSec: 5 });
    expect(a.frames[1]).toEqual({ t: 'state', state: { announce: 'hello', slowModeSec: 5 } });
    const b = conn('b');
    await hub.join('r', b);
    expect(b.frames[0]?.t === 'welcome' && b.frames[0].state).toMatchObject({ announce: 'hello', slowModeSec: 5, online: 2 });
    expect(b.frames[0]?.t === 'welcome' && b.frames[0].seq).toBe(0);
    await hub.close();
  });

  it('polls: one vote per user, ended polls reject votes; like_agg updates state.likes', async () => {
    const hub = makeHub({ now: () => 1000 });
    hub.startPoll('r', { id: 'p1', question: 'q', options: ['a', 'b'], votes: [0, 0], endsAt: 5000 });
    expect(hub.vote('r', 'p1', 1, 'u1')).toBe('ok');
    expect(hub.vote('r', 'p1', 0, 'u1')).toBe('already_voted');
    expect(hub.vote('r', 'p1', 5, 'u2')).toBe('bad_option');
    expect(hub.vote('r', 'nope', 0, 'u2')).toBe('no_poll');
    expect(hub.state('r').poll?.votes).toEqual([0, 1]);
    hub.startPoll('r', { id: 'p2', question: 'q', options: ['a', 'b'], votes: [0, 0], endsAt: 999 });
    expect(hub.vote('r', 'p2', 0, 'u1')).toBe('ended');
    await hub.broadcast('r', { t: 'like_agg', lane: 'system', room: 'r', count: 3, total: 42 });
    expect(hub.state('r').likes).toBe(42);
    await hub.close();
  });

  it('msgRate counts messages over the last 60s', async () => {
    let t = 0;
    const hub = makeHub({ now: () => t });
    for (let i = 0; i < 30; i++) await hub.broadcast('r', { t: 'chat', lane: 'chat', room: 'r', id: `m${i}`, user: u('a'), text: 'x' });
    expect(hub.msgRate('r')).toBe(0.5);
    t = 61_000;
    expect(hub.msgRate('r')).toBe(0);
    await hub.close();
  });

  it('samples chat per connection in large rooms using rnd, never gifts', async () => {
    const hub = makeHub({ rnd: () => 0.99 });
    const conns = Array.from({ length: 100 }, (_, i) => conn(`c${i}`));
    for (const c of conns) await hub.join('r', c);
    await hub.broadcast('r', { t: 'chat', lane: 'chat', room: 'r', id: 'm', user: u('a'), text: 'x' });
    await hub.broadcast('r', { t: 'gift', lane: 'gift', room: 'r', id: 'g', user: u('a'), gift, count: 1 });
    await vi.advanceTimersByTimeAsync(150);
    expect(msgs(conns[0]!).map((m) => m.t)).toEqual(['gift']);
    await hub.close();
  });
});
