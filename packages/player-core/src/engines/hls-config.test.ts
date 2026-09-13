// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { buildHlsConfig } from './hls-config.js';

describe('buildHlsConfig (pure, no DOM)', () => {
  it('derives LL-HLS live sync presets from targetLatencySec', () => {
    const c = buildHlsConfig({ targetLatencySec: 2 });
    expect(c.lowLatencyMode).toBe(true);
    expect(c.liveSyncDuration).toBe(2);
    expect(c.liveMaxLatencyDuration).toBe(6);
    expect(c.maxLiveSyncPlaybackRate).toBe(1.5);
    expect(c.backBufferLength).toBe(30);
    expect(c.maxBufferLength).toBe(30);
    expect(c.enableWorker).toBe(true);
    expect(c.workerPath).toBeNull();
    expect(c.startFragPrefetch).toBe(true);
    expect(c.startLevel).toBe(-1);
    expect(c.abrEwmaDefaultEstimate).toBe(500_000);
    expect(c.testBandwidth).toBe(true);
    expect(c.cmcd).toBeUndefined();
    expect(c.xhrSetup).toBeUndefined();
    expect(c.fetchSetup).toBeUndefined();
  });

  it('seeds ABR from a bandwidth estimate and disables the bandwidth test', () => {
    const c = buildHlsConfig({ targetLatencySec: 3, bandwidthEstimate: 3e6, startLevel: 1, workerUrl: '/hls.worker.js' });
    expect(c.abrEwmaDefaultEstimate).toBe(3e6);
    expect(c.testBandwidth).toBe(false);
    expect(c.startLevel).toBe(1);
    expect(c.workerPath).toBe('/hls.worker.js');
  });

  it('enables CMCD v2 with session/content ids', () => {
    const c = buildHlsConfig({ targetLatencySec: 2, cmcd: { sessionId: 's1', contentId: 'room-1' } });
    expect(c.cmcd).toMatchObject({ sessionId: 's1', contentId: 'room-1', version: 2, useHeaders: false });
  });

  it('routes every request through requestTransform via fetchSetup and xhrSetup', () => {
    const transform = vi.fn((u: string) => `https://proxy.local/?u=${encodeURIComponent(u)}`);
    const c = buildHlsConfig({ targetLatencySec: 2, requestTransform: transform });
    expect(typeof c.fetchSetup).toBe('function');
    expect(typeof c.xhrSetup).toBe('function');

    const req = c.fetchSetup!(
      { url: 'https://cdn/x.m3u8', responseType: 'text', type: 'manifest' } as never,
      { method: 'GET', headers: new Headers({ Range: 'bytes=0-1' }) },
    ) as Request;
    expect(req.url).toBe('https://proxy.local/?u=https%3A%2F%2Fcdn%2Fx.m3u8');
    expect(req.headers.get('Range')).toBe('bytes=0-1');

    const open = vi.fn();
    void c.xhrSetup!({ open, readyState: 0 } as unknown as XMLHttpRequest, 'https://cdn/seg.m4s', {} as never);
    expect(open).toHaveBeenCalledWith('GET', 'https://proxy.local/?u=https%3A%2F%2Fcdn%2Fseg.m4s', true);
  });
});
