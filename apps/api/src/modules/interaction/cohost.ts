import type { FastifyInstance } from 'fastify';
import { CohostTarget, type Cohost, type CohostOverview, type CohostRequest } from '@livelab/protocol';
import { HttpError, parse } from '../../lib/http-error.js';
import type { AppContext } from '../../context.js';

export const MAX_COHOSTS = 3;

interface RoomCohosts { requests: Map<string, CohostRequest>; active: Map<string, Cohost> }

/**
 * 连麦 (co-host) signaling. The media never touches this server:
 *   viewer → POST request → host sees it → POST accept → server hands out a MediaMTX path
 *   → the guest's browser publishes to `<path>/whip` → everyone else plays `<path>/whep` as PiP.
 * Signaling rides the existing IM channel (`system{cohost}` for the log, `state{cohosts}` for
 * the snapshot late joiners need). In-memory per room: a restart simply ends every session.
 */
export function createCohostService(ctx: AppContext) {
  const rooms = new Map<string, RoomCohosts>();
  const room = (id: string) => {
    let r = rooms.get(id);
    if (!r) rooms.set(id, (r = { requests: new Map(), active: new Map() }));
    return r;
  };
  const overview = (id: string): CohostOverview => {
    const r = room(id);
    return { requests: [...r.requests.values()], active: [...r.active.values()], max: MAX_COHOSTS };
  };
  const publish = (id: string) => ctx.hub.setState(id, { cohosts: [...room(id).active.values()] });
  const system = (id: string, payload: Record<string, unknown>) =>
    ctx.hub.broadcast(id, { t: 'system', lane: 'system', room: id, kind: 'cohost', payload });

  return {
    overview,
    async request(id: string, user: { id: string; name: string }) {
      const r = room(id);
      if (r.active.has(user.id)) throw new HttpError(409, 'already_live', 'already on air');
      if (!r.requests.has(user.id)) {
        r.requests.set(user.id, { userId: user.id, name: user.name, at: Date.now() });
        await system(id, { state: 'requested', userId: user.id, name: user.name });
      }
      return overview(id);
    },
    async cancel(id: string, userId: string) {
      if (room(id).requests.delete(userId)) await system(id, { state: 'cancelled', userId });
      return overview(id);
    },
    async accept(id: string, userId: string) {
      const r = room(id);
      const req = r.requests.get(userId);
      if (!req) throw new HttpError(404, 'no_request', 'no pending request from that user');
      if (r.active.size >= MAX_COHOSTS) throw new HttpError(409, 'cohost_full', `at most ${MAX_COHOSTS} guests`);
      const path = `cohost/${id}/${userId}`;
      const cohost: Cohost = {
        userId, name: req.name, path,
        whip: `${ctx.cfg.mediamtxWebrtc}/${path}/whip`,
        whep: `${ctx.cfg.mediamtxWebrtc}/${path}/whep`,
        since: Date.now(),
      };
      r.requests.delete(userId);
      r.active.set(userId, cohost);
      publish(id);
      await system(id, { state: 'accepted', userId, name: req.name, path, whip: cohost.whip, whep: cohost.whep });
      return overview(id);
    },
    async reject(id: string, userId: string) {
      const r = room(id);
      const req = r.requests.get(userId);
      if (req) {
        r.requests.delete(userId);
        await system(id, { state: 'rejected', userId, name: req.name });
      }
      return overview(id);
    },
    async end(id: string, userId: string) {
      const r = room(id);
      const c = r.active.get(userId);
      if (c) {
        r.active.delete(userId);
        publish(id);
        await system(id, { state: 'ended', userId, name: c.name });
      }
      return overview(id);
    },
  };
}

export async function cohostRoutes(app: FastifyInstance, ctx: AppContext) {
  const svc = createCohostService(ctx);
  const requireRoom = (id: string) => {
    if (!ctx.rooms.get(id)) throw new HttpError(404, 'not_found', 'room not found');
  };
  const staff = app.requireRole('host', 'admin');

  app.get<{ Params: { id: string } }>('/v1/rooms/:id/cohost', { preHandler: app.authenticate }, async (req) => {
    requireRoom(req.params.id);
    return svc.overview(req.params.id);
  });
  app.post<{ Params: { id: string } }>('/v1/rooms/:id/cohost/request', { preHandler: app.authenticate }, async (req) => {
    requireRoom(req.params.id);
    return svc.request(req.params.id, req.user!);
  });
  app.delete<{ Params: { id: string } }>('/v1/rooms/:id/cohost/request', { preHandler: app.authenticate }, async (req) => {
    requireRoom(req.params.id);
    return svc.cancel(req.params.id, req.user!.id);
  });
  app.post<{ Params: { id: string } }>('/v1/rooms/:id/cohost/accept', { preHandler: staff }, async (req) => {
    requireRoom(req.params.id);
    const { userId } = parse(CohostTarget, req.body ?? {});
    if (!userId) throw new HttpError(400, 'bad_request', 'userId required');
    return svc.accept(req.params.id, userId);
  });
  app.post<{ Params: { id: string } }>('/v1/rooms/:id/cohost/reject', { preHandler: staff }, async (req) => {
    requireRoom(req.params.id);
    const { userId } = parse(CohostTarget, req.body ?? {});
    if (!userId) throw new HttpError(400, 'bad_request', 'userId required');
    return svc.reject(req.params.id, userId);
  });
  /** Host/admin may end anyone; a guest may only end their own session. */
  app.post<{ Params: { id: string } }>('/v1/rooms/:id/cohost/end', { preHandler: app.authenticate }, async (req) => {
    requireRoom(req.params.id);
    const { userId } = parse(CohostTarget, req.body ?? {});
    const me = req.user!;
    const target = me.role === 'viewer' ? me.id : (userId ?? me.id);
    return svc.end(req.params.id, target);
  });
}
