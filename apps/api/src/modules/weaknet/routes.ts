import { once } from 'node:events';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, parse } from '../../lib/http-error.js';
import type { AppContext } from '../../context.js';

/**
 * Weak-network lab proxy: `GET /weaknet?u=<absolute upstream>&delay=<ms>&loss=<%>&bw=<kbps>`.
 * Sits between the player and MediaMTX/SRS so the recovery ladder can be studied under controlled
 * latency, segment loss and bandwidth caps. Playlists are rewritten so every child URL comes back
 * through the proxy with the same impairment parameters.
 */
export interface WeaknetParams { delay: number; loss: number; bw: number }

const Query = z.object({
  u: z.string().min(1),
  delay: z.coerce.number().int().min(0).max(10_000).default(0),
  loss: z.coerce.number().min(0).max(100).default(0),
  bw: z.coerce.number().int().min(0).default(0),
});

const TICK_MS = 50;

export function proxiedUrl(absolute: string, p: WeaknetParams): string {
  return `/weaknet?u=${encodeURIComponent(absolute)}&delay=${p.delay}&loss=${p.loss}&bw=${p.bw}`;
}

/**
 * Rewrites every URI in an HLS playlist (plain URI lines and `URI="..."` attributes of
 * `#EXT-X-MEDIA`, `#EXT-X-MAP`, `#EXT-X-PART`, `#EXT-X-PRELOAD-HINT`, ...) to go through the proxy.
 * Relative references are resolved against `upstreamUrl`; query strings (`_HLS_msn`, ...) survive
 * because the whole absolute URL is percent-encoded into `u`.
 */
export function rewritePlaylist(text: string, upstreamUrl: string, params: WeaknetParams): string {
  const via = (ref: string) => proxiedUrl(new URL(ref, upstreamUrl).toString(), params);
  return text.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (t === '') return line;
    if (t.startsWith('#')) return line.replace(/URI="([^"]*)"/g, (_m, ref: string) => `URI="${via(ref)}"`);
    return via(t);
  }).join('\n');
}

const hostOf = (url: string): string | null => { try { return new URL(url).host; } catch { return null; } };

/** Factory so tests can inject a deterministic `rng`; `weaknetRoutes` is the production plugin. */
export function createWeaknetRoutes(deps: { rng?: () => number } = {}) {
  const rng = deps.rng ?? Math.random;
  return async function weaknetRoutes(app: FastifyInstance, ctx: AppContext) {
    const { cfg } = ctx;
    // The ABR master playlist lives on this api and its children on MediaMTX; FLV on SRS.
    const allowedHosts = new Set([cfg.mediamtxHls, cfg.srsFlv, cfg.apiPublicUrl].map(hostOf).filter((h): h is string => h !== null));

    app.get('/weaknet', async (req, reply) => {
      const q = parse(Query, req.query);
      let upstream: URL;
      try { upstream = new URL(q.u); } catch { throw new HttpError(400, 'bad_request', 'u must be an absolute URL'); }
      if (!/^https?:$/.test(upstream.protocol) || !allowedHosts.has(upstream.host)) {
        throw new HttpError(400, 'bad_request', `upstream host not allowed: ${upstream.host}`);
      }
      const params: WeaknetParams = { delay: q.delay, loss: q.loss, bw: q.bw };
      const isPlaylist = upstream.pathname.endsWith('.m3u8');

      const ac = new AbortController();
      req.raw.on('close', () => ac.abort());

      if (params.delay > 0) await sleep(params.delay, undefined, { signal: ac.signal }).catch(() => undefined);
      if (ac.signal.aborted) return reply.hijack();

      // Loss only ever hits segments/parts: a dropped playlist makes the player wait for the next
      // reload and stalls forever, whereas a dropped segment triggers the retry/recovery path we
      // actually want to study.
      if (params.loss > 0 && !isPlaylist && rng() * 100 < params.loss) {
        return reply.status(503).header('cache-control', 'no-store').send({ code: 'weaknet_loss', message: 'simulated segment loss' });
      }

      const headers: Record<string, string> = {};
      for (const h of ['range', 'accept'] as const) {
        const v = req.headers[h];
        if (typeof v === 'string') headers[h] = v;
      }
      let up: Response;
      try {
        up = await fetch(upstream, { headers, signal: ac.signal });
      } catch (e) {
        if (ac.signal.aborted) return reply.hijack();
        throw new HttpError(502, 'bad_gateway', `upstream fetch failed: ${(e as Error).message}`);
      }

      reply.status(up.status).header('cache-control', 'no-store');
      const ct = up.headers.get('content-type');
      if (ct) reply.header('content-type', ct);
      for (const h of ['accept-ranges', 'content-range'] as const) {
        const v = up.headers.get(h);
        if (v) reply.header(h, v);
      }

      if (isPlaylist && up.ok) {
        return reply.send(rewritePlaylist(await up.text(), upstream.toString(), params));
      }
      if (!up.body) return reply.send();
      if (params.bw <= 0) {
        const len = up.headers.get('content-length');
        if (len) reply.header('content-length', len);
        return reply.send(Readable.fromWeb(up.body as import('node:stream/web').ReadableStream));
      }

      // Token bucket: refill `bw` kbps worth of bytes every 50 ms and write only what the bucket holds.
      reply.hijack();
      const raw = reply.raw;
      const outHeaders: Record<string, string> = { 'cache-control': 'no-store' };
      if (ct) outHeaders['content-type'] = ct;
      raw.writeHead(up.status, outHeaders);
      const bytesPerTick = Math.max(1, Math.floor((params.bw * 1000 / 8) * TICK_MS / 1000));
      let tokens = bytesPerTick;
      const reader = up.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || ac.signal.aborted) break;
          let offset = 0;
          while (offset < value.length && !ac.signal.aborted) {
            if (tokens <= 0) {
              await sleep(TICK_MS, undefined, { signal: ac.signal }).catch(() => undefined);
              tokens = bytesPerTick;
              continue;
            }
            const n = Math.min(tokens, value.length - offset);
            const ok = raw.write(value.subarray(offset, offset + n));
            tokens -= n;
            offset += n;
            if (!ok) await Promise.race([once(raw, 'drain'), once(ac.signal, 'abort')]);
          }
        }
      } catch {
        /* upstream or client went away */
      } finally {
        void reader.cancel().catch(() => undefined);
        if (!raw.destroyed) raw.end();
      }
    });
  };
}

export const weaknetRoutes = createWeaknetRoutes();
