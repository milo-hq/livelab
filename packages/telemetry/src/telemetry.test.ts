import { TelemetryBatch } from '@livelab/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSampled } from './context.js';
import { createTelemetry, type TelemetryOptions } from './telemetry.js';

const vitalHandlers: Array<(m: unknown) => void> = [];
vi.mock('web-vitals', () => {
  const reg = (cb: (m: unknown) => void) => vitalHandlers.push(cb);
  return { onLCP: reg, onINP: reg, onCLS: reg, onTTFB: reg, onFCP: reg };
});

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function okFetch(): FetchMock {
  return vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
}

/** Parse and schema-validate every batch a fetch mock received. */
function batches(f: FetchMock): TelemetryBatch[] {
  return f.mock.calls.map(([, init]) => TelemetryBatch.parse(JSON.parse(String(init?.body))));
}

const ctx = { player: 'hls.js', playerVer: '1.6.0', region: 'local', isp: 'local' };

function make(overrides: Partial<TelemetryOptions> = {}) {
  const fetchImpl = overrides.fetchImpl ?? okFetch();
  const t = createTelemetry({ endpoint: '/v1/telemetry', ctx, fetchImpl, ...overrides });
  return { t, fetchImpl: fetchImpl as FetchMock };
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vitalHandlers.length = 0;
  setHidden(false);
});

