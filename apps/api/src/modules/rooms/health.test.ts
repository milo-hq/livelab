import { describe, expect, it } from 'vitest';
import { createHealthService } from './health.js';

const mediamtxPath = { name: 'live/demo', ready: true, source: { type: 'rtmpConn', id: 'x' }, tracks: ['H264', 'MPEG-4 Audio'], readers: [{ type: 'hlsMuxer' }], bytesReceived: 1234 };

function fakeFetch(handler: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => { const url = String(input); calls.push(url); return handler(url); }) as typeof fetch;
  return { fetch: f, calls };
}

describe('health service', () => {
  it('maps a MediaMTX path to StreamHealth', async () => {
    const { fetch, calls } = fakeFetch(() => Response.json(mediamtxPath));
    const h = createHealthService({ mediamtxApi: 'http://mtx' }, { fetch, now: () => 5 });
    expect(await h.get('demo')).toEqual({ ready: true, bytesReceived: 1234, readers: 1, tracks: ['H264', 'MPEG-4 Audio'], sourceType: 'rtmpConn', sampledAt: 5 });
    expect(calls).toEqual(['http://mtx/v3/paths/get/live/demo']);
  });

  it('404, non-json and network errors map to ready:false', async () => {
    const h404 = createHealthService({ mediamtxApi: 'http://mtx' }, { fetch: fakeFetch(() => new Response('{"error":"path not found"}', { status: 404 })).fetch });
    expect((await h404.get('demo')).ready).toBe(false);
    const hErr = createHealthService({ mediamtxApi: 'http://mtx' }, { fetch: fakeFetch(() => { throw new Error('ECONNREFUSED'); }).fetch });
    expect(await hErr.get('demo')).toMatchObject({ ready: false, readers: 0, tracks: [], sourceType: null });
  });

  it('caches per path for 2s and dedupes concurrent probes', async () => {
    let t = 0;
    const { fetch, calls } = fakeFetch(() => Response.json(mediamtxPath));
    const h = createHealthService({ mediamtxApi: 'http://mtx' }, { fetch, now: () => t });
    await Promise.all([h.get('demo'), h.get('demo'), h.get('demo_720')]);
    expect(calls).toHaveLength(2);
    t = 1999;
    await h.get('demo');
    expect(calls).toHaveLength(2);
    t = 2000;
    await h.get('demo');
    expect(calls).toHaveLength(3);
  });

  it('isReadyCached never blocks: false until the background probe lands, then the cached value', async () => {
    let resolve!: (r: Response) => void;
    const { fetch, calls } = fakeFetch(() => new Promise<Response>((res) => { resolve = res; }));
    const h = createHealthService({ mediamtxApi: 'http://mtx' }, { fetch, now: () => 10 });
    expect(h.isReadyCached('demo')).toBe(false);
    expect(h.isReadyCached('demo')).toBe(false);
    expect(calls).toHaveLength(1); // one in-flight probe, not two
    resolve(Response.json(mediamtxPath));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.isReadyCached('demo')).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('aborts slow probes after timeoutMs', async () => {
    const { fetch } = fakeFetch((url) => new Promise<Response>((_, rej) => { void url; setTimeout(() => rej(new Error('too slow')), 50); }));
    const h = createHealthService({ mediamtxApi: 'http://mtx' }, { fetch, timeoutMs: 5 });
    const started = Date.now();
    const r = await h.get('demo');
    expect(r.ready).toBe(false);
    expect(Date.now() - started).toBeLessThan(200);
  });
});
