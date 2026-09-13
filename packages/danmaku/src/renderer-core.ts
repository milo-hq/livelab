/**
 * Canvas-agnostic danmaku renderer.
 *
 * This module never touches `document` or `window`: it takes a canvas (HTML or Offscreen), an
 * explicit size, and injectable `now`/`raf`/`caf` functions. That lets the same code run on the
 * main thread, inside a Worker on an OffscreenCanvas, and in unit tests with a hand-driven clock.
 *
 * Geometry is in CSS pixels; the device pixel ratio is applied once per frame via
 * `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)`, so lane heights, font sizes and measured text widths
 * all stay in CSS px and the backing store is simply `dpr` times larger.
 */

import { freshLanes, pickLane, type LaneState } from './lanes.js';
import type { DanmakuHandle, DanmakuItem, DanmakuOptions, DanmakuStats, RendererSize } from './types.js';

export interface FrameClock {
  /** Monotonic clock in milliseconds (e.g. `performance.now`). */
  now(): number;
  /** Schedule `cb` for the next frame and return a cancel handle. */
  raf(cb: (now: number) => void): number;
  /** Cancel a frame scheduled by `raf`. */
  caf(handle: number): void;
}

/** Same surface as `DanmakuHandle`, except `resize` needs the size spelled out. */
export interface RendererCore extends Omit<DanmakuHandle, 'resize'> {
  resize(size: RendererSize): void;
}

/** The subset of the 2D context API we use — common to canvas and offscreen contexts. */
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

type Resolved = Required<DanmakuOptions>;

const DEFAULTS: Resolved = {
  laneHeight: 32,
  speed: 120,
  durationMs: 8000,
  maxPerSecond: 40,
  font: 'sans-serif',
  opacity: 1,
  area: 1,
};

const FONT_PX = { sm: 18, md: 24, lg: 32 } as const;

/** Largest frame delta we will simulate; anything slower is treated as a stall. */
const MAX_DT_MS = 100;
/** Cap on items admitted from the queue per frame, to bound per-frame work under bursts. */
const MAX_ADMIT_PER_FRAME = 10;
/** Width cache size; beyond this the oldest entries are evicted (Map keeps insertion order). */
const WIDTH_CACHE_MAX = 2000;

/** An item that has been admitted to a lane. `x` is derived from `enteredAt` every frame. */
interface ActiveItem {
  item: DanmakuItem;
  y: number;
  width: number;
  speed: number;
  /** Virtual-clock time (ms) at which the left edge was at x = stageWidth. */
  enteredAt: number;
  fontPx: number;
}

interface QueuedItem {
  item: DanmakuItem;
  width: number;
  fontPx: number;
}