describe('context', () => {
  it('fills sessionId/os/browser/netType and keeps caller ctx', async () => {
    const { t, fetchImpl } = make();
    expect(t.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    t.track('video.play_attempt');
    await t.flush();
    const [b] = batches(fetchImpl);
    expect(b?.ctx).toMatchObject({ ...ctx, sessionId: t.sessionId, netType: 'unknown' });
    expect(typeof b?.ctx.os).toBe('string');
    expect(typeof b?.ctx.browser).toBe('string');
    t.destroy();
  });
});

describe('track / batching', () => {
  it('builds events with ts, numeric attrs, viewId and roomId', async () => {
    const { t, fetchImpl } = make({ now: () => 1234 });
    t.track('video.first_frame', { ttffMs: 812, protocol: 'llhls', ok: true }, { viewId: 'v1', roomId: 'demo' });
    await t.flush();
    expect(batches(fetchImpl)[0]?.events).toEqual([
      { name: 'video.first_frame', ts: 1234, viewId: 'v1', roomId: 'demo', attrs: { ttffMs: 812, protocol: 'llhls', ok: true } },
    ]);
    t.destroy();
  });

  it('flushes automatically once batchSize events are pending', async () => {
    const { t, fetchImpl } = make({ batchSize: 20 });
    for (let i = 0; i < 19; i++) t.track('video.play_attempt', { i });
    expect(fetchImpl).not.toHaveBeenCalled();
    t.track('video.play_attempt', { i: 19 });
    await vi.runAllTicks();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(batches(fetchImpl)[0]?.events).toHaveLength(20);
    t.destroy();
  });

  it('flushes on the interval timer', async () => {
    const { t, fetchImpl } = make({ flushIntervalMs: 5000 });
    t.track('video.stall_start');
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Nothing pending: the timer must not send empty batches.
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    t.destroy();
  });

  it('POSTs TelemetryBatch JSON with keepalive', async () => {
    const { t, fetchImpl } = make();
    t.track('video.play_attempt');
    await t.flush();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('/v1/telemetry');
    expect(init).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' }, keepalive: true });
    t.destroy();
  });

  it('coalesces concurrent flush() calls into one request', async () => {
    const { t, fetchImpl } = make();
    t.track('video.play_attempt');
    const a = t.flush();
    const b = t.flush();
    expect(a).toBe(b);
    await a;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    t.destroy();
  });

  it('splits oversized payloads so each keepalive body stays under 60 KB', async () => {
    const { t, fetchImpl } = make({ batchSize: 1000 });
    const blob = 'x'.repeat(7 * 1024);
    for (let i = 0; i < 10; i++) t.track('video.level_switch', { blob, i });
    await t.flush();
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
    for (const [, init] of fetchImpl.mock.calls) expect(String(init?.body).length).toBeLessThan(60 * 1024);
    const all = batches(fetchImpl).flatMap((b) => b.events.map((e) => e.attrs['i']));
    expect(all).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    t.destroy();
  });
});

describe('sampling', () => {
  it('is deterministic per session: a session keeps all or none of an event class', async () => {
    let keeper: ReturnType<typeof make> | undefined;
    let dropper: ReturnType<typeof make> | undefined;
    for (let i = 0; i < 300 && !(keeper && dropper); i++) {
      const m = make({ batchSize: 1000 });
      if (isSampled(m.t.sessionId, 'video.heartbeat', 0.2)) keeper ??= m;
      else dropper ??= m;
      if (m !== keeper && m !== dropper) m.t.destroy();
    }
    expect(keeper && dropper).toBeTruthy();
    for (let i = 0; i < 10; i++) {
      keeper!.t.track('video.heartbeat', { i });
      dropper!.t.track('video.heartbeat', { i });
    }
    await keeper!.t.flush();
    await dropper!.t.flush();
    expect(batches(keeper!.fetchImpl)[0]?.events).toHaveLength(10);
    expect(dropper!.fetchImpl).not.toHaveBeenCalled();
    keeper!.t.destroy();
    dropper!.t.destroy();
  });

  it('keeps ~20% of sessions across 1000 synthetic session ids', () => {
    let kept = 0;
    for (let i = 0; i < 1000; i++) if (isSampled(`sid-${i}-${i * 7919}`, 'video.latency_sample', 0.2)) kept++;
    expect(kept / 1000).toBeGreaterThanOrEqual(0.12);
    expect(kept / 1000).toBeLessThanOrEqual(0.28);
  });

  it('honours custom rates and never samples must-deliver events', async () => {
    const { t, fetchImpl } = make({ sampleRates: { 'video.play_attempt': 0, 'video.first_frame': 0, 'video.error': 0 } });
    t.track('video.play_attempt');
    t.track('video.first_frame');
    t.track('video.error', { fatal: false });
    await t.flush();
    expect(batches(fetchImpl)[0]?.events.map((e) => e.name)).toEqual(['video.first_frame', 'video.error']);
    t.destroy();
  });
});

describe('page lifecycle', () => {
  it('flushes with keepalive when the page becomes hidden', async () => {
    const { t, fetchImpl } = make();
    t.track('video.heartbeat_like_but_kept');
    setHidden(true);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.runAllTicks();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ keepalive: true });
    t.destroy();
  });

  it('does not flush when visibility changes to visible', async () => {
    const { t, fetchImpl } = make();
    t.track('video.play_attempt');
    setHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.runAllTicks();
    expect(fetchImpl).not.toHaveBeenCalled();
    t.destroy();
  });

  it('flushes on pagehide', async () => {
    const { t, fetchImpl } = make();
    t.track('video.play_attempt');
    window.dispatchEvent(new Event('pagehide'));
    await vi.runAllTicks();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    t.destroy();
  });

  it('destroy() stops the timer, removes listeners and flushes once more', async () => {
    const { t, fetchImpl } = make();
    t.track('video.end');
    t.destroy();
    await vi.runAllTicks();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    t.track('video.play_attempt'); // ignored after destroy
    await vi.advanceTimersByTimeAsync(20_000);
    window.dispatchEvent(new Event('pagehide'));
    await vi.runAllTicks();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('queues and delivery guarantees', () => {
  it('sends events tracked during an in-flight flush after destroy()', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      await gate;
      return new Response(null, { status: 204 });
    });
    const { t } = make({ fetchImpl });
    t.track('video.play_attempt');
    const first = t.flush();
    t.track('video.end');
    t.destroy();
    release();
    await first;
    await vi.runAllTicks();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(batches(fetchImpl)[1]?.events[0]?.name).toBe('video.end');
  });

  it('drops new normal events beyond maxQueue but keeps must-deliver events', async () => {
    const { t, fetchImpl } = make({ maxQueue: 2, batchSize: 1000 });
    t.track('video.heartbeat_x', { i: 0 });
    t.track('video.heartbeat_x', { i: 1 });
    t.track('video.heartbeat_x', { i: 2 }); // dropped: queue full
    t.track('video.first_frame', { ttffMs: 500 });
    t.track('video.error', { fatal: false, errType: 'network' });
    t.track('video.end');
    await t.flush();
    const names = batches(fetchImpl)[0]?.events.map((e) => e.name);
    // Must-deliver events are sent first, then the surviving normal events.
    expect(names).toEqual(['video.first_frame', 'video.error', 'video.end', 'video.heartbeat_x', 'video.heartbeat_x']);
    expect(console.warn).toHaveBeenCalledTimes(1);
    t.destroy();
  });

  it('retries a failed batch once, then drops it', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError('network down');
    });
    const { t } = make({ fetchImpl });
    t.track('video.play_attempt', { i: 1 });
    await t.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await t.flush(); // retry
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(batches(fetchImpl)[1]?.events[0]?.attrs).toEqual({ i: 1 });
    await t.flush(); // dropped: nothing left to send
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledTimes(1);
    t.destroy();
  });

  it('treats non-2xx responses as failures too', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('nope', { status: 500 }));
    const { t } = make({ fetchImpl });
    t.track('video.play_attempt');
    await t.flush();
    await t.flush();
    await t.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    t.destroy();
  });

  it('survives a missing fetch implementation', async () => {
    const original = globalThis.fetch;
    // @ts-expect-error simulate an environment without fetch
    globalThis.fetch = undefined;
    const t = createTelemetry({ endpoint: '/x', ctx });
    t.track('video.play_attempt');
    await expect(t.flush()).resolves.toBeUndefined();
    t.destroy();
    globalThis.fetch = original;
  });
});

