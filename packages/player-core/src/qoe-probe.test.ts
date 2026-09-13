import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQoeProbe, type QoeEvent } from './qoe-probe.js';
import { createEmitter } from './emitter.js';
import { emptyStats } from './types.js';
import type { EngineEventMap, PlayerEngine } from './types.js';

function fakeEngine(kind: PlayerEngine['kind'] = 'hls') {
  const em = createEmitter<EngineEventMap>();
  const engine: PlayerEngine = {
    kind,
    load: vi.fn(async () => {}),
    destroy: vi.fn(),
    getStats: () => emptyStats(),
    setLevel: vi.fn(),
    seekToLive: vi.fn(),
    on: (ev, cb) => em.on(ev, cb),
  };
  return { engine, em };
}

describe('createQoeProbe', () => {
  let video: HTMLVideoElement;
  let events: QoeEvent[];
  let probe: ReturnType<typeof createQoeProbe>;
  const fire = (name: string) => video.dispatchEvent(new Event(name));
  const names = () => events.map((e) => e.name);

  beforeEach(() => {
    vi.useFakeTimers();
    video = document.createElement('video');
    Object.defineProperty(video, 'paused', { value: false, writable: true });
    Object.defineProperty(video, 'currentTime', { value: 0, writable: true });
    events = [];
    probe = createQoeProbe(video);
    probe.onEvent((e) => events.push(e));
  });
  afterEach(() => {
    probe.destroy();
    vi.useRealTimers();
  });

  it('measures TTFF from markPlayAttempt to the first playing event', () => {
    probe.markPlayAttempt();
    const { engine } = fakeEngine('whep');
    probe.attachEngine(engine);
    vi.advanceTimersByTime(850);
    fire('playing');
    expect(events[0]?.name).toBe('play_attempt');
    expect(events[1]).toMatchObject({ name: 'first_frame', ttffMs: 850, protocol: 'whep' });
    fire('playing');
    expect(names().filter((n) => n === 'first_frame')).toHaveLength(1);
  });

  it('falls back to timeupdate with currentTime > 0 for first frame', () => {
    probe.markPlayAttempt();
    vi.advanceTimersByTime(300);
    fire('timeupdate');
    expect(names()).not.toContain('first_frame');
    video.currentTime = 0.5;
    fire('timeupdate');
    expect(events.at(-1)).toMatchObject({ name: 'first_frame', ttffMs: 300 });
  });

  it('ignores waiting before the first frame', () => {
    probe.markPlayAttempt();
    fire('waiting');
    vi.advanceTimersByTime(5000);
    expect(names()).not.toContain('stall_start');
  });

  it('does not count a rebuffer shorter than minStallMs', () => {
    fire('playing');
    fire('waiting');
    vi.advanceTimersByTime(150);
    fire('playing');
    vi.advanceTimersByTime(1000);
    expect(names()).not.toContain('stall_start');
    expect(names()).not.toContain('stall_end');
  });

  it('emits stall_start once the threshold is crossed and stall_end with the full duration', () => {
    fire('playing');
    fire('waiting');
    vi.advanceTimersByTime(199);
    expect(names()).not.toContain('stall_start');
    vi.advanceTimersByTime(1);
    expect(events.at(-1)?.name).toBe('stall_start');
    vi.advanceTimersByTime(200);
    fire('playing');
    expect(events.at(-1)).toMatchObject({ name: 'stall_end', durationMs: 400 });
  });

  it('excludes the seeking window and paused state', () => {
    fire('playing');
    fire('seeking');
    fire('waiting');
    vi.advanceTimersByTime(1000);
    fire('seeked');
    fire('playing');
    expect(names()).not.toContain('stall_start');

    (video as { paused: boolean }).paused = true;
    fire('pause');
    fire('waiting');
    vi.advanceTimersByTime(1000);
    expect(names()).not.toContain('stall_start');
  });

  it('treats engine stall_start/stall_end like waiting/playing', () => {
    const { engine, em } = fakeEngine('whep');
    probe.attachEngine(engine);
    fire('playing');
    em.emit('stall_start', {});
    vi.advanceTimersByTime(300);
    expect(events.at(-1)?.name).toBe('stall_start');
    em.emit('stall_end', { durationMs: 300 });
    expect(events.at(-1)).toMatchObject({ name: 'stall_end', durationMs: 300 });
  });

  it('forwards engine errors and level switches', () => {
    const { engine, em } = fakeEngine();
    probe.attachEngine(engine);
    em.emit('error', { type: 'networkError', detail: 'fragLoadError', fatal: false });
    expect(events.at(-1)).toMatchObject({ name: 'error', type: 'networkError', detail: 'fragLoadError', fatal: false });
    em.emit('level_switch', { level: 2, bitrateKbps: 3000, reason: 'abr' });
    expect(events.at(-1)).toMatchObject({ name: 'level_switch', level: 2, bitrateKbps: 3000 });
  });

  it('detaches the previous engine when a new one is attached', () => {
    const a = fakeEngine();
    const b = fakeEngine('flv');
    probe.attachEngine(a.engine);
    probe.attachEngine(b.engine);
    a.em.emit('error', { type: 'x', detail: 'y', fatal: true });
    expect(names()).not.toContain('error');
  });

  it('emits heartbeats every 10s with playing/stalled time and latest stats', () => {
    const { engine, em } = fakeEngine();
    probe.attachEngine(engine);
    fire('playing');
    vi.advanceTimersByTime(4000);
    fire('waiting');
    vi.advanceTimersByTime(1000);
    fire('playing');
    em.emit('stats', { ...emptyStats(), latencyMs: 2100, bufferMs: 1500, bitrateKbps: 2500, droppedFrames: 3, totalFrames: 900 });
    vi.advanceTimersByTime(5000);
    const hb = events.filter((e) => e.name === 'heartbeat');
    expect(hb).toHaveLength(1);
    expect(hb[0]).toMatchObject({ playingMs: 9000, stalledMs: 1000, droppedFrames: 3, totalFrames: 900, bitrateKbps: 2500, latencyMs: 2100 });
    vi.advanceTimersByTime(10000);
    expect(events.filter((e) => e.name === 'heartbeat').at(-1)).toMatchObject({ playingMs: 10000, stalledMs: 0 });
  });

  it('emits latency_sample every 5s only when stats are available', () => {
    const { engine, em } = fakeEngine();
    probe.attachEngine(engine);
    vi.advanceTimersByTime(5000);
    expect(names()).not.toContain('latency_sample');
    em.emit('stats', { ...emptyStats(), latencyMs: 1800, bufferMs: 900 });
    vi.advanceTimersByTime(5000);
    expect(events.at(-1)).toMatchObject({ name: 'latency_sample', latencyMs: 1800, bufferMs: 900 });
  });

  it('records recovery actions and emits end once with watchMs', () => {
    probe.markPlayAttempt();
    probe.recordRecovery('seek_live', 'llhls@a', 'llhls@a');
    expect(events.at(-1)).toMatchObject({ name: 'recovery_action', action: 'seek_live', from: 'llhls@a', to: 'llhls@a' });
    vi.advanceTimersByTime(12_345);
    probe.end('user');
    probe.end('unload');
    const ends = events.filter((e) => e.name === 'end');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ watchMs: 12_345, reason: 'user' });
  });

  it('supports an injected clock', () => {
    let t = 1000;
    const p2 = createQoeProbe(video, { now: () => t });
    const ev: QoeEvent[] = [];
    p2.onEvent((e) => ev.push(e));
    p2.markPlayAttempt();
    t = 1600;
    fire('playing');
    expect(ev.at(-1)).toMatchObject({ name: 'first_frame', ts: 1600, ttffMs: 600 });
    p2.destroy();
  });
});
