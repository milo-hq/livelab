import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineEventMap } from '../types.js';

type Listener = (...args: unknown[]) => void;
const players: FakePlayer[] = [];
class FakePlayer {
  listeners = new Map<string, Set<Listener>>();
  attachMediaElement = vi.fn();
  detachMediaElement = vi.fn();
  load = vi.fn();
  unload = vi.fn();
  destroy = vi.fn();
  constructor(public source: Record<string, unknown>, public config: Record<string, unknown>) {
    players.push(this);
  }
  on(ev: string, cb: Listener) {
    let s = this.listeners.get(ev);
    if (!s) this.listeners.set(ev, (s = new Set()));
    s.add(cb);
  }
  off(ev: string, cb: Listener) {
    this.listeners.get(ev)?.delete(cb);
  }
  trigger(ev: string, ...args: unknown[]) {
    this.listeners.get(ev)?.forEach((cb) => cb(...args));
  }
}
const fakeMpegts = {
  createPlayer: vi.fn((src: Record<string, unknown>, cfg: Record<string, unknown>) => new FakePlayer(src, cfg)),
  isSupported: vi.fn(() => true),
  getFeatureList: vi.fn(() => ({ mseLivePlayback: true })),
  Events: { ERROR: 'error', MEDIA_INFO: 'media_info', STATISTICS_INFO: 'statistics_info', LOADING_COMPLETE: 'loading_complete' },
  ErrorTypes: { NETWORK_ERROR: 'NetworkError', MEDIA_ERROR: 'MediaError', OTHER_ERROR: 'OtherError' },
  ErrorDetails: { NETWORK_TIMEOUT: 'NetworkTimeout', NETWORK_EXCEPTION: 'NetworkException', MEDIA_MSE_ERROR: 'MediaMSEError' },
};
vi.mock('mpegts.js', () => ({ default: fakeMpegts }));

async function setup(opts: Partial<Parameters<import('./flv.js').FlvEngine['load']>[2]> = {}) {
  const { FlvEngine } = await import('./flv.js');
  const video = document.createElement('video');
  const engine = new FlvEngine();
  const events: Array<{ ev: string; p: unknown }> = [];
  (['ready', 'playing', 'error', 'stats'] as const).forEach((ev) =>
    engine.on(ev, (p: EngineEventMap[typeof ev]) => events.push({ ev, p })),
  );
  await engine.load(video, 'http://srs/live/demo.flv', { targetLatencySec: 1.5, ...opts });
  const player = players[players.length - 1]!;
  return { engine, video, player, events };
}

describe('FlvEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    players.length = 0;
    fakeMpegts.isSupported.mockReturnValue(true);
    fakeMpegts.getFeatureList.mockReturnValue({ mseLivePlayback: true });
  });
  afterEach(() => vi.useRealTimers());

  it('creates a live flv player with latency-chasing config and attaches media', async () => {
    const { player, video } = await setup();
    expect(player.source).toEqual({ type: 'flv', isLive: true, url: 'http://srs/live/demo.flv' });
    expect(player.config).toMatchObject({
      enableWorker: true,
      liveBufferLatencyChasing: true,
      liveBufferLatencyMaxLatency: 1.5,
      liveBufferLatencyMinRemain: 0.5,
      liveSync: true,
      liveSyncMaxLatency: 1.5,
      autoCleanupSourceBuffer: true,
    });
    expect(player.attachMediaElement).toHaveBeenCalledWith(video);
    expect(player.load).toHaveBeenCalledTimes(1);
  });

  it('applies requestTransform to the stream URL', async () => {
    const { player } = await setup({ requestTransform: (u) => `http://proxy/?u=${u}` });
    expect(player.source['url']).toBe('http://proxy/?u=http://srs/live/demo.flv');
  });

  it('emits a fatal error and rejects when live MSE playback is unsupported', async () => {
    fakeMpegts.getFeatureList.mockReturnValue({ mseLivePlayback: false });
    const { FlvEngine } = await import('./flv.js');
    const engine = new FlvEngine();
    const errors: unknown[] = [];
    engine.on('error', (e) => errors.push(e));
    await expect(engine.load(document.createElement('video'), 'x', { targetLatencySec: 1 })).rejects.toThrow();
    expect(errors[0]).toMatchObject({ fatal: true, type: 'unsupported' });
  });

  it('maps MEDIA_INFO to ready and STATISTICS_INFO to stats', async () => {
    const { player, video, events } = await setup();
    player.trigger(fakeMpegts.Events.MEDIA_INFO, { videoDataRate: 1500 });
    expect(events).toContainEqual({ ev: 'ready', p: { kind: 'flv' } });
    Object.defineProperty(video, 'buffered', { value: { length: 1, start: () => 0, end: () => 5 } });
    Object.defineProperty(video, 'currentTime', { value: 4, writable: true });
    player.trigger(fakeMpegts.Events.STATISTICS_INFO, { speed: 250, droppedFrames: 3, decodedFrames: 300 });
    const s = events.filter((e) => e.ev === 'stats').at(-1)?.p as EngineEventMap['stats'];
    expect(s).toMatchObject({ bitrateKbps: 2000, droppedFrames: 3, totalFrames: 300, bufferMs: 1000, latencyMs: 1000, level: null, levels: 0 });
    video.dispatchEvent(new Event('playing'));
    expect(events).toContainEqual({ ev: 'playing', p: {} });
  });

  it('retries NETWORK_TIMEOUT once via unload/load, then reports fatal', async () => {
    const { player, events } = await setup();
    player.trigger(fakeMpegts.Events.ERROR, 'NetworkError', 'NetworkTimeout', { msg: 't/o' });
    expect(player.unload).toHaveBeenCalledTimes(1);
    expect(player.load).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.ev === 'error').at(-1)?.p).toMatchObject({ type: 'NetworkError', detail: 'NetworkTimeout', fatal: false });
    player.trigger(fakeMpegts.Events.ERROR, 'NetworkError', 'NetworkTimeout', { msg: 't/o' });
    expect(player.load).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.ev === 'error').at(-1)?.p).toMatchObject({ fatal: true });
  });

  it('reports other NETWORK/MEDIA errors as fatal and OTHER as non-fatal', async () => {
    const { player, events } = await setup();
    player.trigger(fakeMpegts.Events.ERROR, 'MediaError', 'MediaMSEError', { msg: 'mse' });
    expect(events.at(-1)?.p).toMatchObject({ type: 'MediaError', detail: 'MediaMSEError', fatal: true });
    player.trigger(fakeMpegts.Events.ERROR, 'OtherError', 'Whatever', {});
    expect(events.at(-1)?.p).toMatchObject({ type: 'OtherError', fatal: false });
  });

  it('seekToLive moves near the buffered end; destroy is idempotent', async () => {
    const { engine, player, video } = await setup();
    Object.defineProperty(video, 'buffered', { value: { length: 1, start: () => 0, end: () => 10 } });
    engine.seekToLive();
    expect(video.currentTime).toBeCloseTo(9.5);
    engine.destroy();
    engine.destroy();
    expect(player.destroy).toHaveBeenCalledTimes(1);
    expect(player.detachMediaElement).toHaveBeenCalledTimes(1);
  });
});
