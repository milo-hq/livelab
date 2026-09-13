import { afterEach, describe, expect, it, vi } from 'vitest';
import { snapshotResources } from './resources.js';

function entry(name: string, startTime: number, extra: Record<string, unknown> = {}) {
  return { name, startTime, duration: 42, transferSize: 1000, entryType: 'resource', ...extra };
}

describe('snapshotResources', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps only media-related entries from the recent window', () => {
    vi.spyOn(performance, 'now').mockReturnValue(100_000);
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      entry('https://cdn/live/index.m3u8?x=1', 90_000),
      entry('https://cdn/live/seg1.m4s', 95_000, { responseStatus: 200 }),
      entry('https://cdn/live/seg0.m4s', 10_000), // too old
      entry('https://cdn/app/main.js', 99_000), // not media
      entry('https://cdn/live/whep', 99_500),
      entry('https://cdn/live/clip.mp4', 99_600),
      entry('https://cdn/live/x.ts', 99_700),
      entry('https://cdn/live/x.flv', 99_800),
      entry('https://cdn/live/x.tsx', 99_900), // .ts must not match .tsx
    ] as unknown as PerformanceEntryList);

    const out = snapshotResources(60_000);
    expect(out.map((r) => r.name)).toEqual([
      'https://cdn/live/index.m3u8?x=1',
      'https://cdn/live/seg1.m4s',
      'https://cdn/live/whep',
      'https://cdn/live/clip.mp4',
      'https://cdn/live/x.ts',
      'https://cdn/live/x.flv',
    ]);
    expect(out[1]).toEqual({ name: 'https://cdn/live/seg1.m4s', duration: 42, transferSize: 1000, status: 200 });
    expect(out[0]).not.toHaveProperty('status');
  });

  it('returns [] when the Performance API is unavailable', () => {
    vi.spyOn(performance, 'getEntriesByType').mockImplementation(() => {
      throw new Error('nope');
    });
    expect(snapshotResources()).toEqual([]);
  });
});
