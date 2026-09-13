/**
 * Main-thread renderer: wires the canvas-agnostic core to the real DOM — `clientWidth/Height`,
 * `devicePixelRatio`, `requestAnimationFrame`, `ResizeObserver` and `visibilitychange`.
 */

import { createRendererCore, type FrameClock } from './renderer-core.js';
import type { DanmakuHandle, DanmakuOptions, RendererSize } from './types.js';

/** Read the canvas' CSS box and the device pixel ratio. */
export function readCanvasSize(canvas: HTMLCanvasElement): RendererSize {
  return {
    width: canvas.clientWidth || canvas.width || 1,
    height: canvas.clientHeight || canvas.height || 1,
    dpr: globalThis.devicePixelRatio || 1,
  };
}

export const domClock: FrameClock = {
  now: () => performance.now(),
  raf: (cb) => requestAnimationFrame(cb),
  caf: (handle) => cancelAnimationFrame(handle),
};

/**
 * Attach the browser lifecycle shared by the main-thread and worker renderers:
 *  - `ResizeObserver` (when available) → `onResize`
 *  - `document.visibilitychange`: hidden → pause + clear (queued items count as dropped);
 *    visible → resume. A hidden tab gets no frames anyway, so anything queued meanwhile
 *    would burst onto the screen when the user comes back — better to start fresh.
 * Returns a detach function.
 */
export function attachDomLifecycle(
  canvas: HTMLCanvasElement,
  handle: Pick<DanmakuHandle, 'pause' | 'resume' | 'clear'>,
  onResize: () => void,
): () => void {
  const doc = canvas.ownerDocument;
  const onVisibility = (): void => {
    if (doc.hidden) {
      handle.pause();
      handle.clear();
    } else {
      handle.resume();
    }
  };
  doc.addEventListener('visibilitychange', onVisibility);

  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(onResize);
    observer.observe(canvas);
  }

  return () => {
    doc.removeEventListener('visibilitychange', onVisibility);
    observer?.disconnect();
  };
}

/** Create a danmaku renderer drawing directly on `canvas` from the main thread. */
export function createDanmaku(canvas: HTMLCanvasElement, opts: DanmakuOptions = {}): DanmakuHandle {
  const core = createRendererCore(canvas, readCanvasSize(canvas), opts, domClock);
  const resize = (): void => core.resize(readCanvasSize(canvas));
  const detach = attachDomLifecycle(canvas, core, resize);

  return {
    emit: (item) => core.emit(item),
    pause: () => core.pause(),
    resume: () => core.resume(),
    resize,
    clear: () => core.clear(),
    setOptions: (o) => core.setOptions(o),
    destroy() {
      detach();
      core.destroy();
    },
    get stats() {
      return core.stats;
    },
  };
}
