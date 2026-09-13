/**
 * Worker entry: owns the OffscreenCanvas and runs the renderer core with the worker's own
 * `requestAnimationFrame`. Only typed against the DOM lib, so the worker globals we need are
 * described by a minimal local interface instead of pulling in `lib.webworker`.
 */

import { createRendererCore, type FrameClock, type RendererCore } from './renderer-core.js';
import { STATS_INTERVAL_MS, type FromWorker, type ToWorker } from './worker-protocol.js';

interface WorkerScope {
  onmessage: ((ev: MessageEvent<ToWorker>) => void) | null;
  postMessage(msg: FromWorker): void;
  requestAnimationFrame?: (cb: (now: number) => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
  close(): void;
}

const scope = globalThis as unknown as WorkerScope;

/** Workers get rAF alongside OffscreenCanvas in modern engines; fall back to ~60Hz timers. */
const clock: FrameClock = scope.requestAnimationFrame
  ? {
      now: () => performance.now(),
      raf: (cb) => scope.requestAnimationFrame!(cb),
      caf: (h) => scope.cancelAnimationFrame?.(h),
    }
  : {
      now: () => performance.now(),
      raf: (cb) => setTimeout(() => cb(performance.now()), 16) as unknown as number,
      caf: (h) => clearTimeout(h),
    };

let core: RendererCore | null = null;
let statsTimer: ReturnType<typeof setInterval> | null = null;

scope.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    core = createRendererCore(msg.canvas, msg.size, msg.opts, clock);
    statsTimer = setInterval(() => {
      if (core) scope.postMessage({ type: 'stats', stats: core.stats });
    }, STATS_INTERVAL_MS);
    return;
  }
  if (!core) return;
  switch (msg.type) {
    case 'emit':
      core.emit(msg.item);
      break;
    case 'pause':
      core.pause();
      break;
    case 'resume':
      core.resume();
      break;
    case 'clear':
      core.clear();
      break;
    case 'resize':
      core.resize(msg.size);
      break;
    case 'setOptions':
      core.setOptions(msg.opts);
      break;
    case 'destroy':
      if (statsTimer !== null) clearInterval(statsTimer);
      core.destroy();
      core = null;
      scope.close();
      break;
  }
};
