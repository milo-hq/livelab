import type { FastifyInstance } from 'fastify';
import { AuthRequest, type Room } from '@livelab/protocol';
import { HttpError, parse } from '../../lib/http-error.js';
import { userIdFor } from '../../lib/ids.js';
import { buildMasterPlaylist, buildPathways, DEMO_RENDITIONS, policyFor } from './pathways.js';
import type { AppContext } from '../../context.js';

export async function roomRoutes(app: FastifyInstance, ctx: AppContext) {
  const { cfg, rooms } = ctx;

  app.post('/v1/auth/demo', async (req) => {
    const body = parse(AuthRequest, req.body);
    const user = { id: userIdFor(body.name, body.role), name: body.name, role: body.role };
    ctx.db.prepare('INSERT OR IGNORE INTO users (id,name,role,created_at) VALUES (?,?,?,?)').run(user.id, user.name, user.role, Date.now());
    return { token: await app.signToken(user), user };
  });

  app.get('/v1/me', { preHandler: app.authenticate }, async (req) => req.user);

  app.get('/v1/rooms', async () => rooms.list(ctx.liveness, ctx.online));

  app.get<{ Params: { id: string } }>('/v1/rooms/:id', async (req) => {
    const room = rooms.get(req.params.id, ctx.liveness, ctx.online(req.params.id));
    if (!room) throw new HttpError(404, 'not_found', 'room not found');
    return room;
  });

  app.get<{ Params: { id: string } }>('/v1/rooms/:id/play', async (req) => {
    const room: Room | null = rooms.get(req.params.id, ctx.liveness);
    if (!room) throw new HttpError(404, 'not_found', 'room not found');
    return { roomId: room.id, pathways: buildPathways(room, cfg), policy: policyFor(room) };
  });

  app.get<{ Params: { id: string } }>('/v1/rooms/:id/master.m3u8', async (req, reply) => {
    const room = rooms.get(req.params.id);
    if (!room) throw new HttpError(404, 'not_found', 'room not found');
    reply.header('content-type', 'application/vnd.apple.mpegurl').header('cache-control', 'no-store');
    return buildMasterPlaylist(cfg.mediamtxHls, DEMO_RENDITIONS);
  });

  app.get<{ Params: { id: string } }>('/v1/rooms/:id/key', { preHandler: app.requireRole('host', 'admin') }, async (req) => {
    const room = rooms.getWithKey(req.params.id);
    if (!room) throw new HttpError(404, 'not_found', 'room not found');
    return room;
  });

  app.post<{ Params: { id: string } }>('/v1/rooms/:id/key/reset', { preHandler: app.requireRole('host', 'admin') }, async (req) => {
    if (!rooms.get(req.params.id)) throw new HttpError(404, 'not_found', 'room not found');
    return { streamKey: rooms.resetKey(req.params.id) };
  });
}
