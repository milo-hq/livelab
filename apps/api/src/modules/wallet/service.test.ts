import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../db.js';
import { ORDER_TTL_MS, WalletService, signWebhook } from './service.js';

const SECRET = 'test-webhook-secret';
let db: Db;
let now: number;
let svc: WalletService;

const sign = (eventId: string, orderId: string, status: string) => signWebhook(SECRET, eventId, orderId, status);
const ledgerSum = (txId?: string) =>
  (db.prepare(txId ? 'SELECT COALESCE(SUM(delta),0) AS s FROM ledger_entries WHERE tx_id = ?' : 'SELECT COALESCE(SUM(delta),0) AS s FROM ledger_entries')
    .get(...(txId ? [txId] : [])) as { s: number }).s;
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

beforeEach(() => {
  db = openDb(':memory:');
  now = 1_700_000_000_000;
  svc = new WalletService(db, { webhookSecret: SECRET }, () => now);
});

describe('wallet basics', () => {
  it('get() creates an empty wallet on first access', () => {
    expect(svc.get('u1')).toEqual({ userId: 'u1', balance: 0 });
    expect(count('wallets')).toBe(1);
    expect(svc.get('u1').balance).toBe(0);
    expect(count('wallets')).toBe(1);
  });

  it('createRecharge prices coins at 10 cents and starts in created', () => {
    const o = svc.createRecharge('u1', 100);
    expect(o.id).toMatch(/^ord_/);
    expect(o).toMatchObject({ userId: 'u1', coins: 100, priceCents: 1000, status: 'created', createdAt: now, paidAt: null });
    expect(svc.getOrder(o.id)).toEqual(o);
    expect(svc.getOrder('nope')).toBeNull();
  });

  it('orders expire lazily 15 minutes after creation', () => {
    const o = svc.createRecharge('u1', 100);
    now += ORDER_TTL_MS - 1;
    expect(svc.getOrder(o.id)!.status).toBe('created');
    now += 1;
    expect(svc.getOrder(o.id)!.status).toBe('expired');
    // A late webhook for an expired order is recorded but does not credit.
    const r = svc.applyPaymentEvent({ eventId: 'evt_late', orderId: o.id, status: 'paid', signature: sign('evt_late', o.id, 'paid') });
    expect(r).toBe('applied');
    expect(svc.getOrder(o.id)!.status).toBe('expired');
    expect(svc.get('u1').balance).toBe(0);
  });
});

describe('applyPaymentEvent', () => {
  it('credits the wallet once and writes a balanced ledger pair', () => {
    const o = svc.createRecharge('u1', 100);
    now += 5000;
    const r = svc.applyPaymentEvent({ eventId: 'evt_1', orderId: o.id, status: 'paid', signature: sign('evt_1', o.id, 'paid') });
    expect(r).toBe('applied');
    expect(svc.get('u1').balance).toBe(100);
    expect(svc.getOrder(o.id)).toMatchObject({ status: 'paid', paidAt: now });
    const rows = db.prepare('SELECT tx_id, account, delta, ref FROM ledger_entries ORDER BY id').all() as Array<{ tx_id: string; account: string; delta: number; ref: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.tx_id).toBe(rows[1]!.tx_id);
    expect(rows.map((x) => [x.account, x.delta, x.ref])).toEqual([['platform_cash', -100, o.id], ['user_wallet:u1', 100, o.id]]);
    expect(ledgerSum()).toBe(0);
  });

  it('duplicate event id is a no-op', () => {
    const o = svc.createRecharge('u1', 50);
    const ev = { eventId: 'evt_dup', orderId: o.id, status: 'paid' as const, signature: sign('evt_dup', o.id, 'paid') };
    expect(svc.applyPaymentEvent(ev)).toBe('applied');
    expect(svc.applyPaymentEvent(ev)).toBe('duplicate');
    expect(svc.applyPaymentEvent(ev)).toBe('duplicate');
    expect(svc.get('u1').balance).toBe(50);
    expect(count('payment_events')).toBe(1);
    expect(count('ledger_entries')).toBe(2);
  });

  it('a second distinct event for an already paid order does not credit twice', () => {
    const o = svc.createRecharge('u1', 50);
    expect(svc.applyPaymentEvent({ eventId: 'e1', orderId: o.id, status: 'paid', signature: sign('e1', o.id, 'paid') })).toBe('applied');
    expect(svc.applyPaymentEvent({ eventId: 'e2', orderId: o.id, status: 'paid', signature: sign('e2', o.id, 'paid') })).toBe('applied');
    expect(svc.get('u1').balance).toBe(50);
    expect(count('payment_events')).toBe(2);
    expect(count('ledger_entries')).toBe(2);
  });

  it('rejects a bad signature without recording the event', () => {
    const o = svc.createRecharge('u1', 50);
    expect(svc.applyPaymentEvent({ eventId: 'e1', orderId: o.id, status: 'paid', signature: 'deadbeef' })).toBe('invalid');
    // Signature over a different status must not be replayable as `paid`.
    expect(svc.applyPaymentEvent({ eventId: 'e1', orderId: o.id, status: 'paid', signature: sign('e1', o.id, 'failed') })).toBe('invalid');
    expect(count('payment_events')).toBe(0);
    expect(svc.get('u1').balance).toBe(0);
    expect(svc.getOrder(o.id)!.status).toBe('created');
  });

  it('failed outcome closes the order without credit', () => {
    const o = svc.createRecharge('u1', 50);
    expect(svc.applyPaymentEvent({ eventId: 'e1', orderId: o.id, status: 'failed', signature: sign('e1', o.id, 'failed') })).toBe('applied');
    expect(svc.getOrder(o.id)).toMatchObject({ status: 'failed', paidAt: null });
    expect(svc.get('u1').balance).toBe(0);
    expect(count('ledger_entries')).toBe(0);
    // A later `paid` for the same order is ignored: the state machine only leaves `created` once.
    expect(svc.applyPaymentEvent({ eventId: 'e2', orderId: o.id, status: 'paid', signature: sign('e2', o.id, 'paid') })).toBe('applied');
    expect(svc.getOrder(o.id)!.status).toBe('failed');
    expect(svc.get('u1').balance).toBe(0);
  });
});

