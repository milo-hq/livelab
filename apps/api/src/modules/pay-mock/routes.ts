import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Order } from '@livelab/protocol';
import { HttpError, parse } from '../../lib/http-error.js';
import { newId } from '../../lib/ids.js';
import type { AppContext } from '../../context.js';
import { scheduleDelivery } from './deliver.js';

const CompleteBody = z.object({ outcome: z.enum(['paid', 'failed']) });
const WebhookBody = z.object({ eventId: z.string().min(1), orderId: z.string().min(1), status: z.enum(['paid', 'failed']), signature: z.string().min(1) });

/**
 * Stand-in for a payment provider: a cashier endpoint the web page talks to, and the signed
 * webhook it delivers back to us (asynchronously, with jitter and duplicates — see deliver.ts).
 */
export async function payMockRoutes(app: FastifyInstance, ctx: AppContext) {
  const { cfg, wallet } = ctx;

  // Public: the cashier page shows the order to whoever holds the link, like a real hosted checkout.
  app.get<{ Params: { orderId: string } }>('/v1/pay/mock/:orderId', async (req): Promise<Order> => {
    const order = wallet.getOrder(req.params.orderId);
    if (!order) throw new HttpError(404, 'not_found', 'order not found');
    return order;
  });

  app.post<{ Params: { orderId: string } }>('/v1/pay/mock/:orderId/complete', async (req) => {
    const body = parse(CompleteBody, req.body);
    const order = wallet.getOrder(req.params.orderId);
    if (!order) throw new HttpError(404, 'not_found', 'order not found');
    if (order.status !== 'created') throw new HttpError(409, 'order_closed', `order is ${order.status}`);
    const ev = { eventId: newId('evt'), orderId: order.id, status: body.outcome };
    // Fire and forget: the provider acks immediately, the webhook lands later.
    void scheduleDelivery(ev, { webhookUrl: `${cfg.apiPublicUrl}/v1/pay/webhook`, secret: cfg.webhookSecret, log: req.log })
      .then((r) => req.log.info({ orderId: order.id, eventId: ev.eventId, duplicated: r.duplicated, statuses: r.deliveries.map((d) => d?.status ?? null) }, 'pay-mock webhook delivered'));
    return { accepted: true };
  });

  // Public: authenticity comes from the HMAC signature, not from a session.
  app.post('/v1/pay/webhook', async (req, reply) => {
    const ev = parse(WebhookBody, req.body);
    const result = wallet.applyPaymentEvent(ev);
    if (result === 'invalid') return reply.status(400).send({ result });
    return { result };
  });
}
