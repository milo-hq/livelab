import type { FastifyInstance } from 'fastify';
import type { AdminOverview, QoeSummary } from '@livelab/protocol';
import type { AppContext } from '../../context.js';

/** What the overview reports when no telemetry backend (ClickHouse) is wired up. */
export const EMPTY_QOE: QoeSummary = { ttffP50: null, ttffP95: null, fastStartPct: null, stallPer100s: null, stallViewPct: null, failurePct: null, sessions: 0, source: 'none' };

export async function adminRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/v1/admin/overview', { preHandler: app.requireRole('admin') }, async (): Promise<AdminOverview> => {
    const rooms = ctx.rooms.list(ctx.liveness, ctx.online).map((r) => ({ ...r, online: ctx.hub.online(r.id), msgRate: ctx.hub.msgRate(r.id) }));
    let qoe = EMPTY_QOE;
    if (ctx.qoeSummary) {
      try { qoe = await ctx.qoeSummary(); } catch (e) { app.log.warn(e, 'qoe summary failed'); }
    }
    return { rooms, qoe };
  });
}
