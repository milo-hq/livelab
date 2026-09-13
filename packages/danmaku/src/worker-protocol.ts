/** Messages exchanged between `worker.ts` (main thread proxy) and `danmaku.worker.ts`. */

import type { DanmakuItem, DanmakuOptions, DanmakuStats, RendererSize } from './types.js';

export type ToWorker =
  | { type: 'init'; canvas: OffscreenCanvas; size: RendererSize; opts: DanmakuOptions }
  | { type: 'emit'; item: DanmakuItem }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'clear' }
  | { type: 'resize'; size: RendererSize }
  | { type: 'setOptions'; opts: Partial<DanmakuOptions> }
  | { type: 'destroy' };

export type FromWorker = { type: 'stats'; stats: DanmakuStats };

/** How often the worker reports `stats` back to the main thread. */
export const STATS_INTERVAL_MS = 500;
