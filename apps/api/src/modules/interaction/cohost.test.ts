import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../server.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let viewerToken = '';
let hostToken = '';
let viewerId = '';

beforeAll(async () => {
  app = await buildApp({ dbPath: ':memory:', logger: false, cfg: { redisUrl: undefined, clickhouseUrl: undefined, mediamtxWebrtc: 'http://rtc' } });
  const v = await app.inject({ method: 'POST', url: '/v1/auth/demo', payload: { name: 'guest', role: 'viewer' } });
  viewerToken = (v.json() as { token: string }).token;
  viewerId = (v.json() as { user: { id: string } }).user.id;
  const h = await app.inject({ method: 'POST', url: '/v1/auth/demo', payload: { name: 'host', role: 'host' } });
  hostToken = (h.json() as { token: string }).token;
});
afterAll(() => app.close());

const call = (method: 'GET' | 'POST' | 'DELETE', url: string, token: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });

describe('cohost signaling', () => {
  it('request → accept hands out MediaMTX whip/whep urls and publishes room state', async () => {
    const r1 = await call('POST', '/v1/rooms/demo/cohost/request', viewerToken);
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ requests: [{ userId: viewerId, name: 'guest' }], active: [] });

    const denied = await call('POST', '/v1/rooms/demo/cohost/accept', viewerToken, { userId: viewerId });
    expect(denied.statusCode).toBe(403);

    const r2 = await call('POST', '/v1/rooms/demo/cohost/accept', hostToken, { userId: viewerId });
    expect(r2.statusCode).toBe(200);
    const active = (r2.json() as { active: { whip: string; whep: string; path: string }[] }).active[0]!;
    expect(active.path).toBe(`cohost/demo/${viewerId}`);
    expect(active.whip).toBe(`http://rtc/cohost/demo/${viewerId}/whip`);
    expect(active.whep).toBe(`http://rtc/cohost/demo/${viewerId}/whep`);
    expect(app.ctx.hub.state('demo').cohosts).toHaveLength(1);

    // a guest can end only their own session; state is cleared
    const r3 = await call('POST', '/v1/rooms/demo/cohost/end', viewerToken, { userId: 'someone-else' });
    expect(r3.statusCode).toBe(200);
    expect(app.ctx.hub.state('demo').cohosts).toHaveLength(0);
  });

  it('rejects unknown users and unknown rooms', async () => {
    expect((await call('POST', '/v1/rooms/demo/cohost/accept', hostToken, { userId: 'nobody' })).statusCode).toBe(404);
    expect((await call('POST', '/v1/rooms/nope/cohost/request', viewerToken)).statusCode).toBe(404);
  });
});
