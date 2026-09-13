import type { FastifyInstance } from 'fastify';
import { TelemetryBatch, type QoeSummary } from '@livelab/protocol';
import { parse } from '../../lib/http-error.js';
import type { AppContext } from '../../context.js';
import { toRows } from './mapper.js';
import { EMPTY_SUMMARY } from './summary.js';

export async function telemetryRoutes(app: FastifyInstance, ctx: AppContext) {
  // `navigator.sendBeacon` / keepalive fetch may send JSON as text/plain to avoid a CORS preflight.
  // Scoped to this plugin: it does not affect other routes.
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => {
    try { done(null, JSON.parse(body as string)); } catch (e) { done(e as Error, undefined); }
  });

  app.post('/v1/telemetry', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const batch = parse(TelemetryBatch, req.body);
    const rows = toRows(batch);
    ctx.telemetry.write(rows);
    return reply.status(202).send({ accepted: rows.length });
  });

  app.get('/v1/telemetry/summary', async (req): Promise<QoeSummary> => {
    if (!ctx.qoeSummary) return EMPTY_SUMMARY;
    try {
      return await ctx.qoeSummary();
    } catch (e) {
      req.log.warn({ err: e }, 'qoe summary unavailable');
      return EMPTY_SUMMARY;
    }
  });
}
