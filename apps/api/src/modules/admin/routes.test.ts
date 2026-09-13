import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AdminOverview } from '@livelab/protocol';
import { admin, connect, host, startTestApp, token, viewer } from '../im/testing.js';
import { EMPTY_QOE } from './routes.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
beforeAll(async () => { t = await startTestApp(); });
afterAll(async () => { await t.app.close(); });

const overview = async (tok: string) => t.app.inject({ method: 'GET', url: '/v1/admin/overview', headers: { authorization: `Bearer ${tok}` } });

describe('GET /v1/admin/overview', () => {
  it('requires the admin role', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/v1/admin/overview' })).statusCode).toBe(401);
    expect((await overview(await token(t.app, host))).statusCode).toBe(403);
  });

  it('reports per-room online + msgRate from the hub and an empty QoE summary by default', async () => {
    const c = await connect(t.url, { room: 'demo', token: await token(t.app, viewer) }, { hello: true });
    await t.app.ctx.hub.broadcast('demo', { t: 'chat', lane: 'chat', room: 'demo', id: 'm1', user: viewer, text: 'x' });
    const res = await overview(await token(t.app, admin));
    expect(res.statusCode).toBe(200);
    const body = res.json<AdminOverview>();
    expect(body.qoe).toEqual(EMPTY_QOE);
    const demo = body.rooms.find((r) => r.id === 'demo')!;
    expect(demo.online).toBe(1);
    expect(demo.viewers).toBe(1);
    expect(demo.msgRate).toBeGreaterThan(0);
    expect(body.rooms.find((r) => r.id === 'demo-rt')).toMatchObject({ online: 0, msgRate: 0 });
    c.close();
    await c.closed;
  });

  it('uses ctx.qoeSummary when the telemetry module provides one', async () => {
    t.app.ctx.qoeSummary = async () => ({ ...EMPTY_QOE, ttffP50: 800, sessions: 3, source: 'clickhouse' });
    const body = (await overview(await token(t.app, admin))).json<AdminOverview>();
    expect(body.qoe).toMatchObject({ ttffP50: 800, sessions: 3, source: 'clickhouse' });
    delete t.app.ctx.qoeSummary;
  });
});
