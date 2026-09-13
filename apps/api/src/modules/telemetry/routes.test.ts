import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../server.js';
import type { Row } from './mapper.js';
import { EMPTY_SUMMARY } from './summary.js';

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
let written: Row[][];

const ctx = { sessionId: 'sess_1', player: 'livelab-web', playerVer: '0.1.0', os: 'mac', browser: 'chrome', netType: 'wifi' };

beforeEach(async () => {
  app = await buildApp({ dbPath: ':memory:', logger: false, cfg: { redisUrl: undefined, clickhouseUrl: undefined } });
  written = [];
  app.ctx.telemetry = { write: (rows) => { written.push(rows); }, flush: async () => undefined, close: async () => undefined };
});
afterEach(async () => { await app.close(); });

describe('POST /v1/telemetry', () => {
  it('validates the batch, maps rows and answers 202', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/telemetry',
      payload: { ctx, events: [{ name: 'video.first_frame', ts: Date.now(), viewId: 'v1', roomId: 'demo', attrs: { ttffMs: 812 } }, { name: 'video.heartbeat', ts: Date.now(), viewId: 'v1', attrs: { playingMs: 10000 } }] },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 2 });
    expect(written).toHaveLength(1);
    expect(written[0]!.map((r) => [r.event, r.value_ms, r.room_id])).toEqual([['first_frame', 812, 'demo'], ['heartbeat', 10000, '']]);
    expect(written[0]![0]!.region).toBe('local'); // schema default
  });

  it('accepts text/plain JSON (sendBeacon) and rejects malformed batches', async () => {
    const beacon = await app.inject({
      method: 'POST', url: '/v1/telemetry', headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify({ ctx, events: [{ name: 'web.vital', ts: Date.now(), attrs: { name: 'LCP', value: 900 } }] }),
    });
    expect(beacon.statusCode).toBe(202);
    expect(written[0]![0]).toMatchObject({ event: 'web_vital', value_ms: 900 });

    const bad = await app.inject({ method: 'POST', url: '/v1/telemetry', payload: { ctx, events: [] } });
    expect(bad.statusCode).toBe(400);
    const tooBig = await app.inject({ method: 'POST', url: '/v1/telemetry', payload: { ctx, events: [{ name: 'x', ts: 1, attrs: { blob: 'y'.repeat(70 * 1024) } }] } });
    expect(tooBig.statusCode).toBe(413);
    expect(written).toHaveLength(1);
  });
});

describe('GET /v1/telemetry/summary', () => {
  it('returns the empty summary without ClickHouse', async () => {
    expect(app.ctx.qoeSummary).toBeUndefined();
    const res = await app.inject({ method: 'GET', url: '/v1/telemetry/summary' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(EMPTY_SUMMARY);
  });

  it('delegates to ctx.qoeSummary and degrades to empty on failure', async () => {
    const full = { ...EMPTY_SUMMARY, ttffP50: 800, sessions: 3, source: 'clickhouse' as const };
    app.ctx.qoeSummary = vi.fn(async () => full);
    expect((await app.inject({ method: 'GET', url: '/v1/telemetry/summary' })).json()).toEqual(full);
    app.ctx.qoeSummary = vi.fn(async () => { throw new Error('down'); });
    expect((await app.inject({ method: 'GET', url: '/v1/telemetry/summary' })).json()).toEqual(EMPTY_SUMMARY);
  });
});
