import { beforeEach, describe, expect, it } from 'vitest';
import { createRendererCore, type RendererCore } from './renderer-core.js';
import type { DanmakuItem } from './types.js';

/**
 * A recording 2D context: `measureText` returns 10px per character, every other method is a
 * no-op that logs its name and arguments so tests can assert on what was drawn.
 */
function stubContext() {
  const calls: { name: string; args: unknown[] }[] = [];
  const measured: string[] = [];
  const target: Record<string, unknown> = {
    measureText(text: string) {
      measured.push(text);
      return { width: text.length * 10 };
    },
  };
  const ctx = new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      return (...args: unknown[]) => {
        calls.push({ name: prop, args });
      };
    },
    set(t, prop: string, value) {
      t[prop] = value;
      return true;
    },
  });
  return { ctx, calls, measured, drawn: () => calls.filter((c) => c.name === 'fillText') };
}

/** Manual frame scheduler so tests can step time deterministically. */
function scheduler() {
  let t = 0;
  let pending: ((now: number) => void)[] = [];
  return {
    now: () => t,
    raf: (cb: (now: number) => void) => {
      pending.push(cb);
      return pending.length;
    },
    caf: () => {
      pending = [];
    },
    /** Advance the clock by `ms` and run every callback scheduled before this tick. */
    tick(ms: number) {
      t += ms;
      const run = pending;
      pending = [];
      for (const cb of run) cb(t);
    },
    pendingCount: () => pending.length,
  };
}

const item = (id: string, extra: Partial<DanmakuItem> = {}): DanmakuItem => ({
  id,
  text: `msg-${id}`,
  ...extra,
});

describe('createRendererCore', () => {
  let stub: ReturnType<typeof stubContext>;
  let sched: ReturnType<typeof scheduler>;
  let canvas: { width: number; height: number; getContext: () => unknown };

  const make = (opts = {}, size = { width: 1000, height: 320, dpr: 1 }): RendererCore =>
    createRendererCore(canvas as unknown as HTMLCanvasElement, size, opts, sched);

  beforeEach(() => {
    stub = stubContext();
    sched = scheduler();
    canvas = { width: 0, height: 0, getContext: () => stub.ctx };
  });

  it('sizes the backing store by dpr', () => {
    make({}, { width: 300, height: 100, dpr: 2 });
    expect(canvas.width).toBe(600);
    expect(canvas.height).toBe(200);
  });

  it('rate-limits normal items but always admits priority 2', () => {
    const r = make({ maxPerSecond: 3 });
    expect(r.emit(item('a'))).toBe(true);
    expect(r.emit(item('b'))).toBe(true);
    expect(r.emit(item('c'))).toBe(true);
    expect(r.emit(item('d'))).toBe(false);
    expect(r.emit(item('e', { priority: 1 }))).toBe(false);
    expect(r.emit(item('gift', { priority: 2 }))).toBe(true);
    expect(r.stats).toEqual({ onScreen: 0, dropped: 2, emitted: 4 });
  });

  it('opens the rate-limit window again after one second', () => {
    const r = make({ maxPerSecond: 1 });
    expect(r.emit(item('a'))).toBe(true);
    expect(r.emit(item('b'))).toBe(false);
    sched.tick(16); // frame: admits 'a'
    sched.tick(1000);
    expect(r.emit(item('c'))).toBe(true);
  });

  it('dequeues higher priority items first when lanes are scarce', () => {
    // 32px tall canvas with 32px lanes → exactly one lane.
    const r = make({ laneHeight: 32 }, { width: 1000, height: 32, dpr: 1 });
    r.emit(item('low'));
    r.emit(item('high', { priority: 1 }));
    sched.tick(16);
    const drawn = stub.drawn().map((c) => c.args[0]);
    expect(drawn).toEqual(['msg-high']);
    expect(r.stats.onScreen).toBe(1);
  });

  it('drops the queued backlog when a frame is later than 100ms', () => {
    const r = make();
    r.emit(item('a'));
    r.emit(item('b'));
    r.emit(item('c'));
    sched.tick(500);
    expect(r.stats.onScreen).toBe(0);
    expect(r.stats.dropped).toBe(3);
  });

  it('admits queued items on a normal frame, one per free lane', () => {
    // 64px tall → 2 lanes. Three items queued, so one has to wait for the next frame.
    const r = make({ laneHeight: 32 }, { width: 1000, height: 64, dpr: 1 });
    r.emit(item('a'));
    r.emit(item('b'));
    r.emit(item('c'));
    sched.tick(16);
    expect(r.stats.onScreen).toBe(2);
  });

  it('honours area when computing lane count', () => {
    const r = make({ laneHeight: 32, area: 0.5 }, { width: 1000, height: 128, dpr: 1 });
    for (let i = 0; i < 4; i++) r.emit(item(String(i)));
    sched.tick(16);
    expect(r.stats.onScreen).toBe(2);
  });

  it('pause stops frames and drawing; resume continues', () => {
    const r = make();
    r.emit(item('a'));
    sched.tick(16);
    expect(stub.drawn()).toHaveLength(1);
    r.pause();
    expect(sched.pendingCount()).toBe(0);
    sched.tick(16);
    expect(stub.drawn()).toHaveLength(1);
    r.resume();
    sched.tick(16);
    expect(stub.drawn()).toHaveLength(2);
  });

  it('freezes motion while paused', () => {
    const r = make();
    r.emit(item('a'));
    sched.tick(16); // admitted at x = 1000
    sched.tick(16);
    const before = stub.drawn().at(-1)!.args[1] as number;
    r.pause();
    sched.tick(5000);
    r.resume();
    sched.tick(16);
    const after = stub.drawn().at(-1)!.args[1] as number;
    // One 16ms frame of movement at most, not five seconds worth.
    expect(before - after).toBeLessThan(10);
  });

  it('removes items once they leave the stage', () => {
    const r = make({ durationMs: 1000 });
    r.emit(item('a'));
    sched.tick(16);
    expect(r.stats.onScreen).toBe(1);
    for (let i = 0; i < 12; i++) sched.tick(100); // 1.2 s of virtual time
    expect(r.stats.onScreen).toBe(0);
  });

  it('caches measured text widths', () => {
    const r = make();
    r.emit(item('a', { text: 'same' }));
    r.emit(item('b', { text: 'same' }));
    r.emit(item('c', { text: 'other' }));
    expect(stub.measured).toEqual(['same', 'other']);
  });

  it('clear() discards the queue as dropped and empties the stage', () => {
    const r = make();
    r.emit(item('a'));
    sched.tick(16);
    r.emit(item('b'));
    r.clear();
    expect(r.stats).toEqual({ onScreen: 0, dropped: 1, emitted: 2 });
  });

  it('draws stroke + fill text with the item color and a box for bordered items', () => {
    const r = make();
    r.emit(item('gift', { color: '#f0f', border: true, priority: 2 }));
    sched.tick(16);
    const names = stub.calls.map((c) => c.name);
    expect(names.indexOf('strokeText')).toBeGreaterThan(-1);
    expect(names.indexOf('strokeText')).toBeLessThan(names.indexOf('fillText'));
    expect(names).toContain('arcTo'); // rounded box path
    expect((stub.ctx as { fillStyle: string }).fillStyle).toBe('#f0f');
  });

  it('emit returns false after destroy', () => {
    const r = make();
    r.destroy();
    expect(r.emit(item('a'))).toBe(false);
    expect(sched.pendingCount()).toBe(0);
  });
});