describe('logs and enrichment', () => {
  it('log() stores ring lines and mirrors to console.debug when debug', () => {
    const dbg = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { t } = make({ debug: true, now: () => 42 });
    t.log('info', 'hello');
    expect(dbg).toHaveBeenCalledWith('[telemetry] info hello');
    t.destroy();
  });

  it('attaches the last 50 ring lines and the resource waterfall to fatal errors', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(100_000);
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { name: 'https://cdn/live/seg.m4s', startTime: 99_000, duration: 12, transferSize: 3000, responseStatus: 404 },
      { name: 'https://cdn/app.js', startTime: 99_000, duration: 1, transferSize: 1 },
    ] as unknown as PerformanceEntryList);
    const { t, fetchImpl } = make({ now: () => 7 });
    for (let i = 0; i < 60; i++) t.log('debug', `line ${i}`);
    t.track('video.error', { fatal: true, errType: 'media' });
    t.track('video.error', { fatal: false, errType: 'network' });
    await t.flush();
    const [fatal, nonFatal] = batches(fetchImpl)[0]!.events;
    const log = String(fatal?.attrs['log']);
    expect(log.split('\n')).toHaveLength(50);
    expect(log.startsWith('7 debug line 10')).toBe(true);
    expect(log.endsWith('7 debug line 59')).toBe(true);
    expect(JSON.parse(String(fatal?.attrs['resources']))).toEqual([
      { name: 'https://cdn/live/seg.m4s', duration: 12, transferSize: 3000, status: 404 },
    ]);
    expect(fatal?.attrs['errType']).toBe('media');
    expect(nonFatal?.attrs).not.toHaveProperty('log');
    expect(nonFatal?.attrs).not.toHaveProperty('resources');
    t.destroy();
  });

  it('caps attachments at 8 KB', async () => {
    const { t, fetchImpl } = make();
    for (let i = 0; i < 50; i++) t.log('debug', 'y'.repeat(1000));
    t.track('video.error', { fatal: true });
    await t.flush();
    const log = String(batches(fetchImpl)[0]!.events[0]!.attrs['log']);
    expect(log.length).toBeLessThanOrEqual(8 * 1024);
    t.destroy();
  });

  it('reportIssue() bypasses sampling, enriches and flushes immediately', async () => {
    const { t, fetchImpl } = make({ sampleRates: { 'video.report_issue': 0 } });
    t.log('warn', 'stalled 3 times');
    await t.reportIssue('video is frozen', { roomId: 'demo' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const ev = batches(fetchImpl)[0]!.events[0]!;
    expect(ev.name).toBe('video.report_issue');
    expect(ev.attrs['description']).toBe('video is frozen');
    expect(ev.attrs['roomId']).toBe('demo');
    expect(String(ev.attrs['log'])).toContain('warn stalled 3 times');
    expect(typeof ev.attrs['resources']).toBe('string');
    t.destroy();
  });
});

describe('web vitals', () => {
  it('captureVitals() forwards metrics as web.vital events', async () => {
    const { t, fetchImpl } = make();
    t.captureVitals();
    expect(vitalHandlers).toHaveLength(5);
    vitalHandlers[0]!({ name: 'LCP', value: 1234.5, rating: 'good', id: 'v1-1', delta: 1234.5, entries: [] });
    await t.flush();
    expect(batches(fetchImpl)[0]?.events[0]).toMatchObject({
      name: 'web.vital',
      attrs: { name: 'LCP', value: 1234.5, rating: 'good', id: 'v1-1' },
    });
    t.destroy();
  });
});