describe('debit', () => {
  const opts = (idemKey: string, msgId = `gift_${idemKey}`) => ({
    ref: msgId, idemKey, creditAccount: 'creator_earnings:host-demo',
    giftOrder: { id: `go_${idemKey}`, roomId: 'demo', giftId: 'rose', count: 1, msgId },
  });

  function fund(userId: string, coins: number) {
    const o = svc.createRecharge(userId, coins);
    svc.applyPaymentEvent({ eventId: `fund_${o.id}`, orderId: o.id, status: 'paid', signature: sign(`fund_${o.id}`, o.id, 'paid') });
  }

  it('debits within a transaction and records ledger + gift order', () => {
    fund('u1', 100);
    const r = svc.debit('u1', 30, opts('k1'));
    expect(r).toEqual({ ok: true, balance: 70 });
    expect(svc.get('u1').balance).toBe(70);
    const rows = db.prepare("SELECT account, delta, ref FROM ledger_entries WHERE ref = 'gift_k1' ORDER BY id").all();
    expect(rows).toEqual([{ account: 'user_wallet:u1', delta: -30, ref: 'gift_k1' }, { account: 'creator_earnings:host-demo', delta: 30, ref: 'gift_k1' }]);
    expect(ledgerSum()).toBe(0);
    expect(db.prepare('SELECT * FROM gift_orders').all()).toMatchObject([{ id: 'go_k1', user_id: 'u1', room_id: 'demo', gift_id: 'rose', count: 1, amount: 30, idem_key: 'k1', msg_id: 'gift_k1' }]);
  });

  it('same idempotency key returns duplicate with the original msgId and no second charge', () => {
    fund('u1', 100);
    expect(svc.debit('u1', 30, opts('k1'))).toEqual({ ok: true, balance: 70 });
    const again = svc.debit('u1', 30, opts('k1', 'gift_other'));
    expect(again).toEqual({ ok: false, reason: 'duplicate', existing: { msgId: 'gift_k1', balance: 70 } });
    expect(svc.get('u1').balance).toBe(70);
    expect(count('gift_orders')).toBe(1);
    expect(count('ledger_entries')).toBe(4); // 2 for funding + 2 for the single debit
    // Same key from another user is a different scope.
    fund('u2', 10);
    const u2 = opts('k1', 'gift_u2');
    expect(svc.debit('u2', 5, { ...u2, giftOrder: { ...u2.giftOrder, id: 'go_u2_k1' } })).toEqual({ ok: true, balance: 5 });
  });

  it('cannot go below zero: sequential debits stop at insufficient without partial writes', () => {
    fund('u1', 50);
    expect(svc.debit('u1', 30, opts('a'))).toEqual({ ok: true, balance: 20 });
    expect(svc.debit('u1', 30, opts('b'))).toEqual({ ok: false, reason: 'insufficient' });
    expect(svc.get('u1').balance).toBe(20);
    expect(count('gift_orders')).toBe(1);
    expect(count('ledger_entries')).toBe(4);
    expect(svc.debit('u1', 20, opts('c'))).toEqual({ ok: true, balance: 0 });
    expect(svc.debit('u1', 1, opts('d'))).toEqual({ ok: false, reason: 'insufficient' });
  });

  it('an unknown user has an implicit empty wallet', () => {
    expect(svc.debit('ghost', 1, opts('x'))).toEqual({ ok: false, reason: 'insufficient' });
    expect(count('gift_orders')).toBe(0);
  });
});
