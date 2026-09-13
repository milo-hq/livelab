import type { FastifyInstance } from 'fastify';
import { RechargeRequest, type Order, type Wallet } from '@livelab/protocol';
import { HttpError, parse } from '../../lib/http-error.js';
import type { AppContext } from '../../context.js';

export async function walletRoutes(app: FastifyInstance, ctx: AppContext) {
  const { wallet } = ctx;

  app.get('/v1/wallet', { preHandler: app.authenticate }, async (req): Promise<Wallet> => wallet.get(req.user!.id));

  app.post('/v1/wallet/recharge', { preHandler: app.authenticate }, async (req) => {
    const body = parse(RechargeRequest, req.body);
    const order = wallet.createRecharge(req.user!.id, body.coins);
    return { order, payUrl: `/pay/mock/${order.id}` };
  });

  app.get<{ Params: { id: string } }>('/v1/wallet/orders/:id', { preHandler: app.authenticate }, async (req): Promise<Order> => {
    const order = wallet.getOrder(req.params.id);
    // Owner only; a foreign order is indistinguishable from a missing one.
    if (!order || order.userId !== req.user!.id) throw new HttpError(404, 'not_found', 'order not found');
    return order;
  });
}
