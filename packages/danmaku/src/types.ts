/** One bullet comment to render. */
export interface DanmakuItem {
  id: string;
  text: string;
  /** CSS color of the text fill. Default `#fff`. */
  color?: string;
  /** Font size preset: sm 18px, md 24px (default), lg 32px. */
  size?: 'sm' | 'md' | 'lg';
  /**
   * 0 = normal chat (default), 1 = highlighted (moderators, mentions),
   * 2 = gifts/system — always admitted, bypasses the per-second rate limit.
   * Higher priority is dequeued first when lanes are scarce.
   */
  priority?: 0 | 1 | 2;
  /** Draw a rounded, translucent box behind the text (used for gifts). */
  border?: boolean;
}

export interface DanmakuOptions {
  /** Height of one lane in CSS px. Default 32. */
  laneHeight?: number;
  /**
   * Minimum scroll speed in px/s. Default 120. Items normally cross the stage in `durationMs`
   * (so wider items move faster); this floor keeps very narrow stages from crawling.
   */
  speed?: number;
  /** Time one item takes to cross the whole stage. Default 8000. */
  durationMs?: number;
  /** Client-side rate limit: normal items admitted per sliding second. Default 40. */
  maxPerSecond?: number;
  /** CSS font-family list. Default `sans-serif`. */
  font?: string;
  /** Global alpha for everything drawn. Default 1. */
  opacity?: number;
  /** Fraction of the canvas height (from the top) used for lanes. Default 1. */
  area?: 0.25 | 0.5 | 0.75 | 1;
}

export interface DanmakuStats {
  /** Items currently moving across the stage. */
  onScreen: number;
  /** Items rejected by the rate limiter or discarded from the backlog. */
  dropped: number;
  /** Items accepted by `emit`. */
  emitted: number;
}

/** Public control surface shared by the main-thread and worker renderers. */
export interface DanmakuHandle {
  /** Queue an item. Returns false if it was dropped by the rate limiter. */
  emit(item: DanmakuItem): boolean;
  pause(): void;
  resume(): void;
  /** Re-read the canvas' CSS size and device pixel ratio. */
  resize(): void;
  /** Remove everything on screen and in the queue (queued items count as dropped). */
  clear(): void;
  setOptions(opts: Partial<DanmakuOptions>): void;
  destroy(): void;
  readonly stats: DanmakuStats;
}

/** Explicit canvas geometry: CSS size plus the device pixel ratio for the backing store. */
export interface RendererSize {
  width: number;
  height: number;
  dpr: number;
}
