import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../server.js';
import { scheduleDelivery } from './deliver.js';

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
const WEBHOOK = 'http://api.test/v1/pay/webhook';

/** Routes the deliverer's fetch into the in-process app so the whole loop runs without a socket. */
function injectingFetch(): typeof fetch {
  return (async (url, init) => {
    expect(String(url)).toBe(WEBHOOK);
    const res = await app.inject({ method: 'POST', url: '/v1/pay/webhook', headers: init?.headers as Record<string, string>, payload: init?.body as string });
    return new Response(res.body, { status: res.statusCode, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

beforeEach(async () => {
  app = await buildApp({ dbPath: ':memory:', logger: false, cfg: { redisUrl: undefined, clickhouseUrl: undefined } });
});
afterEach(async () => { await app.close(); });

describe('scheduleDelivery', () => {
  it('a duplicate delivery is acknowledged as duplicate and the wallet is credited once', async () => {
    const order = app.ctx.wallet.createRecharge('u1', 100);
    const fetchImpl = vi.fn(injectingFetch());
    const report = await scheduleDelivery(
      { eventId: 'evt_1', orderId: order.id, status: 'paid' },
      { webhookUrl: WEBHOOK, secret: app.ctx.cfg.webhookSecret, fetchImpl, rng: () => 0.1, delayMs: 0, dupDelayMs: 0 },
    );
    expect(report.duplicated).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(report.deliveries.map((d) => d?.status)).toEqual([200, 200]);
    expect(report.deliveries.map((d) => JSON.parse(d!.body).result).sort()).toEqual(['applied', 'duplicate']);
    expect(app.ctx.wallet.get('u1').balance).toBe(100);
    expect(app.ctx.wallet.getOrder(order.id)!.status).toBe('paid');
  });

  it('delivers once when the rng says no duplicate; failed outcome closes the order', async () => {
    const order = app.ctx.wallet.createRecharge('u1', 100);
    const fetchImpl = vi.fn(injectingFetch());
    const report = await scheduleDelivery(
      { eventId: 'evt_2', orderId: order.id, status: 'failed' },
      { webhookUrl: WEBHOOK, secret: app.ctx.cfg.webhookSecret, fetchImpl, rng: () => 0.9, delayMs: 0 },
    );
    expect(report.duplicated).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(app.ctx.wallet.getOrder(order.id)!.status).toBe('failed');
    expect(app.ctx.wallet.get('u1').balance).toBe(0);
  });

  it('signs with the shared secret; a wrong secret is rejected with 400 and retried, then given up', async () => {
    const order = app.ctx.wallet.createRecharge('u1', 100);
    const fetchImpl = vi.fn(injectingFetch());
    const log = { warn: vi.fn() };
    const report = await scheduleDelivery(
      { eventId: 'evt_3', orderId: order.id, status: 'paid' },
      { webhookUrl: WEBHOOK, secret: 'wrong', fetchImpl, rng: () => 0.9, delayMs: 0, retries: 2, retrySpacingMs: 0, log },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(report.deliveries[0]?.status).toBe(400);
    expect(log.warn).toHaveBeenCalledTimes(3);
    expect(app.ctx.wallet.get('u1').balance).toBe(0);
    expect(app.ctx.wallet.getOrder(order.id)!.status).toBe('created');
  });

  it('retries after network errors and 5xx with the configured spacing', async () => {
    const order = app.ctx.wallet.createRecharge('u1', 100);
    const real = injectingFetch();
    let calls = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls++;
      if (calls === 1) throw new Error('ECONNREFUSED');
      if (calls === 2) return new Response('boom', { status: 503 });
      return real(url, init);
    }) as unknown as typeof fetch;
    const t0 = performance.now();
    const report = await scheduleDelivery(
      { eventId: 'evt_4', orderId: order.id, status: 'paid' },
      { webhookUrl: WEBHOOK, secret: app.ctx.cfg.webhookSecret, fetchImpl, rng: () => 0.9, delayMs: 0, retrySpacingMs: 20 },
    );
    expect(performance.now() - t0).toBeGreaterThanOrEqual(35);
    expect(calls).toBe(3);
    expect(report.deliveries[0]?.status).toBe(200);
    expect(app.ctx.wallet.get('u1').balance).toBe(100);
  });

  it('honours the initial delay', async () => {
    const order = app.ctx.wallet.createRecharge('u1', 10);
    const t0 = performance.now();
    await scheduleDelivery(
      { eventId: 'evt_5', orderId: order.id, status: 'paid' },
      { webhookUrl: WEBHOOK, secret: app.ctx.cfg.webhookSecret, fetchImpl: injectingFetch(), rng: () => 0.9, delayMs: 60 },
    );
    expect(performance.now() - t0).toBeGreaterThanOrEqual(55);
    expect(app.ctx.wallet.get('u1').balance).toBe(10);
  });
});
