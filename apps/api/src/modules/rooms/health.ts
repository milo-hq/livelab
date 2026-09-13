import type { FastifyInstance } from 'fastify';
import type { StreamHealth } from '@livelab/protocol';
import type { Config } from '../../config.js';
import type { AppContext } from '../../context.js';
import { HttpError } from '../../lib/http-error.js';

export interface HealthService {
  /** Fresh-enough (`cacheMs`) health for a MediaMTX path such as `demo`; never throws. */
  get(streamPath: string): Promise<StreamHealth>;
  /**
   * Last known readiness without blocking: returns the cached value (false when unknown) and, if
   * the cache is stale, refreshes in the background. Used by the room list for `status`.
   */
  isReadyCached(streamPath: string): boolean;
  close(): void;
}

export interface HealthOptions {
  fetch?: typeof fetch;
  now?: () => number;
  cacheMs?: number;
  timeoutMs?: number;
}

/** Subset of MediaMTX `GET /v3/paths/get/{name}` (verified against 1.21.0). */
interface MediamtxPath {
  ready?: boolean;
  bytesReceived?: number;
  readers?: unknown[];
  tracks?: string[];
  source?: { type?: string } | null;
}

/**
 * Stream health from the MediaMTX control API. Rooms map to paths `live/<streamPath>`; a 404 means
 * nobody is publishing. Results are cached for 2s per path so a busy host console (polling every
 * 2s) and the room list never hammer MediaMTX, and every failure degrades to `ready:false`.
 */
export function createHealthService(cfg: Pick<Config, 'mediamtxApi'>, opts: HealthOptions = {}): HealthService {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const cacheMs = opts.cacheMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 1500;
  const cache = new Map<string, { value: StreamHealth; inflight: Promise<StreamHealth> | null }>();
  let closed = false;

  const offline = (sampledAt = now()): StreamHealth => ({ ready: false, bytesReceived: 0, readers: 0, tracks: [], sourceType: null, sampledAt });

  async function probe(streamPath: string): Promise<StreamHealth> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await doFetch(`${cfg.mediamtxApi}/v3/paths/get/live/${streamPath}`, { signal: ctrl.signal });
      if (!res.ok) return offline();
      const p = (await res.json()) as MediamtxPath;
      return {
        ready: p.ready === true,
        bytesReceived: p.bytesReceived ?? 0,
        readers: Array.isArray(p.readers) ? p.readers.length : 0,
        tracks: Array.isArray(p.tracks) ? p.tracks : [],
        sourceType: p.source?.type ?? null,
        sampledAt: now(),
      };
    } catch {
      return offline();
    } finally {
      clearTimeout(timer);
    }
  }

  function get(streamPath: string): Promise<StreamHealth> {
    const c = cache.get(streamPath);
    if (c && now() - c.value.sampledAt < cacheMs) return Promise.resolve(c.value);
    if (c?.inflight) return c.inflight;
    // Placeholder with sampledAt 0 so it is never mistaken for a fresh sample.
    const entry = c ?? { value: offline(0), inflight: null };
    cache.set(streamPath, entry);
    // Cheap dedupe: concurrent callers share one in-flight request.
    entry.inflight = probe(streamPath).then((v) => {
      if (!closed) entry.value = v;
      entry.inflight = null;
      return v;
    });
    return entry.inflight;
  }

  return {
    get,
    isReadyCached(streamPath) {
      const c = cache.get(streamPath);
      if (!closed && (!c || (now() - c.value.sampledAt >= cacheMs && !c.inflight))) void get(streamPath).catch(() => {});
      return c?.value.ready ?? false;
    },
    close() {
      closed = true;
    },
  };
}

/**
 * `GET /v1/rooms/:id/health` (host/admin: full `StreamHealth`) and
 * `GET /v1/rooms/:id/health/public` (anyone: `{ ready }` only — the viewer page polls it while
 * a room is offline to know when to start the player).
 */
export async function healthRoutes(app: FastifyInstance, ctx: AppContext) {
  const room = (id: string) => {
    const r = ctx.rooms.get(id);
    if (!r) throw new HttpError(404, 'not_found', 'room not found');
    return r;
  };
  app.get<{ Params: { id: string } }>('/v1/rooms/:id/health', { preHandler: app.requireRole('host', 'admin') }, async (req): Promise<StreamHealth> =>
    ctx.health.get(room(req.params.id).streamPath));
  app.get<{ Params: { id: string } }>('/v1/rooms/:id/health/public', async (req) => ({ ready: (await ctx.health.get(room(req.params.id).streamPath)).ready }));
}
