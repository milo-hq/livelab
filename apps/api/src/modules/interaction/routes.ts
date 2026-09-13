import type { FastifyInstance } from 'fastify';
import { ModAction, type ModState, type Poll, type RoomState } from '@livelab/protocol';
import { HttpError, parse } from '../../lib/http-error.js';
import { newId } from '../../lib/ids.js';
import type { AppContext } from '../../context.js';

const DEFAULT_POLL_SEC = 60;

/**
 * Host/admin moderation and interaction controls. Every action mutates durable moderation state
 * and/or the hub's room state, then tells the room about it: a `system` message (sequenced, in
 * history — a late joiner sees "slow mode enabled" in the log) plus, where the snapshot changed,
 * a `state` frame pushed by `hub.setState` (unsequenced — a late joiner gets it in `welcome`).
 */
export async function interactionRoutes(app: FastifyInstance, ctx: AppContext) {
  const { hub, moderation } = ctx;
  const pollTimers = new Map<string, NodeJS.Timeout>();
  app.addHook('onClose', async () => { for (const t of pollTimers.values()) clearTimeout(t); pollTimers.clear(); });

  const requireRoom = (id: string) => {
    if (!ctx.rooms.get(id)) throw new HttpError(404, 'not_found', 'room not found');
  };
  const system = (room: string, kind: 'mod' | 'pin' | 'unpin' | 'slow_mode' | 'announce' | 'poll' | 'poll_end', payload: Record<string, unknown>) =>
    hub.broadcast(room, { t: 'system', lane: 'system', room, kind, payload });

  async function endPoll(room: string): Promise<Poll | null> {
    const t = pollTimers.get(room);
    if (t) clearTimeout(t);
    pollTimers.delete(room);
    const poll = hub.state(room).poll;
    if (!poll) return null;
    hub.setState(room, { poll: null });
    await system(room, 'poll_end', { poll });
    return poll;
  }

  app.get<{ Params: { id: string } }>('/v1/rooms/:id/state', async (req): Promise<RoomState> => {
    requireRoom(req.params.id);
    return hub.state(req.params.id);
  });

  app.get<{ Params: { id: string } }>('/v1/rooms/:id/mod', { preHandler: app.requireRole('host', 'admin') }, async (req): Promise<ModState> => {
    requireRoom(req.params.id);
    return moderation.state(req.params.id);
  });

  app.post<{ Params: { id: string } }>('/v1/rooms/:id/mod', { preHandler: app.requireRole('host', 'admin') }, async (req) => {
    const room = req.params.id;
    requireRoom(room);
    const a = parse(ModAction, req.body);
    const needTarget = () => {
      if (!a.targetUserId) throw new HttpError(400, 'bad_request', 'targetUserId required');
      return a.targetUserId;
    };
    const by = req.user!.id;

    switch (a.action) {
      case 'mute': {
        const target = needTarget();
        const until = moderation.mute(room, target, a.seconds);
        await system(room, 'mod', { action: 'mute', targetUserId: target, until, by });
        break;
      }
      case 'unmute': {
        const target = needTarget();
        moderation.unmute(room, target);
        await system(room, 'mod', { action: 'unmute', targetUserId: target, by });
        break;
      }
      case 'ban': {
        const target = needTarget();
        moderation.ban(room, target);
        await system(room, 'mod', { action: 'ban', targetUserId: target, by });
        break;
      }
      case 'pin': {
        if (!a.msgId) throw new HttpError(400, 'bad_request', 'msgId required');
        const recent = await ctx.history.since(room, 0, 500);
        const msg = recent.find((m) => m.t === 'chat' && m.id === a.msgId);
        if (!msg || msg.t !== 'chat') throw new HttpError(404, 'not_found', 'message not in history');
        hub.setState(room, { pinned: msg });
        await system(room, 'pin', { msgId: msg.id, by });
        break;
      }
      case 'unpin':
        hub.setState(room, { pinned: null });
        await system(room, 'unpin', { by });
        break;
      case 'slow_mode': {
        const sec = a.seconds ?? 0;
        moderation.slowMode(room, sec);
        hub.setState(room, { slowModeSec: sec });
        await system(room, 'slow_mode', { seconds: sec, by });
        break;
      }
      case 'announce': {
        const text = (a.text ?? '').trim();
        hub.setState(room, { announce: text || null });
        await system(room, 'announce', { text: text || null, by });
        break;
      }
      case 'poll_start': {
        if (!a.question || !a.options) throw new HttpError(400, 'bad_request', 'question and options required');
        if (hub.state(room).poll) await endPoll(room);
        const seconds = a.seconds && a.seconds > 0 ? a.seconds : DEFAULT_POLL_SEC;
        const poll: Poll = { id: newId('p'), question: a.question, options: a.options, votes: a.options.map(() => 0), endsAt: Date.now() + seconds * 1000 };
        hub.startPoll(room, poll);
        await system(room, 'poll', { poll, by });
        const timer = setTimeout(() => { pollTimers.delete(room); void endPoll(room).catch((e) => app.log.error(e, 'poll auto-end failed')); }, seconds * 1000);
        pollTimers.set(room, timer);
        break;
      }
      case 'poll_end':
        if (!(await endPoll(room))) throw new HttpError(404, 'not_found', 'no active poll');
        break;
      case 'keyword_add':
        if (!a.text?.trim()) throw new HttpError(400, 'bad_request', 'text required');
        moderation.addKeyword(room, a.text);
        break;
      case 'keyword_remove':
        if (!a.text?.trim()) throw new HttpError(400, 'bad_request', 'text required');
        moderation.removeKeyword(room, a.text);
        break;
    }
    return { ok: true as const, state: hub.state(room), mod: moderation.state(room) };
  });
}
