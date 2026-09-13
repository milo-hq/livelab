import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { loadConfig, type Config } from './config.js';
import { openDb } from './db.js';
import authPlugin from './plugins/auth.js';
import { HttpError } from './lib/http-error.js';
import { createContext, type AppContext } from './context.js';
import { roomRoutes } from './modules/rooms/routes.js';

export interface BuildOptions { cfg?: Partial<Config>; dbPath?: string; logger?: boolean }

export async function buildApp(opts: BuildOptions = {}) {
  const cfg = loadConfig(opts.cfg);
  const db = openDb(opts.dbPath ?? cfg.dbPath);
  const app = Fastify({
    logger: opts.logger === false ? false : { level: 'info', transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } },
    bodyLimit: 256 * 1024,
  });

  await app.register(cors, { origin: true, credentials: true, exposedHeaders: ['content-type'] });
  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });
  await app.register(authPlugin, { secret: cfg.jwtSecret });

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ code: err.code, message: err.message, ...err.extra });
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.status(status).send({ code: status >= 500 ? 'internal' : 'bad_request', message: e.message ?? 'error' });
  });

  const ctx: AppContext = createContext(cfg, db);
  app.decorate('ctx', ctx);

  app.get('/healthz', async () => ({ ok: true, ts: Date.now() }));
  await app.register(roomRoutes, ctx);

  app.addHook('onClose', async () => db.close());
  return app;
}

declare module 'fastify' {
  interface FastifyInstance { ctx: AppContext }
}
