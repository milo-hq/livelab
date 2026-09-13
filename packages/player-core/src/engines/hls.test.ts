import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineEventMap } from '../types.js';

// ---- fake hls.js -------------------------------------------------------------
type Listener = (ev: string, data: unknown) => void;
const instances: FakeHls[] = [];
class FakeHls {
  static isSupported = () => true;
  static Events = { MANIFEST_PARSED: 'hlsManifestParsed', LEVEL_SWITCHED: 'hlsLevelSwitched', ERROR: 'hlsError' };
  static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError', OTHER_ERROR: 'otherError' };
  config: unknown;
  listeners = new Map<string, Set<Listener>>();
  latency = 2.5;
  levels = [{ bitrate: 800_000 }, { bitrate: 2_500_000 }];
  currentLevel = 1;
  bandwidthEstimate = 1_234_000;
  liveSyncPosition: number | null = 42;
  loadSource = vi.fn();
  attachMedia = vi.fn();
  startLoad = vi.fn();
  recoverMediaError = vi.fn();
  destroy = vi.fn();
  constructor(config: unknown) {
    this.config = config;
    instances.push(this);
  }
  on(ev: string, cb: Listener) {
    let s = this.listeners.get(ev);
    if (!s) this.listeners.set(ev, (s = new Set()));
    s.add(cb);
  }
  off(ev: string, cb: Listener) {
    this.listeners.get(ev)?.delete(cb);
  }
  trigger(ev: string, data: unknown) {
    this.listeners.get(ev)?.forEach((cb) => cb(ev, data));
  }
}
vi.mock('hls.js', () => ({ default: FakeHls }));

// ---- helpers -----------------------------------------------------------------
async function setup() {
  const { HlsEngine } = await import('./hls.js');
  const video = document.createElement('video');
  const engine = new HlsEngine();
  const events: Array<{ ev: string; p: unknown }> = [];
  (['ready', 'playing', 'level_switch', 'error', 'stats'] as const).forEach((ev) =>
    engine.on(ev, (p: EngineEventMap[typeof ev]) => events.push({ ev, p })),
  );
  await engine.load(video, 'https://cdn/live.m3u8', { targetLatencySec: 2 });
  const hls = instances[instances.length - 1]!;
  return { engine, video, hls, events, FakeHls };
}

describe('HlsEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    instances.length = 0;
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates hls.js with the LL-HLS config, loads the source and attaches media', async () => {
    const { hls, video } = await setup();
    expect(hls.loadSource).toHaveBeenCalledWith('https://cdn/live.m3u8');
    expect(hls.attachMedia).toHaveBeenCalledWith(video);
    expect((hls.config as { liveSyncDuration: number }).liveSyncDuration).toBe(2);
  });

  it('rejects a second load() call', async () => {
    const { engine, video } = await setup();
    await expect(engine.load(video, 'x', { targetLatencySec: 2 })).rejects.toThrow();
  });

  it('maps MANIFEST_PARSED to ready, LEVEL_SWITCHED to level_switch and video playing to playing', async () => {
    const { engine, hls, video, events } = await setup();
    hls.trigger(FakeHls.Events.MANIFEST_PARSED, { levels: hls.levels });
    expect(events).toContainEqual({ ev: 'ready', p: { kind: 'hls' } });
    hls.trigger(FakeHls.Events.LEVEL_SWITCHED, { level: 1 });
    expect(events).toContainEqual({ ev: 'level_switch', p: { level: 1, bitrateKbps: 2500, reason: 'abr' } });
    engine.setLevel(0);
    expect(hls.currentLevel).toBe(0);
    hls.trigger(FakeHls.Events.LEVEL_SWITCHED, { level: 0 });
    expect(events).toContainEqual({ ev: 'level_switch', p: { level: 0, bitrateKbps: 800, reason: 'manual' } });
    video.dispatchEvent(new Event('playing'));
    expect(events).toContainEqual({ ev: 'playing', p: {} });
  });

  it('recovers a fatal network error once via startLoad and escalates within 10s', async () => {
    const { hls, events } = await setup();
    const err = { type: 'networkError', details: 'manifestLoadError', fatal: true };
    hls.trigger(FakeHls.Events.ERROR, err);
    expect(hls.startLoad).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.ev === 'error').at(-1)?.p).toMatchObject({ type: 'networkError', detail: 'manifestLoadError', fatal: false });
    vi.advanceTimersByTime(5_000);
    hls.trigger(FakeHls.Events.ERROR, err);
    expect(hls.startLoad).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.ev === 'error').at(-1)?.p).toMatchObject({ fatal: true });
  });

  it('recovers a fatal media error once via recoverMediaError', async () => {
    const { hls, events } = await setup();
    const err = { type: 'mediaError', details: 'bufferAppendError', fatal: true };
    hls.trigger(FakeHls.Events.ERROR, err);
    expect(hls.recoverMediaError).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.ev === 'error').at(-1)?.p).toMatchObject({ fatal: false });
    hls.trigger(FakeHls.Events.ERROR, err);
    expect(hls.recoverMediaError).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.ev === 'error').at(-1)?.p).toMatchObject({ fatal: true });
  });

  it('passes non-fatal errors through unchanged', async () => {
    const { hls, events } = await setup();
    hls.trigger(FakeHls.Events.ERROR, { type: 'mediaError', details: 'bufferStalledError', fatal: false });
    expect(events.at(-1)).toEqual({ ev: 'error', p: { type: 'mediaError', detail: 'bufferStalledError', fatal: false, raw: expect.anything() } });
    expect(hls.recoverMediaError).not.toHaveBeenCalled();
  });

  it('emits stats every second from hls.latency, levels and video buffer', async () => {
    const { engine, hls, video, events } = await setup();
    Object.defineProperty(video, 'buffered', {
      value: { length: 1, start: () => 0, end: () => 12 },
    });
    Object.defineProperty(video, 'currentTime', { value: 10, writable: true });
    vi.advanceTimersByTime(1000);
    const s = events.filter((e) => e.ev === 'stats').at(-1)?.p as EngineEventMap['stats'];
    expect(s).toMatchObject({ latencyMs: 2500, bufferMs: 2000, bitrateKbps: 2500, level: 1, levels: 2 });
    hls.latency = Number.NaN;
    expect(engine.getStats().latencyMs).toBeNull();
  });

  it('seekToLive jumps to hls.liveSyncPosition', async () => {
    const { engine, video } = await setup();
    engine.seekToLive();
    expect(video.currentTime).toBe(42);
  });

  it('persists the bandwidth estimate on destroy and is idempotent', async () => {
    const { engine, hls } = await setup();
    engine.destroy();
    engine.destroy();
    expect(hls.destroy).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('livelab.bw')).toBe('1234000');
  });

  it('restores the stored bandwidth estimate when none is given', async () => {
    localStorage.setItem('livelab.bw', '2000000');
    const { hls } = await setup();
    expect((hls.config as { abrEwmaDefaultEstimate: number }).abrEwmaDefaultEstimate).toBe(2_000_000);
  });
});
