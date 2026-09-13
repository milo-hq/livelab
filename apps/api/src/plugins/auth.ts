import fp from 'fastify-plugin';
import { SignJWT, jwtVerify } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { UserRef, type Role } from '@livelab/protocol';
import { HttpError } from '../lib/http-error.js';

declare module 'fastify' {
  interface FastifyRequest { user: UserRef | null }
  interface FastifyInstance {
    signToken(user: UserRef): Promise<string>;
    verifyToken(token: string): Promise<UserRef | null>;
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (...roles: Role[]) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export default fp(async (app, opts: { secret: string }) => {
  const key = new TextEncoder().encode(opts.secret);

  app.decorateRequest('user', null);
  app.decorate('signToken', (user: UserRef) =>
    new SignJWT({ name: user.name, role: user.role }).setProtectedHeader({ alg: 'HS256' }).setSubject(user.id)
      .setIssuedAt().setExpirationTime('7d').sign(key));
  app.decorate('verifyToken', async (token: string) => {
    try {
      const { payload } = await jwtVerify(token, key);
      return UserRef.parse({ id: payload.sub, name: payload['name'], role: payload['role'] });
    } catch {
      return null;
    }
  });
  app.decorate('authenticate', async (req: FastifyRequest) => {
    const h = req.headers.authorization ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    const user = token ? await app.verifyToken(token) : null;
    if (!user) throw new HttpError(401, 'unauthorized', 'missing or invalid token');
    req.user = user;
  });
  app.decorate('requireRole', (...roles: Role[]) => async (req: FastifyRequest, reply: FastifyReply) => {
    await app.authenticate(req, reply);
    if (!roles.includes(req.user!.role)) throw new HttpError(403, 'forbidden', `requires role ${roles.join('|')}`);
  });
});
