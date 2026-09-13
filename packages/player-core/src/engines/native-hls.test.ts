import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeHlsEngine } from './native-hls.js';
import type { EngineEventMap } from '../types.js';

describe('NativeHlsEngine', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function setup() {
    const video = document.createElement('video');
    const engine = new NativeHlsEngine();
    const events: Array<{ ev: string; p: unknown }> = [];
    (['ready', 'playing', 'error', 'stats'] as const).forEach((ev) =>
      engine.on(ev, (p: EngineEventMap[typeof ev]) => events.push({ ev, p })),
    );
    await engine.load(video, 'https://cdn/live.m3u8', { targetLatencySec: 3, requestTransform: (u) => `${u}?p=1` });
    return { video, engine, events };
  }

  it('sets the (transformed) src and reports ready on loadedmetadata', async () => {
    const { video, events } = await setup();
    expect(video.getAttribute('src')).toBe('https://cdn/live.m3u8?p=1');
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(events).toContainEqual({ ev: 'ready', p: { kind: 'native-hls' } });
    video.dispatchEvent(new Event('playing'));
    expect(events).toContainEqual({ ev: 'playing', p: {} });
  });

  it('reports media errors as fatal', async () => {
    const { video, events } = await setup();
    Object.defineProperty(video, 'error', { value: { code: 4, message: 'src not supported' } });
    video.dispatchEvent(new Event('error'));
    expect(events.at(-1)).toEqual({ ev: 'error', p: { type: 'media', detail: 'MEDIA_ERR_SRC_NOT_SUPPORTED', fatal: true, raw: expect.anything() } });
  });

  it('computes stats from the buffer each second and seeks to the live edge', async () => {
    const { video, engine, events } = await setup();
    Object.defineProperty(video, 'buffered', { value: { length: 1, start: () => 0, end: () => 8 } });
    Object.defineProperty(video, 'currentTime', { value: 5, writable: true });
    vi.advanceTimersByTime(1000);
    expect(events.filter((e) => e.ev === 'stats').at(-1)?.p).toMatchObject({ latencyMs: 3000, bufferMs: 3000, level: null, levels: 0 });
    engine.seekToLive();
    expect(video.currentTime).toBe(8);
    engine.destroy();
    engine.destroy();
    expect(video.hasAttribute('src')).toBe(false);
  });
});