export function createRendererCore(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  initialSize: RendererSize,
  opts: DanmakuOptions = {},
  clock: FrameClock,
): RendererCore {
  const maybeCtx = (canvas as { getContext(id: '2d'): Ctx2D | null }).getContext('2d');
  if (!maybeCtx) throw new Error('danmaku: 2D context unavailable');
  const ctx: Ctx2D = maybeCtx; // narrowed const so closures below see the non-null type

  let options: Resolved = { ...DEFAULTS, ...stripUndefined(opts) };
  let size: RendererSize = initialSize;
  let lanes: LaneState[] = [];

  const active: ActiveItem[] = [];
  /** Two FIFO queues: priority 1|2 are dequeued before priority 0. */
  const queueHigh: QueuedItem[] = [];
  const queueLow: QueuedItem[] = [];
  /** Real-clock timestamps of items admitted by `emit` within the last second. */
  const admittedAt: number[] = [];
  const widthCache = new Map<string, number>();

  const stats: DanmakuStats = { onScreen: 0, dropped: 0, emitted: 0 };

  /**
   * Virtual clock: advances by the (clamped) frame delta while running and freezes while
   * paused. Items and lanes are stamped with virtual time so pausing never causes a jump.
   */
  let vclock = 0;
  let last = clock.now();
  let rafHandle: number | null = null;
  let paused = false;
  let destroyed = false;

  // ---------------------------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------------------------

  function applySize(next: RendererSize): void {
    size = next;
    canvas.width = Math.max(1, Math.round(next.width * next.dpr));
    canvas.height = Math.max(1, Math.round(next.height * next.dpr));
    rebuildLanes();
  }

  /** Lane count = floor(height * area / laneHeight); existing lane states are kept by index. */
  function rebuildLanes(): void {
    const count = Math.max(1, Math.floor((size.height * options.area) / options.laneHeight));
    const next = freshLanes(count);
    for (let i = 0; i < Math.min(count, lanes.length); i++) next[i] = lanes[i]!;
    lanes = next;
  }

  // ---------------------------------------------------------------------------------------
  // Measuring
  // ---------------------------------------------------------------------------------------

  function fontString(fontPx: number): string {
    return `bold ${fontPx}px ${options.font}`;
  }

  function measure(text: string, fontPx: number): number {
    const key = `${options.font}|${fontPx}|${text}`;
    const hit = widthCache.get(key);
    if (hit !== undefined) return hit;
    ctx.font = fontString(fontPx);
    const width = ctx.measureText(text).width;
    if (widthCache.size >= WIDTH_CACHE_MAX) {
      // FIFO eviction: a Map iterates in insertion order, so the first key is the oldest.
      const oldest = widthCache.keys().next().value;
      if (oldest !== undefined) widthCache.delete(oldest);
    }
    widthCache.set(key, width);
    return width;
  }

  // ---------------------------------------------------------------------------------------
  // Admission
  // ---------------------------------------------------------------------------------------

  /**
   * Constant-duration model: an item must travel `stageWidth + width` px in `durationMs`,
   * so its speed is proportional to its width. `options.speed` acts as a floor so narrow
   * stages (phones) do not crawl.
   */
  function speedFor(width: number): number {
    return Math.max(options.speed, (size.width + width) / (options.durationMs / 1000));
  }

  /** Move queued items into free lanes, highest priority first, at most 10 per frame. */
  function admit(): void {
    let budget = MAX_ADMIT_PER_FRAME;
    for (const queue of [queueHigh, queueLow]) {
      while (budget > 0 && queue.length > 0) {
        const head = queue[0]!;
        const speed = speedFor(head.width);
        const lane = pickLane(lanes, vclock, size.width, head.width, speed, options.durationMs);
        if (lane === -1) return; // FIFO: do not let a later item jump ahead of this one
        queue.shift();
        budget--;
        lanes[lane] = { lastWidth: head.width, lastSpeed: speed, lastEnterAt: vclock };
        active.push({
          item: head.item,
          y: lane * options.laneHeight,
          width: head.width,
          speed,
          enteredAt: vclock,
          fontPx: head.fontPx,
        });
      }
    }
  }

  // ---------------------------------------------------------------------------------------
  // Frame loop
  // ---------------------------------------------------------------------------------------

  function frame(): void {
    rafHandle = null;
    if (destroyed || paused) return;

    const t = clock.now();
    let dt = t - last;
    last = t;
    if (dt > MAX_DT_MS) {
      // We stalled (tab throttled, GC pause, heavy layout). Whatever queued up during the stall
      // is stale by now — discard it rather than dumping a burst on screen — and only simulate
      // MAX_DT_MS so items do not teleport.
      stats.dropped += queueHigh.length + queueLow.length;
      queueHigh.length = 0;
      queueLow.length = 0;
      dt = MAX_DT_MS;
    }
    vclock += dt;

    admit();
    draw();
    stats.onScreen = active.length;

    rafHandle = clock.raf(frame);
  }

  function draw(): void {
    const { width: W, height: H, dpr } = size;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = options.opacity;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';

    // Iterate backwards so we can splice out finished items without skipping any.
    for (let i = active.length - 1; i >= 0; i--) {
      const a = active[i]!;
      const x = W - (a.speed * (vclock - a.enteredAt)) / 1000;
      if (x + a.width < 0) {
        active.splice(i, 1);
        continue;
      }
      const cy = a.y + options.laneHeight / 2;
      if (a.item.border) {
        const pad = 6;
        ctx.fillStyle = 'rgba(0,0,0,.45)';
        roundedRect(ctx, x - pad, a.y + 2, a.width + pad * 2, options.laneHeight - 4, 8);
        ctx.fill();
        ctx.strokeStyle = a.item.color ?? '#fff';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.lineWidth = 3;
      }
      ctx.font = fontString(a.fontPx);
      ctx.strokeStyle = 'rgba(0,0,0,.8)';
      ctx.strokeText(a.item.text, x, cy);
      ctx.fillStyle = a.item.color ?? '#fff';
      ctx.fillText(a.item.text, x, cy);
    }
  }

  function schedule(): void {
    if (rafHandle === null && !paused && !destroyed) rafHandle = clock.raf(frame);
  }

  // ---------------------------------------------------------------------------------------
  // Public handle
  // ---------------------------------------------------------------------------------------

  applySize(initialSize);
  schedule();

  return {
    emit(item) {
      if (destroyed) return false;
      const priority = item.priority ?? 0;
      const t = clock.now();
      // Sliding one-second window: forget admissions older than 1 s, then count the rest.
      while (admittedAt.length > 0 && admittedAt[0]! <= t - 1000) admittedAt.shift();
      if (priority !== 2 && admittedAt.length >= options.maxPerSecond) {
        stats.dropped++;
        return false;
      }
      admittedAt.push(t);
      stats.emitted++;
      const fontPx = FONT_PX[item.size ?? 'md'];
      const entry: QueuedItem = { item, width: measure(item.text, fontPx), fontPx };
      (priority > 0 ? queueHigh : queueLow).push(entry);
      return true;
    },

    pause() {
      if (paused) return;
      paused = true;
      if (rafHandle !== null) {
        clock.caf(rafHandle);
        rafHandle = null;
      }
    },

    resume() {
      if (!paused || destroyed) return;
      paused = false;
      last = clock.now(); // do not count the paused span as a frame delta
      schedule();
    },

    clear() {
      stats.dropped += queueHigh.length + queueLow.length;
      queueHigh.length = 0;
      queueLow.length = 0;
      active.length = 0;
      stats.onScreen = 0;
      lanes = freshLanes(lanes.length);
      if (!destroyed) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    },

    setOptions(next) {
      const fontChanged = next.font !== undefined && next.font !== options.font;
      options = { ...options, ...stripUndefined(next) };
      if (fontChanged) widthCache.clear();
      rebuildLanes();
    },

    resize(next) {
      applySize(next);
    },

    destroy() {
      if (destroyed) return;
      this.clear();
      destroyed = true;
      if (rafHandle !== null) {
        clock.caf(rafHandle);
        rafHandle = null;
      }
      widthCache.clear();
    },

    get stats() {
      return { ...stats };
    },
  };
}

/** Trace a rounded rectangle path (no fill/stroke) using arcTo for the corners. */
function roundedRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** `{ ...defaults, ...opts }` must not let an explicit `undefined` override a default. */
function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}
