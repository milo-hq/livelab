import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batchWith, connect, host, isError, isPong, isState, isWelcome, startTestApp, token, viewer, waitFor } from './testing.js';
import { CLOSE } from './ws.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
let viewerToken: string;
let hostToken: string;

beforeAll(async () => {
  t = await startTestApp();
  viewerToken = await token(t.app, viewer);
  hostToken = await token(t.app, host);
});
afterAll(async () => { await t.app.close(); });

describe('GET /ws', () => {
  it('rejects a missing/invalid token with error{unauthorized} and close 4401', async () => {
    const c = await connect(t.url, { room: 'demo', token: 'nope' });
    const err = await c.next(isError);
    expect(err.code).toBe('unauthorized');
    expect(await c.closed).toMatchObject({ code: CLOSE.UNAUTHORIZED });
    const c2 = await connect(t.url, { room: 'demo' });
    expect(await c2.closed).toMatchObject({ code: CLOSE.UNAUTHORIZED });
  });

  it('rejects an unknown room with close 4404', async () => {
    const c = await connect(t.url, { room: 'nope', token: viewerToken });
    expect((await c.next(isError)).code).toBe('room_closed');
    expect((await c.closed).code).toBe(CLOSE.ROOM_NOT_FOUND);
  });

  it('hello → welcome with seq, state and history; frames before hello are rejected', async () => {
    const c = await connect(t.url, { room: 'demo', token: viewerToken });
    c.send({ t: 'ping', ts: 1 });
    expect((await c.next(isError)).message).toContain('hello');
    expect((await c.closed).code).toBe(CLOSE.BAD_HELLO);

    const c2 = await connect(t.url, { room: 'demo', token: viewerToken });
    c2.send({ t: 'hello', room: 'demo' });
    const w = await c2.next(isWelcome);
    expect(w.state).toMatchObject({ online: 1, slowModeSec: 0, pinned: null, announce: null, poll: null });
    expect(typeof w.seq).toBe('number');
    expect(Array.isArray(w.history)).toBe(true);
    c2.close();
    await c2.closed;
  });

  it('hello for another room than ?room= is a protocol violation', async () => {
    const c = await connect(t.url, { room: 'demo', token: viewerToken });
    c.send({ t: 'hello', room: 'demo-rt' });
    expect((await c.next(isError)).code).toBe('bad_frame');
    expect((await c.closed).code).toBe(CLOSE.BAD_HELLO);
  });

  it('ping → pong echoing ts with a serverTs', async () => {
    const c = await connect(t.url, { room: 'demo', token: viewerToken }, { hello: true });
    const before = Date.now();
    c.send({ t: 'ping', ts: 12345 });
    const pong = await c.next(isPong);
    expect(pong.ts).toBe(12345);
    expect(pong.serverTs).toBeGreaterThanOrEqual(before);
    c.close();
    await c.closed;
  });

  it('chat → batch echo with the same cid; a second client with lastSeq 0 gets it in welcome.history', async () => {
    const a = await connect(t.url, { room: 'demo', token: viewerToken }, { hello: true });
    a.send({ t: 'chat', cid: 'cid-1', text: '  hello world  ' });
    const batch = await a.next(batchWith((m) => m.t === 'chat' && m.cid === 'cid-1'));
    const msg = batch.msgs.find((m) => m.t === 'chat' && m.cid === 'cid-1');
    expect(msg).toMatchObject({ t: 'chat', lane: 'chat', room: 'demo', text: 'hello world', user: viewer });
    expect(msg!.seq).toBeGreaterThan(0);

    const b = await connect(t.url, { room: 'demo', token: hostToken });
    b.send({ t: 'hello', room: 'demo', lastSeq: 0 });
    const w = await b.next(isWelcome);
    expect(w.history.some((m) => m.t === 'chat' && m.cid === 'cid-1' && m.seq === msg!.seq)).toBe(true);
    expect(w.seq).toBeGreaterThanOrEqual(msg!.seq);
    expect(w.state.online).toBe(2);
    // resume from b's latest seq → only what came after (b's own join notice), never the chat again
    const c = await connect(t.url, { room: 'demo', token: viewerToken });
    c.send({ t: 'hello', room: 'demo', lastSeq: w.seq });
    const wc = await c.next(isWelcome);
    expect(wc.history.every((m) => m.seq > w.seq)).toBe(true);
    expect(wc.history.some((m) => m.t === 'chat')).toBe(false);
    // small room → "a" sees join notices for b and c in batches
    await a.next(batchWith((m) => m.t === 'system' && m.kind === 'join' && (m.payload['user'] as { id: string }).id === host.id));
    for (const x of [a, b, c]) x.close();
    await Promise.all([a.closed, b.closed, c.closed]);
  });

  it('invalid frames produce error{bad_frame} without closing; moderation rejections carry cid', async () => {
    // fresh user: the slow-mode clock is per user and `viewer` just posted above
    const c = await connect(t.url, { room: 'demo', token: await token(t.app, { id: 'u_slow', name: 'Slow', role: 'viewer' }) }, { hello: true });
    c.ws.send('not json');
    expect((await c.next(isError)).code).toBe('bad_frame');
    c.send({ t: 'chat', cid: 'x', text: '' } as never);
    expect((await c.next(isError)).code).toBe('bad_frame');
    c.send({ t: 'like', n: 999 } as never);
    expect((await c.next(isError)).code).toBe('bad_frame');
    expect(c.ws.readyState).toBe(c.ws.OPEN);

    t.app.ctx.moderation.slowMode('demo', 30);
    c.send({ t: 'chat', cid: 'slow-1', text: 'one' });
    await c.next(batchWith((m) => m.t === 'chat' && m.cid === 'slow-1'));
    c.send({ t: 'chat', cid: 'slow-2', text: 'two' });
    const err = await c.next(isError);
    expect(err).toMatchObject({ code: 'slow_mode', cid: 'slow-2' });
    expect(err.retryAfterMs).toBeGreaterThan(0);
    t.app.ctx.moderation.slowMode('demo', 0);

    t.app.ctx.moderation.addKeyword('demo', 'zzz');
    c.send({ t: 'chat', cid: 'kw-1', text: 'zzz' });
    expect(await c.next(isError)).toMatchObject({ code: 'filtered', cid: 'kw-1' });
    c.send({ t: 'chat', cid: 'kw-2', text: 'say zzz twice zzz' });
    const b = await c.next(batchWith((m) => m.t === 'chat' && m.cid === 'kw-2'));
    expect(b.msgs.find((m) => m.t === 'chat' && m.cid === 'kw-2')).toMatchObject({ text: 'say *** twice ***' });
    t.app.ctx.moderation.removeKeyword('demo', 'zzz');
    c.close();
    await c.closed;
  });

  it('likes are aggregated into like_agg with a running total; votes update poll state', async () => {
    const a = await connect(t.url, { room: 'demo-rt', token: viewerToken }, { hello: true });
    const b = await connect(t.url, { room: 'demo-rt', token: hostToken }, { hello: true });
    a.send({ t: 'like', n: 3 });
    b.send({ t: 'like', n: 4 });
    const agg = await a.next(batchWith((m) => m.t === 'like_agg'), 3000);
    const m = agg.msgs.find((x) => x.t === 'like_agg');
    expect(m).toMatchObject({ t: 'like_agg', count: 7, total: 7 });
    expect(t.app.ctx.hub.state('demo-rt').likes).toBe(7);

    t.app.ctx.hub.startPoll('demo-rt', { id: 'p1', question: 'q?', options: ['x', 'y'], votes: [0, 0], endsAt: Date.now() + 60_000 });
    await a.next(isState);
    a.send({ t: 'vote', pollId: 'p1', option: 1 });
    const st = await b.next((f) => isState(f) && f.state.poll?.votes?.[1] === 1);
    expect(st.t === 'state' && st.state.poll?.votes).toEqual([0, 1]);
    a.send({ t: 'vote', pollId: 'p1', option: 0 });
    expect((await a.next(isError)).message).toContain('already_voted');
    a.close();
    b.close();
    await Promise.all([a.closed, b.closed]);
    await waitFor(() => t.app.ctx.hub.online('demo-rt') === 0);
  });

  it('leaving cleans up online count', async () => {
    const before = t.app.ctx.hub.online('demo');
    const c = await connect(t.url, { room: 'demo', token: viewerToken }, { hello: true });
    expect(t.app.ctx.hub.online('demo')).toBe(before + 1);
    c.close();
    await c.closed;
    await waitFor(() => t.app.ctx.hub.online('demo') === before);
  });
});
