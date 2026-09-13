import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserRef } from '@livelab/protocol';
import { buildApp } from '../../server.js';
import { signWebhook } from '../wallet/service.js';

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
const viewer: UserRef = { id: 'u_viewer', name: 'alice', role: 'viewer' };
let token: string;

async function fund(userId: string, coins: number) {
  const order = app.ctx.wallet.createRecharge(userId, coins);
  const r = app.ctx.wallet.applyPaymentEvent({ eventId: `evt_${order.id}`, orderId: order.id, status: 'paid', signature: signWebhook(app.ctx.cfg.webhookSecret, `evt_${order.id}`, order.id, 'paid') });
  expect(r).toBe('applied');
}

const send = async (body: object, key?: string, auth = `Bearer ${token}`) =>
  await app.inject({ method: 'POST', url: '/v1/gifts', headers: { authorization: auth, ...(key ? { 'idempotency-key': key } : {}) }, payload: body });

beforeEach(async () => {
  app = await buildApp({ dbPath: ':memory:', logger: false, cfg: { redisUrl: undefined, clickhouseUrl: undefined } });
  token = await app.signToken(viewer);
});
afterEach(async () => { await app.close(); });

describe('GET /v1/gifts', () => {
  it('lists the catalog with server-side prices', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/gifts' });
    expect(res.statusCode).toBe(200);
    const gifts = res.json() as Array<{ id: string; price: number }>;
    expect(gifts.map((g) => [g.id, g.price])).toEqual([['rose', 1], ['coffee', 10], ['confetti', 50], ['rocket', 500]]);
  });
});

describe('POST /v1/gifts', () => {
  it('requires auth', async () => {
    const res = await send({ roomId: 'demo', giftId: 'rose', count: 1 }, 'k', 'Bearer nope');
    expect(res.statusCode).toBe(401);
  });

  it('400 without Idempotency-Key', async () => {
    await fund(viewer.id, 100);
    const res = await send({ roomId: 'demo', giftId: 'rose', count: 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'bad_request' });
    expect(app.ctx.wallet.get(viewer.id).balance).toBe(100);
  });

  it('404 for unknown room or gift', async () => {
    await fund(viewer.id, 100);
    expect((await send({ roomId: 'nope', giftId: 'rose', count: 1 }, 'k1')).statusCode).toBe(404);
    expect((await send({ roomId: 'demo', giftId: 'diamond', count: 1 }, 'k2')).statusCode).toBe(404);
    expect(app.ctx.wallet.get(viewer.id).balance).toBe(100);
  });

  it('402 when the balance cannot cover price × count', async () => {
    await fund(viewer.id, 20);
    const res = await send({ roomId: 'demo', giftId: 'coffee', count: 3 }, 'k1'); // 30 coins
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ code: 'insufficient' });
    expect(app.ctx.wallet.get(viewer.id).balance).toBe(20);
    // Price is server-side: a client-supplied price is ignored (schema strips it).
    const ok = await send({ roomId: 'demo', giftId: 'coffee', count: 2, price: 0 }, 'k2');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, balance: 0 });
  });

  it('debits, credits the host, broadcasts once, and replays the same msgId for the same key', async () => {
    await fund(viewer.id, 100);
    const broadcast = vi.fn(async () => null);
    app.ctx.broadcast = broadcast;

    const first = await send({ roomId: 'demo', giftId: 'coffee', count: 2 }, 'key-1');
    expect(first.statusCode).toBe(200);
    const body = first.json() as { ok: true; balance: number; msgId: string };
    expect(body).toMatchObject({ ok: true, balance: 80 });
    expect(body.msgId).toMatch(/^gift_/);
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledTimes(1));
    expect(broadcast).toHaveBeenCalledWith('demo', {
      t: 'gift', lane: 'gift', room: 'demo', id: body.msgId, user: viewer,
      gift: { id: 'coffee', name: '咖啡', price: 10, animation: 'hearts', icon: '☕' }, count: 2,
    });
    const credit = app.ctx.db.prepare("SELECT delta FROM ledger_entries WHERE account = 'creator_earnings:host-demo'").all();
    expect(credit).toEqual([{ delta: 20 }]);

    const replay = await send({ roomId: 'demo', giftId: 'coffee', count: 2 }, 'key-1');
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ ok: true, balance: 80, msgId: body.msgId });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(app.ctx.wallet.get(viewer.id).balance).toBe(80);

    // A new key is a new gift.
    const second = await send({ roomId: 'demo', giftId: 'rose', count: 1 }, 'key-2');
    expect(second.json()).toMatchObject({ ok: true, balance: 79 });
    expect((second.json() as { msgId: string }).msgId).not.toBe(body.msgId);
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledTimes(2));
  });

  it('works without a broadcast hook wired (e.g. a REST-only deployment)', async () => {
    await fund(viewer.id, 5);
    app.ctx.broadcast = undefined;
    const res = await send({ roomId: 'demo', giftId: 'rose', count: 5 }, 'k');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, balance: 0 });
  });
});

describe('wallet routes', () => {
  it('GET /v1/wallet creates and returns the wallet', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/wallet', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: viewer.id, balance: 0 });
    expect((await app.inject({ method: 'GET', url: '/v1/wallet' })).statusCode).toBe(401);
  });

  it('POST /v1/wallet/recharge returns an order and a mock pay url; orders are owner-only', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/wallet/recharge', headers: { authorization: `Bearer ${token}` }, payload: { coins: 100 } });
    expect(res.statusCode).toBe(200);
    const { order, payUrl } = res.json() as { order: { id: string; status: string; priceCents: number }; payUrl: string };
    expect(order).toMatchObject({ userId: viewer.id, coins: 100, priceCents: 1000, status: 'created' });
    expect(payUrl).toBe(`/pay/mock/${order.id}`);

    const mine = await app.inject({ method: 'GET', url: `/v1/wallet/orders/${order.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toEqual(order);

    const other = await app.signToken({ id: 'u_other', name: 'bob', role: 'viewer' });
    const theirs = await app.inject({ method: 'GET', url: `/v1/wallet/orders/${order.id}`, headers: { authorization: `Bearer ${other}` } });
    expect(theirs.statusCode).toBe(404);

    const bad = await app.inject({ method: 'POST', url: '/v1/wallet/recharge', headers: { authorization: `Bearer ${token}` }, payload: { coins: 5 } });
    expect(bad.statusCode).toBe(400);
  });
});
