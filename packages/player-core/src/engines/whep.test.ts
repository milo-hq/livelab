import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WhepEngine } from './whep.js';
import { FakePeerConnection, fakeFetch, installFakeRtc } from '../test/fake-rtc.js';
import type { EngineEventMap } from '../types.js';

describe('WhepEngine', () => {
  let restore: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    restore = installFakeRtc();
  });
  afterEach(() => {
    restore();
    vi.useRealTimers();
  });

  async function setup(status = 201) {
    const fetch = fakeFetch((_u, init) =>
      init.method === 'DELETE' ? new Response(null, { status: 200 }) : new Response('answer', { status, headers: { Location: 'http://h/whep/1' } }),
    );
    const engine = new WhepEngine({ fetch });
    const video = document.createElement('video');
    const events: Array<{ ev: string; p: unknown }> = [];
    (['ready', 'playing', 'stall_start', 'stall_end', 'error', 'stats'] as const).forEach((ev) =>
      engine.on(ev, (p: EngineEventMap[typeof ev]) => events.push({ ev, p })),
    );
    const p = engine.load(video, 'http://h/whep', { targetLatencySec: 0.5, requestTransform: (u) => `${u}?x` });
    await vi.advanceTimersByTimeAsync(0);
    const pc = FakePeerConnection.instances.at(-1)!;
    pc.finishIceGathering();
    return { engine, video, events, pc, fetch, done: p };
  }

  it('connects via WHEP using the transformed URL and reports ready when connected', async () => {
    const { events, pc, fetch, done } = await setup();
    await done;
    expect(fetch.mock.calls[0]?.[0]).toBe('http://h/whep?x');
    pc.setConnectionState('connecting');
    expect(events.find((e) => e.ev === 'ready')).toBeUndefined();
    pc.setConnectionState('connected');
    expect(events).toContainEqual({ ev: 'ready', p: { kind: 'whep' } });
  });

  it('maps disconnected/connected to stall_start/stall_end and failed to a fatal error', async () => {
    const { events, pc, done } = await setup();
    await done;
    pc.setConnectionState('connected');
    pc.setConnectionState('disconnected');
    expect(events.at(-1)).toEqual({ ev: 'stall_start', p: {} });
    vi.advanceTimersByTime(700);
    pc.setConnectionState('connected');
    expect(events.at(-1)).toEqual({ ev: 'stall_end', p: { durationMs: 700 } });
    pc.setConnectionState('failed');
    expect(events.at(-1)).toEqual({ ev: 'error', p: { type: 'webrtc', detail: 'connection_failed', fatal: true } });
  });

  it('emits a fatal error and rejects load() when the WHEP request fails', async () => {
    const { events, done } = await setup(500);
    await expect(done).rejects.toThrow();
    expect(events.at(-1)).toMatchObject({ ev: 'error', p: { type: 'whep', detail: 'http_500', fatal: true } });
  });

  it('derives stats from inbound-rtp reports', async () => {
    const { engine, events, pc, done } = await setup();
    await done;
    pc.statsReport = [
      { type: 'inbound-rtp', kind: 'video', framesDropped: 2, framesDecoded: 120, jitterBufferDelay: 6, jitterBufferEmittedCount: 120, bytesReceived: 125_000, packetsLost: 1 },
      { type: 'inbound-rtp', kind: 'audio', bytesReceived: 5_000 },
    ];
    await vi.advanceTimersByTimeAsync(1000);
    pc.statsReport[0]!['bytesReceived'] = 250_000;
    await vi.advanceTimersByTimeAsync(1000);
    const s = events.filter((e) => e.ev === 'stats').at(-1)?.p as EngineEventMap['stats'];
    expect(s).toMatchObject({ latencyMs: 50, droppedFrames: 2, totalFrames: 120, bitrateKbps: 1000, level: null, levels: 0 });
    expect(engine.getStats()).toEqual(s);
  });

  it('destroy releases the WHEP resource and closes the peer connection idempotently', async () => {
    const { engine, pc, fetch, done } = await setup();
    await done;
    engine.destroy();
    engine.destroy();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch.mock.calls.some((c) => c[1]?.method === 'DELETE')).toBe(true);
    expect(pc.close).toHaveBeenCalledTimes(1);
  });
});
