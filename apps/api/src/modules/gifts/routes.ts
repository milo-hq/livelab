import type { FastifyInstance } from 'fastify';
import { SendGiftRequest, type GiftMsg, type SendGiftResponse } from '@livelab/protocol';
import { HttpError, parse } from '../../lib/http-error.js';
import { newId } from '../../lib/ids.js';
import type { AppContext } from '../../context.js';
import { GIFTS, giftById } from './catalog.js';

export async function giftRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/v1/gifts', async () => GIFTS);

  app.post('/v1/gifts', { preHandler: app.authenticate }, async (req): Promise<SendGiftResponse> => {
    const idemKey = req.headers['idempotency-key'];
    if (typeof idemKey !== 'string' || idemKey.trim() === '' || idemKey.length > 128) {
      throw new HttpError(400, 'bad_request', 'Idempotency-Key header is required');
    }
    const body = parse(SendGiftRequest, req.body);
    const user = req.user!;
    const room = ctx.rooms.get(body.roomId);
    if (!room) throw new HttpError(404, 'not_found', 'room not found');
    const gift = giftById(body.giftId);
    if (!gift) throw new HttpError(404, 'not_found', 'gift not found');

    // Price is always computed here; the client only names the gift and the count.
    const amount = gift.price * body.count;
    const msgId = newId('gift');
    const res = ctx.wallet.debit(user.id, amount, {
      ref: msgId, idemKey, creditAccount: `creator_earnings:${room.hostId}`,
      giftOrder: { id: newId('go'), roomId: room.id, giftId: gift.id, count: body.count, msgId },
    });
    if (!res.ok) {
      if (res.reason === 'insufficient') throw new HttpError(402, 'insufficient', `need ${amount} coins`);
      // Replay of an already processed key: same msgId, no second debit, no second broadcast.
      return { ok: true, balance: res.existing.balance, msgId: res.existing.msgId };
    }

    const msg: Omit<GiftMsg, 'seq' | 'ts'> = {
      t: 'gift', lane: 'gift', room: room.id, id: msgId, user,
      gift: { id: gift.id, name: gift.name, price: gift.price, animation: gift.animation, icon: gift.icon },
      count: body.count,
    };
    // Fire and forget: the debit is already committed; a lost broadcast is a UX blip, not a money bug.
    void ctx.broadcast?.(room.id, msg)?.catch((e: unknown) => req.log.warn({ err: e, msgId }, 'gift broadcast failed'));
    return { ok: true, balance: res.balance, msgId };
  });
}
