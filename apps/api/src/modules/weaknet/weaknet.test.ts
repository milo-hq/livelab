import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../server.js';
import { createWeaknetRoutes, proxiedUrl, rewritePlaylist } from './routes.js';

const P = { delay: 100, loss: 10, bw: 800 };
const via = (abs: string, p = P) => proxiedUrl(abs, p);

describe('rewritePlaylist', () => {
  const base = 'http://localhost:8888/live/demo/index.m3u8?_HLS_msn=12&_HLS_part=3';

  it('rewrites relative and absolute URI lines, keeps tags and blank lines', () => {
    const text = ['#EXTM3U', '#EXT-X-TARGETDURATION:1', '#EXTINF:1.000,', 'seg12.mp4', '#EXTINF:1.000,', 'http://cdn.example/live/demo/seg13.mp4?token=abc', ''].join('\n');
    const out = rewritePlaylist(text, base, P);
    expect(out.split('\n')).toEqual([
      '#EXTM3U', '#EXT-X-TARGETDURATION:1', '#EXTINF:1.000,',
      via('http://localhost:8888/live/demo/seg12.mp4'),
      '#EXTINF:1.000,',
      via('http://cdn.example/live/demo/seg13.mp4?token=abc'),
      '',
    ]);
    expect(out).toContain('/weaknet?u=http%3A%2F%2Flocalhost%3A8888%2Flive%2Fdemo%2Fseg12.mp4&delay=100&loss=10&bw=800');
  });

  it('rewrites URI="..." attributes of MEDIA, MAP, PART and PRELOAD-HINT tags', () => {
    const text = [
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio",AUTOSELECT=YES,DEFAULT=YES,URI="http://localhost:8888/live/demo_720/audio2_stream.m3u8"',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXT-X-PART:DURATION=0.5,URI="part12.3.mp4",INDEPENDENT=YES',
      '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="part12.4.mp4"',
      '#EXT-X-RENDITION-REPORT:URI="../demo_360/video1_stream.m3u8",LAST-MSN=12',
    ].join('\n');
    const out = rewritePlaylist(text, base, P).split('\n');
    expect(out[0]).toBe(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio",AUTOSELECT=YES,DEFAULT=YES,URI="${via('http://localhost:8888/live/demo_720/audio2_stream.m3u8')}"`);
    expect(out[1]).toBe(`#EXT-X-MAP:URI="${via('http://localhost:8888/live/demo/init.mp4')}"`);
    expect(out[2]).toBe(`#EXT-X-PART:DURATION=0.5,URI="${via('http://localhost:8888/live/demo/part12.3.mp4')}",INDEPENDENT=YES`);
    expect(out[3]).toBe(`#EXT-X-PRELOAD-HINT:TYPE=PART,URI="${via('http://localhost:8888/live/demo/part12.4.mp4')}"`);
    expect(out[4]).toBe(`#EXT-X-RENDITION-REPORT:URI="${via('http://localhost:8888/live/demo_360/video1_stream.m3u8')}",LAST-MSN=12`);
  });

  it('preserves query params such as _HLS_msn inside u and the impairment params outside', () => {
    const out = rewritePlaylist('index.m3u8?_HLS_msn=13&_HLS_part=0', base, { delay: 0, loss: 0, bw: 0 });
    const u = new URL(out, 'http://api');
    expect(u.pathname).toBe('/weaknet');
    expect(u.searchParams.get('u')).toBe('http://localhost:8888/live/demo/index.m3u8?_HLS_msn=13&_HLS_part=0');
    expect(u.searchParams.get('delay')).toBe('0');
    expect(u.searchParams.get('loss')).toBe('0');
    expect(u.searchParams.get('bw')).toBe('0');
  });

  it('handles CRLF playlists', () => {
    expect(rewritePlaylist('#EXTM3U\r\nseg.mp4\r\n', base, P)).toBe(`#EXTM3U\n${via('http://localhost:8888/live/demo/seg.mp4')}\n`);
  });
});

describe('GET /weaknet', () => {
  let upstream: Server;
  let origin: string;
  const hits: Array<{ url: string; headers: Record<string, string | string[] | undefined> }> = [];
  const SEGMENT = Buffer.alloc(4000, 7);

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      hits.push({ url: req.url!, headers: req.headers });
      if (req.url!.startsWith('/live/demo/index.m3u8')) {
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        res.end('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1.0,\nseg1.m4s\n');
      } else if (req.url!.startsWith('/live/demo/seg1.m4s')) {
        res.writeHead(200, { 'content-type': 'video/iso.segment', 'content-length': String(SEGMENT.length) });
        res.end(SEGMENT);
      } else if (req.url!.startsWith('/live/demo/slow.m4s')) {
        res.writeHead(200, { 'content-type': 'video/iso.segment' });
        res.write(SEGMENT.subarray(0, 2000));
        setTimeout(() => res.end(SEGMENT.subarray(2000)), 30);
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('nope');
      }
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });
  afterAll(async () => { upstream.close(); });

  type App = Awaited<ReturnType<typeof buildApp>>;
  let app: App;
  beforeEach(async () => {
    hits.length = 0;
    app = await buildApp({ dbPath: ':memory:', logger: false, cfg: { redisUrl: undefined, clickhouseUrl: undefined, mediamtxHls: origin, srsFlv: 'http://127.0.0.1:1', apiPublicUrl: 'http://127.0.0.1:2' } });
  });
  afterEach(async () => { await app.close(); });

  const get = (query: Record<string, string>, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: '/weaknet', query, headers });

  it('rejects invalid, non-http and non-allowlisted upstreams', async () => {
    expect((await get({ u: 'not a url' })).statusCode).toBe(400);
    expect((await get({ u: 'ftp://127.0.0.1/x.m4s' })).statusCode).toBe(400);
    const evil = await get({ u: 'http://evil.example/live/demo/seg1.m4s' });
    expect(evil.statusCode).toBe(400);
    expect(evil.json()).toMatchObject({ code: 'bad_request' });
    expect((await get({ u: `${origin}/live/demo/seg1.m4s`, delay: '99999' })).statusCode).toBe(400);
    expect((await get({ u: `${origin}/live/demo/seg1.m4s`, loss: '101' })).statusCode).toBe(400);
    expect(hits).toHaveLength(0);
  });

  it('allows the SRS and public api hosts too', async () => {
    // Closed ports pass the allowlist and fail at fetch time with 502, proving they were not 400.
    expect((await get({ u: 'http://127.0.0.1:1/live/demo.flv' })).statusCode).toBe(502);
    expect((await get({ u: 'http://127.0.0.1:2/v1/rooms/demo/master.m3u8' })).statusCode).toBe(502);
  });

  it('proxies a segment: status, content-type, range/accept pass-through, no-store', async () => {
    const res = await get({ u: `${origin}/live/demo/seg1.m4s` }, { range: 'bytes=0-', accept: '*/*' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('video/iso.segment');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.rawPayload.equals(SEGMENT)).toBe(true);
    expect(hits[0]!.headers['range']).toBe('bytes=0-');
    expect(hits[0]!.headers['accept']).toBe('*/*');
    const missing = await get({ u: `${origin}/live/demo/missing.m4s` });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toBe('nope');
  });

  it('honours delay before contacting upstream', async () => {
    const t0 = performance.now();
    const res = await get({ u: `${origin}/live/demo/seg1.m4s`, delay: '150' });
    expect(res.statusCode).toBe(200);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(140);
  });

  it('loss=100 drops every segment with 503 but never a playlist', async () => {
    for (let i = 0; i < 3; i++) {
      const seg = await get({ u: `${origin}/live/demo/seg1.m4s`, loss: '100' });
      expect(seg.statusCode).toBe(503);
      expect(seg.json()).toMatchObject({ code: 'weaknet_loss' });
    }
    expect(hits).toHaveLength(0); // dropped before reaching upstream
    const pl = await get({ u: `${origin}/live/demo/index.m3u8`, loss: '100' });
    expect(pl.statusCode).toBe(200);
    expect(hits).toHaveLength(1);
    const none = await get({ u: `${origin}/live/demo/seg1.m4s`, loss: '0' });
    expect(none.statusCode).toBe(200);
  });

  it('applies the loss probability through the injected rng', async () => {
    let r = 0;
    const lab = Fastify({ logger: false });
    await lab.register(createWeaknetRoutes({ rng: () => r }), app.ctx);
    const seg = (loss: string) => lab.inject({ method: 'GET', url: '/weaknet', query: { u: `${origin}/live/demo/seg1.m4s`, loss } });
    r = 0.29; expect((await seg('30')).statusCode).toBe(503);
    r = 0.30; expect((await seg('30')).statusCode).toBe(200);
    r = 0.99; expect((await seg('30')).statusCode).toBe(200);
    r = 0.01; expect((await seg('0')).statusCode).toBe(200);
    await lab.close();
  });

  it('rewrites playlists so children come back through the proxy with the same params', async () => {
    const res = await get({ u: `${origin}/live/demo/index.m3u8?_HLS_msn=5`, delay: '20', loss: '30', bw: '500' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.apple.mpegurl');
    expect(hits[0]!.url).toBe('/live/demo/index.m3u8?_HLS_msn=5');
    const p = { delay: 20, loss: 30, bw: 500 };
    expect(res.body).toBe(['#EXTM3U', `#EXT-X-MAP:URI="${via(`${origin}/live/demo/init.mp4`, p)}"`, '#EXTINF:1.0,', via(`${origin}/live/demo/seg1.m4s`, p), ''].join('\n'));
  });

  it('throttles the body with a token bucket when bw is set', async () => {
    // 4000 bytes at 80 kbps (10 000 B/s → 500 B per 50 ms tick) needs 7 refills ≈ 350 ms.
    const t0 = performance.now();
    const res = await get({ u: `${origin}/live/demo/seg1.m4s`, bw: '80' });
    const elapsed = performance.now() - t0;
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('video/iso.segment');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.rawPayload.equals(SEGMENT)).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(300);
    // Chunked upstream bodies are reassembled in order.
    const slow = await get({ u: `${origin}/live/demo/slow.m4s`, bw: '800' });
    expect(slow.rawPayload.equals(SEGMENT)).toBe(true);
  });
});
