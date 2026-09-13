import { setTimeout as sleep } from 'node:timers/promises';
import { signWebhook } from '../wallet/service.js';

/**
 * Mock payment provider's webhook deliverer. Deliberately misbehaves the way real providers do:
 * random latency, occasional duplicate delivery, and retries on non-2xx — so the receiver's
 * idempotency (`payment_events.event_id`) is exercised in the demo, not just in tests.
 */
export interface DeliveryEvent { eventId: string; orderId: string; status: 'paid' | 'failed' }

export interface DeliveryOpts {
  /** Absolute URL of `POST /v1/pay/webhook`. */
  webhookUrl: string;
  secret: string;
  /** Uniform [0,1) source; injected for deterministic tests. */
  rng?: () => number;
  /** Delay before the first delivery. Default: `rng() * 3000`. */
  delayMs?: number;
  /** Delay between the first and the duplicate delivery. Default: `500 + rng() * 1000`. */
  dupDelayMs?: number;
  /** Probability of delivering twice. Default 0.3. */
  dupProbability?: number;
  /** Extra attempts after a failed one. Default 3. */
  retries?: number;
  /** Spacing between attempts. Default 1000. */
  retrySpacingMs?: number;
  fetchImpl?: typeof fetch;
  log?: { warn(msg: string): void };
}

export interface DeliveryAttempt { status: number; body: string }
export interface DeliveryReport {
  duplicated: boolean;
  /** Final outcome of each delivery (1 or 2 entries); `null` when every attempt failed. */
  deliveries: Array<DeliveryAttempt | null>;
}

/**
 * Resolves when every delivery (including the optional duplicate) has settled. Callers normally
 * fire-and-forget; tests await it.
 */
export async function scheduleDelivery(ev: DeliveryEvent, opts: DeliveryOpts): Promise<DeliveryReport> {
  const rng = opts.rng ?? Math.random;
  const delayMs = opts.delayMs ?? Math.floor(rng() * 3000);
  const duplicated = rng() < (opts.dupProbability ?? 0.3);
  const dupDelayMs = opts.dupDelayMs ?? 500 + Math.floor(rng() * 1000);
  const body = JSON.stringify({ ...ev, signature: signWebhook(opts.secret, ev.eventId, ev.orderId, ev.status) });

  await sleep(delayMs);
  const first = deliverWithRetry(body, opts);
  const second = duplicated ? sleep(dupDelayMs).then(() => deliverWithRetry(body, opts)) : null;
  const deliveries = second ? await Promise.all([first, second]) : [await first];
  return { duplicated, deliveries };
}

async function deliverWithRetry(body: string, opts: DeliveryOpts): Promise<DeliveryAttempt | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const attempts = 1 + (opts.retries ?? 3);
  let last: DeliveryAttempt | null = null;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(opts.retrySpacingMs ?? 1000);
    try {
      const res = await fetchImpl(opts.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      last = { status: res.status, body: await res.text() };
      if (res.ok) return last;
      opts.log?.warn(`pay-mock webhook attempt ${i + 1}/${attempts} got ${res.status}`);
    } catch (e) {
      opts.log?.warn(`pay-mock webhook attempt ${i + 1}/${attempts} failed: ${(e as Error).message}`);
    }
  }
  return last;
}
