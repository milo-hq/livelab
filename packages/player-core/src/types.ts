/**
 * Engine contract shared by every playback engine (hls.js, mpegts.js, WHEP, native HLS).
 * Other packages (web app, telemetry) are written against these names — keep them stable.
 */

export type EngineKind = 'hls' | 'flv' | 'whep' | 'native-hls';

export interface EngineStats {
  /** Player-to-edge latency estimate; null when the engine cannot measure it. */
  latencyMs: number | null;
  /** Forward buffer ahead of the playhead. */
  bufferMs: number;
  bitrateKbps: number | null;
  /** Current rendition index (-1/null = auto or unknown). */
  level: number | null;
  /** Number of renditions available (0 when not applicable). */
  levels: number;
  droppedFrames: number;
  totalFrames: number;
  playbackRate: number;
}

export type EngineEventMap = {
  ready: { kind: EngineKind };
  playing: {};
  stall_start: {};
  stall_end: { durationMs: number };
  level_switch: { level: number; bitrateKbps: number | null; reason: 'abr' | 'manual' | 'recovery' };
  error: { type: string; detail: string; fatal: boolean; raw?: unknown };
  stats: EngineStats;
  log: { level: 'debug' | 'info' | 'warn' | 'error'; msg: string };
};

export type EngineEvent = keyof EngineEventMap;

export interface EngineOptions {
  /** Desired glass-to-glass latency; drives live-sync presets. */
  targetLatencySec: number;
  /** Initial rendition (-1 = auto). */
  startLevel?: number;
  /** Bandwidth estimate in bits/s used to seed ABR (e.g. restored from localStorage). */
  bandwidthEstimate?: number;
  cmcd?: { sessionId: string; contentId: string };
  /** Explicit worker URL (hls.js ESM builds do not inline the worker). */
  workerUrl?: string;
  /** Rewrites every media request URL (weak-network proxy, CDN steering). */
  requestTransform?: (url: string) => string;
}

export interface PlayerEngine {
  readonly kind: EngineKind;
  load(video: HTMLVideoElement, src: string, opts: EngineOptions): Promise<void>;
  destroy(): void;
  getStats(): EngineStats;
  /** -1 = auto. */
  setLevel(level: number): void;
  seekToLive(): void;
  on<K extends keyof EngineEventMap>(ev: K, cb: (p: EngineEventMap[K]) => void): () => void;
}

export function emptyStats(): EngineStats {
  return {
    latencyMs: null,
    bufferMs: 0,
    bitrateKbps: null,
    level: null,
    levels: 0,
    droppedFrames: 0,
    totalFrames: 0,
    playbackRate: 1,
  };
}

/** Forward buffer (ms) between the playhead and the end of the buffered range containing it. */
export function bufferAheadMs(video: HTMLVideoElement): number {
  const { buffered, currentTime } = video;
  if (!buffered || buffered.length === 0) return 0;
  for (let i = 0; i < buffered.length; i++) {
    const start = buffered.start(i);
    const end = buffered.end(i);
    if (currentTime >= start - 0.1 && currentTime <= end) {
      return Math.max(0, (end - currentTime) * 1000);
    }
  }
  return 0;
}

/** Dropped/total frame counters via `getVideoPlaybackQuality` (zero when unsupported). */
export function frameCounters(video: HTMLVideoElement): { droppedFrames: number; totalFrames: number } {
  const q = video.getVideoPlaybackQuality?.();
  if (!q) return { droppedFrames: 0, totalFrames: 0 };
  return { droppedFrames: q.droppedVideoFrames, totalFrames: q.totalVideoFrames };
}
