import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../server.js';
import { signWebhook } from '../wallet/service.js';
import { scheduleDelivery } from './deliver.js';

vi.mock('./deliver.js', () => ({ scheduleDelivery: vi.fn(async () => ({ duplicated: false, deliveries: [{ status: 200, body: '{"result":"applied"}' }] })) }));

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;

beforeEach(async () => {
  vi.mocked(scheduleDelivery).mockClear();
  app = await buildApp({ dbPath: ':memory:', logger: false, cfg: { redisUrl: undefined, clickhouseUrl: undefined, apiPublicUrl: 'http://api.test:1234' } });
});
afterEach(async () => { await app.close(); });

describe('mock cashier', () => {
  it('GET /v1/pay/mock/:orderId is public and returns the order', async () => {
    const order = app.ctx.wallet.createRecharge('u1', 100);
    const res = await app.inject({ method: 'GET', url: `/v1/pay/mock/${order.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(order);
    expect((await app.inject({ method: 'GET', url: '/v1/pay/mock/ord_missing' })).statusCode).toBe(404);
  });

  it('POST /complete schedules a signed webhook delivery to the public api url', async () => {
    const order = app.ctx.wallet.createRecharge('u1', 100);
    const res = await app.inject({ method: 'POST', url: `/v1/pay/mock/${order.id}/complete`, payload: { outcome: 'paid' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: true });
    expect(scheduleDelivery).toHaveBeenCalledTimes(1);
    const [ev, opts] = vi.mocked(scheduleDelivery).mock.calls[0]!;
    expect(ev).toMatchObject({ orderId: order.id, status: 'paid' });
    expect(ev.eventId).toMatch(/^evt_/);
    expect(opts).toMatchObject({ webhookUrl: 'http://api.test:1234/v1/pay/webhook', secret: app.ctx.cfg.webhookSecret });
  });

  it('validates the outcome and rejects unknown or closed orders', async () => {
    const order = app.ctx.wallet.createRecharge('u1', 100);
    expect((await app.inject({ method: 'POST', url: `/v1/pay/mock/${order.id}/complete`, payload: { outcome: 'maybe' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/pay/mock/ord_missing/complete', payload: { outcome: 'paid' } })).statusCode).toBe(404);
    app.ctx.wallet.applyPaymentEvent({ eventId: 'e', orderId: order.id, status: 'failed', signature: signWebhook(app.ctx.cfg.webhookSecret, 'e', order.id, 'failed') });
    const closed = await app.inject({ method: 'POST', url: `/v1/pay/mock/${order.id}/complete`, payload: { outcome: 'paid' } });
    expect(closed.statusCode).toBe(409);
    expect(scheduleDelivery).not.toHaveBeenCalled();
  });
});

describe('POST /v1/pay/webhook', () => {
  it('applies a signed event, reports duplicates, rejects bad signatures', async () => {
    const order = app.ctx.wallet.createRecharge('u1', 100);
    const sig = signWebhook(app.ctx.cfg.webhookSecret, 'evt_x', order.id, 'paid');
    const body = { eventId: 'evt_x', orderId: order.id, status: 'paid', signature: sig };

    const first = await app.inject({ method: 'POST', url: '/v1/pay/webhook', payload: body });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ result: 'applied' });
    expect(app.ctx.wallet.get('u1').balance).toBe(100);

    const dup = await app.inject({ method: 'POST', url: '/v1/pay/webhook', payload: body });
    expect(dup.statusCode).toBe(200);
    expect(dup.json()).toEqual({ result: 'duplicate' });
    expect(app.ctx.wallet.get('u1').balance).toBe(100);

    const bad = await app.inject({ method: 'POST', url: '/v1/pay/webhook', payload: { ...body, eventId: 'evt_y' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ result: 'invalid' });

    const malformed = await app.inject({ method: 'POST', url: '/v1/pay/webhook', payload: { eventId: 'z' } });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: 'bad_request' });
  });
});
