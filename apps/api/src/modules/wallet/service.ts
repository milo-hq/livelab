import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Order, Wallet } from '@livelab/protocol';
import { transaction, type Db } from '../../db.js';
import { newId } from '../../lib/ids.js';

/** 1 coin = 10 cents. */
export const CENTS_PER_COIN = 10;
/** A `created` order that is not paid within this window flips to `expired` on next read. */
export const ORDER_TTL_MS = 15 * 60 * 1000;

interface OrderRow { id: string; user_id: string; coins: number; price_cents: number; status: Order['status']; created_at: number; paid_at: number | null }

export interface PaymentEvent { eventId: string; orderId: string; status: 'paid' | 'failed'; signature: string }
export type ApplyResult = 'applied' | 'duplicate' | 'invalid';

export interface DebitOpts {
  /** Free-form reference written to the ledger rows (e.g. the gift msg id). */
  ref: string;
  /** Client supplied idempotency key, unique per user. */
  idemKey: string;
  /** Ledger account that receives the coins, e.g. `creator_earnings:<hostId>`. */
  creditAccount: string;
  giftOrder: { id: string; roomId: string; giftId: string; count: number; msgId: string };
}
export type DebitResult =
  | { ok: true; balance: number }
  | { ok: false; reason: 'insufficient' }
  | { ok: false; reason: 'duplicate'; existing: { msgId: string; balance: number } };

/** HMAC-SHA256 hex over `${eventId}.${orderId}.${status}`; shared by the mock provider and the webhook receiver. */
export function signWebhook(secret: string, eventId: string, orderId: string, status: string): string {
  return createHmac('sha256', secret).update(`${eventId}.${orderId}.${status}`).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export class WalletService {
  constructor(private db: Db, private cfg: { webhookSecret: string }, private now: () => number = Date.now) {}

  /** Returns the wallet, creating an empty row on first access. */
  get(userId: string): Wallet {
    this.db.prepare('INSERT OR IGNORE INTO wallets (user_id, balance) VALUES (?, 0)').run(userId);
    const row = this.db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(userId) as { balance: number };
    return { userId, balance: row.balance };
  }

  createRecharge(userId: string, coins: number): Order {
    const order: Order = {
      id: newId('ord'), userId, coins, priceCents: coins * CENTS_PER_COIN,
      status: 'created', createdAt: this.now(), paidAt: null,
    };
    this.db.prepare('INSERT INTO orders (id,user_id,coins,price_cents,status,created_at,paid_at) VALUES (?,?,?,?,?,?,?)')
      .run(order.id, order.userId, order.coins, order.priceCents, order.status, order.createdAt, null);
    return order;
  }

  /** Reads an order; lazily expires a `created` order older than {@link ORDER_TTL_MS}. */
  getOrder(id: string): Order | null {
    const r = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as unknown as OrderRow | undefined;
    if (!r) return null;
    if (r.status === 'created' && this.now() - r.created_at >= ORDER_TTL_MS) {
      this.db.prepare("UPDATE orders SET status = 'expired' WHERE id = ? AND status = 'created'").run(id);
      r.status = 'expired';
    }
    return { id: r.id, userId: r.user_id, coins: r.coins, priceCents: r.price_cents, status: r.status, createdAt: r.created_at, paidAt: r.paid_at };
  }

  /**
   * Applies a provider webhook exactly once. The `payment_events` primary key is the idempotency
   * guard, so a redelivered event (same `eventId`) is a no-op even if it arrives concurrently.
   */
  applyPaymentEvent(ev: PaymentEvent): ApplyResult {
    if (!safeEqual(ev.signature, signWebhook(this.cfg.webhookSecret, ev.eventId, ev.orderId, ev.status))) return 'invalid';
    return transaction(this.db, () => {
      const seen = this.db.prepare('SELECT 1 FROM payment_events WHERE event_id = ?').get(ev.eventId);
      if (seen) return 'duplicate';
      const now = this.now();
      this.db.prepare('INSERT INTO payment_events (event_id, order_id, status, received_at) VALUES (?,?,?,?)').run(ev.eventId, ev.orderId, ev.status, now);
      const order = this.getOrder(ev.orderId);
      if (!order || order.status !== 'created') return 'applied';
      if (ev.status === 'failed') {
        this.db.prepare("UPDATE orders SET status = 'failed' WHERE id = ?").run(order.id);
        return 'applied';
      }
      this.db.prepare("UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ?").run(now, order.id);
      this.db.prepare('INSERT INTO wallets (user_id, balance) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET balance = balance + excluded.balance').run(order.userId, order.coins);
      this.writeLedger(newId('tx'), [['platform_cash', -order.coins], [`user_wallet:${order.userId}`, order.coins]], order.id, now);
      return 'applied';
    });
  }

  /**
   * Atomically moves `amount` coins from the user's wallet to `creditAccount` and records the gift
   * order. `UPDATE ... WHERE balance >= ?` is the overdraft guard: it either wins or changes 0 rows.
   */
  debit(userId: string, amount: number, opts: DebitOpts): DebitResult {
    if (!Number.isInteger(amount) || amount <= 0) throw new Error('amount must be a positive integer');
    return transaction(this.db, (): DebitResult => {
      const prior = this.db.prepare('SELECT msg_id FROM gift_orders WHERE user_id = ? AND idem_key = ?').get(userId, opts.idemKey) as { msg_id: string } | undefined;
      if (prior) return { ok: false, reason: 'duplicate', existing: { msgId: prior.msg_id, balance: this.get(userId).balance } };
      this.db.prepare('INSERT OR IGNORE INTO wallets (user_id, balance) VALUES (?, 0)').run(userId);
      const res = this.db.prepare('UPDATE wallets SET balance = balance - ? WHERE user_id = ? AND balance >= ?').run(amount, userId, amount);
      if (res.changes === 0) return { ok: false, reason: 'insufficient' };
      const now = this.now();
      this.writeLedger(newId('tx'), [[`user_wallet:${userId}`, -amount], [opts.creditAccount, amount]], opts.ref, now);
      const g = opts.giftOrder;
      this.db.prepare('INSERT INTO gift_orders (id,user_id,room_id,gift_id,count,amount,idem_key,msg_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(g.id, userId, g.roomId, g.giftId, g.count, amount, opts.idemKey, g.msgId, now);
      return { ok: true, balance: this.get(userId).balance };
    });
  }

  /** Double-entry: every movement is a set of rows sharing `tx_id` whose deltas sum to zero. */
  private writeLedger(txId: string, entries: Array<[account: string, delta: number]>, ref: string, now: number) {
    const sum = entries.reduce((a, [, d]) => a + d, 0);
    if (sum !== 0) throw new Error(`unbalanced ledger tx ${txId}: ${sum}`);
    const ins = this.db.prepare('INSERT INTO ledger_entries (tx_id, account, delta, ref, created_at) VALUES (?,?,?,?,?)');
    for (const [account, delta] of entries) ins.run(txId, account, delta, ref, now);
  }
}
