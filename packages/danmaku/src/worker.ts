/**
 * Worker-mode renderer: moves drawing off the main thread with `OffscreenCanvas`.
 *
 * The main thread keeps only a thin proxy that forwards `DanmakuHandle` calls as messages and
 * caches the periodic `stats` reports. `emit` cannot know synchronously whether the worker's
 * rate limiter will accept the item, so it returns `true` whenever the message was sent.
 * Browsers without `transferControlToOffscreen` fall back to the main-thread renderer.
 */

import { attachDomLifecycle, createDanmaku, readCanvasSize } from './dom.js';
import type { DanmakuHandle, DanmakuOptions, DanmakuStats } from './types.js';
import type { FromWorker, ToWorker } from './worker-protocol.js';

export function supportsOffscreenCanvas(canvas: HTMLCanvasElement): boolean {
  return (
    typeof Worker !== 'undefined' &&
    typeof (canvas as { transferControlToOffscreen?: unknown }).transferControlToOffscreen === 'function'
  );
}

export function createDanmakuWorker(canvas: HTMLCanvasElement, opts: DanmakuOptions = {}): DanmakuHandle {
  if (!supportsOffscreenCanvas(canvas)) return createDanmaku(canvas, opts);

  // Vite/webpack-standard pattern: bundlers recognise `new Worker(new URL(..., import.meta.url))`
  // and emit the worker as its own chunk.
  const worker = new Worker(new URL('./danmaku.worker.ts', import.meta.url), { type: 'module' });
  const offscreen = canvas.transferControlToOffscreen();
  const send = (msg: ToWorker, transfer: Transferable[] = []): void => worker.postMessage(msg, transfer);

  let stats: DanmakuStats = { onScreen: 0, dropped: 0, emitted: 0 };
  worker.onmessage = (ev: MessageEvent<FromWorker>) => {
    if (ev.data.type === 'stats') stats = ev.data.stats;
  };

  send({ type: 'init', canvas: offscreen, size: readCanvasSize(canvas), opts }, [offscreen]);

  const handle: DanmakuHandle = {
    emit(item) {
      send({ type: 'emit', item });
      return true;
    },
    pause: () => send({ type: 'pause' }),
    resume: () => send({ type: 'resume' }),
    // Once control is transferred the canvas' backing size can only be set from the worker,
    // but its CSS box is still measured here.
    resize: () => send({ type: 'resize', size: readCanvasSize(canvas) }),
    clear: () => send({ type: 'clear' }),
    setOptions: (o) => send({ type: 'setOptions', opts: o }),
    destroy() {
      detach();
      send({ type: 'destroy' });
      worker.terminate();
    },
    get stats() {
      return { ...stats };
    },
  };

  const detach = attachDomLifecycle(canvas, handle, handle.resize);
  return handle;
}
