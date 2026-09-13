import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModAction, ModState, RoomState } from '@livelab/protocol';
import { admin, batchWith, connect, host, isState, startTestApp, token, viewer } from '../im/testing.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
let hostToken: string;
let viewerToken: string;
let adminToken: string;

beforeAll(async () => {
  t = await startTestApp();
  hostToken = await token(t.app, host);
  viewerToken = await token(t.app, viewer);
  adminToken = await token(t.app, admin);
});
afterAll(async () => { await t.app.close(); });

const mod = (room: string, body: ModAction, tok = hostToken) =>
  t.app.inject({ method: 'POST', url: `/v1/rooms/${room}/mod`, headers: { authorization: `Bearer ${tok}` }, payload: body });

describe('interaction routes', () => {
  it('GET /v1/rooms/:id/state is public; /mod requires host|admin', async () => {
    const st = await t.app.inject({ method: 'GET', url: '/v1/rooms/demo/state' });
    expect(st.statusCode).toBe(200);
    expect(st.json<RoomState>()).toEqual({ online: 0, slowModeSec: 0, pinned: null, announce: null, poll: null, likes: 0 });
    expect((await t.app.inject({ method: 'GET', url: '/v1/rooms/nope/state' })).statusCode).toBe(404);
    expect((await mod('demo', { action: 'unpin' }, viewerToken)).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/v1/rooms/demo/mod' })).statusCode).toBe(401);
    const ms = await t.app.inject({ method: 'GET', url: '/v1/rooms/demo/mod', headers: { authorization: `Bearer ${adminToken}` } });
    expect(ms.json<ModState>()).toEqual({ muted: [], banned: [], keywords: [], slowModeSec: 0 });
  });

  it('pin sets state.pinned, pushes a state frame and broadcasts system{pin}; unpin clears it', async () => {
    const c = await connect(t.url, { room: 'demo', token: viewerToken }, { hello: true });
    const msg = await t.app.ctx.hub.broadcast('demo', { t: 'chat', lane: 'chat', room: 'demo', id: 'm_pin', user: viewer, text: 'pin me' });
    const res = await mod('demo', { action: 'pin', msgId: 'm_pin' });
    expect(res.statusCode).toBe(200);
    expect(res.json().state.pinned).toEqual(msg);
    const st = await c.next(isState);
    expect(st.state.pinned).toEqual(msg);
    const b = await c.next(batchWith((m) => m.t === 'system' && m.kind === 'pin'));
    expect(b.msgs.find((m) => m.t === 'system' && m.kind === 'pin')).toMatchObject({ payload: { msgId: 'm_pin', by: host.id } });
    expect((await t.app.inject({ method: 'GET', url: '/v1/rooms/demo/state' })).json<RoomState>().pinned).toEqual(msg);
    expect((await mod('demo', { action: 'pin', msgId: 'missing' })).statusCode).toBe(404);
    expect((await mod('demo', { action: 'pin' })).statusCode).toBe(400);

    await mod('demo', { action: 'unpin' });
    await c.next((f) => isState(f) && f.state.pinned === null);
    await c.next(batchWith((m) => m.t === 'system' && m.kind === 'unpin'));
    c.close();
    await c.closed;
  });

  it('slow_mode / announce update moderation + state and broadcast system messages', async () => {
    const c = await connect(t.url, { room: 'demo', token: viewerToken }, { hello: true });
    expect((await mod('demo', { action: 'slow_mode', seconds: 10 })).json().state.slowModeSec).toBe(10);
    expect(t.app.ctx.moderation.slowModeSec('demo')).toBe(10);
    await c.next((f) => isState(f) && f.state.slowModeSec === 10);
    const b = await c.next(batchWith((m) => m.t === 'system' && m.kind === 'slow_mode'));
    expect(b.msgs.find((m) => m.t === 'system' && m.kind === 'slow_mode')).toMatchObject({ payload: { seconds: 10 } });
    await mod('demo', { action: 'slow_mode', seconds: 0 });

    await mod('demo', { action: 'announce', text: 'Welcome!' });
    await c.next((f) => isState(f) && f.state.announce === 'Welcome!');
    await c.next(batchWith((m) => m.t === 'system' && m.kind === 'announce'));
    await mod('demo', { action: 'announce', text: '' });
    expect(t.app.ctx.hub.state('demo').announce).toBeNull();
    c.close();
    await c.closed;
  });

  it('mute/ban/unmute/keywords change ModState and broadcast system{mod}', async () => {
    const c = await connect(t.url, { room: 'demo', token: viewerToken }, { hello: true });
    expect((await mod('demo', { action: 'mute' })).statusCode).toBe(400);
    await mod('demo', { action: 'mute', targetUserId: 'u_x', seconds: 60 });
    const b = await c.next(batchWith((m) => m.t === 'system' && m.kind === 'mod'));
    expect(b.msgs.find((m) => m.t === 'system' && m.kind === 'mod')).toMatchObject({ payload: { action: 'mute', targetUserId: 'u_x' } });
    expect(t.app.ctx.moderation.isMuted('demo', 'u_x')).toBe(true);
    await mod('demo', { action: 'ban', targetUserId: 'u_y' });
    await mod('demo', { action: 'keyword_add', text: 'Foo' });
    const ms = (await t.app.inject({ method: 'GET', url: '/v1/rooms/demo/mod', headers: { authorization: `Bearer ${hostToken}` } })).json<ModState>();
    expect(ms.banned).toEqual(['u_y']);
    expect(ms.keywords).toEqual(['foo']);
    expect(ms.muted.map((m) => m.userId)).toEqual(['u_x']);
    await mod('demo', { action: 'unmute', targetUserId: 'u_x' });
    await mod('demo', { action: 'unmute', targetUserId: 'u_y' });
    await mod('demo', { action: 'keyword_remove', text: 'foo' });
    expect(t.app.ctx.moderation.state('demo')).toEqual({ muted: [], banned: [], keywords: [], slowModeSec: 0 });
    c.close();
    await c.closed;
  });

  it('poll_start creates a poll that auto-ends; poll_end ends early with system{poll_end}', async () => {
    const c = await connect(t.url, { room: 'demo-rt', token: viewerToken }, { hello: true });
    expect((await mod('demo-rt', { action: 'poll_start', question: 'q' })).statusCode).toBe(400);
    const before = Date.now();
    const res = await mod('demo-rt', { action: 'poll_start', question: 'Best protocol?', options: ['LL-HLS', 'WHEP'], seconds: 1 });
    expect(res.statusCode).toBe(200);
    const poll = res.json().state.poll;
    expect(poll).toMatchObject({ question: 'Best protocol?', options: ['LL-HLS', 'WHEP'], votes: [0, 0] });
    expect(poll.endsAt).toBeGreaterThanOrEqual(before + 1000);
    await c.next((f) => isState(f) && f.state.poll?.id === poll.id);
    await c.next(batchWith((m) => m.t === 'system' && m.kind === 'poll'));
    // auto end after 1s
    const end = await c.next(batchWith((m) => m.t === 'system' && m.kind === 'poll_end'), 3000);
    expect(end.msgs.find((m) => m.t === 'system' && m.kind === 'poll_end')).toMatchObject({ payload: { poll: { id: poll.id } } });
    expect(t.app.ctx.hub.state('demo-rt').poll).toBeNull();
    expect((await mod('demo-rt', { action: 'poll_end' })).statusCode).toBe(404);

    // manual end, default 60s duration
    const res2 = await mod('demo-rt', { action: 'poll_start', question: 'again?', options: ['a', 'b', 'c'] });
    expect(res2.json().state.poll.endsAt).toBeGreaterThanOrEqual(Date.now() + 59_000);
    const res3 = await mod('demo-rt', { action: 'poll_end' });
    expect(res3.json().state.poll).toBeNull();
    await c.next(batchWith((m) => m.t === 'system' && m.kind === 'poll_end' && (m.payload['poll'] as { question: string }).question === 'again?'));
    c.close();
    await c.closed;
  });
});
