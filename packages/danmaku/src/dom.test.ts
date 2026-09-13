import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDanmaku } from './dom.js';
import { createDanmakuWorker } from './worker.js';

function stubCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'clientWidth', { value: 800 });
  Object.defineProperty(canvas, 'clientHeight', { value: 200 });
  const ctx = new Proxy({ measureText: (t: string) => ({ width: t.length * 10 }) } as Record<string, unknown>, {
    get: (t, p: string) => (p in t ? t[p] : () => undefined),
    set: (t, p: string, v) => ((t[p] = v), true),
  });
  canvas.getContext = (() => ctx) as unknown as HTMLCanvasElement['getContext'];
  return canvas;
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('createDanmaku (DOM wrapper)', () => {
  let frames: FrameRequestCallback[];

  beforeEach(() => {
    frames = [];
    vi.stubGlobal('devicePixelRatio', 2);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setHidden(false);
  });

  it('sizes the backing store from clientWidth/Height and devicePixelRatio', () => {
    const canvas = stubCanvas();
    const d = createDanmaku(canvas);
    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(400);
    d.destroy();
  });

  it('pauses and flushes the queue when the tab is hidden, resumes when visible', () => {
    const canvas = stubCanvas();
    const d = createDanmaku(canvas);
    d.emit({ id: '1', text: 'hello' });
    setHidden(true);
    expect(d.stats.dropped).toBe(1);
    expect(d.stats.onScreen).toBe(0);
    frames.length = 0;
    setHidden(false);
    expect(frames.length).toBe(1); // a frame was scheduled again
    d.destroy();
  });

  it('stops listening after destroy', () => {
    const canvas = stubCanvas();
    const d = createDanmaku(canvas);
    d.destroy();
    d.emit({ id: '1', text: 'x' });
    setHidden(true);
    expect(d.stats.dropped).toBe(0);
  });
});

describe('createDanmakuWorker', () => {
  it('falls back to the main-thread renderer without OffscreenCanvas support', () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const canvas = stubCanvas();
    expect('transferControlToOffscreen' in canvas).toBe(false);
    const d = createDanmakuWorker(canvas);
    expect(d.emit({ id: '1', text: 'hi' })).toBe(true);
    expect(d.stats.emitted).toBe(1);
    d.destroy();
    vi.unstubAllGlobals();
  });
});
