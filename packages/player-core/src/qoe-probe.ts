import type { EngineStats, PlayerEngine } from './types.js';

export type QoeEvent =
  | { name: 'play_attempt'; ts: number }
  | { name: 'first_frame'; ts: number; ttffMs: number; protocol: string }
  | { name: 'stall_start'; ts: number }
  | { name: 'stall_end'; ts: number; durationMs: number }
  | { name: 'level_switch'; ts: number; level: number; bitrateKbps: number | null }
  | { name: 'latency_sample'; ts: number; latencyMs: number; bufferMs: number }
  | {
      name: 'heartbeat';
      ts: number;
      playingMs: number;
      stalledMs: number;
      droppedFrames: number;
      totalFrames: number;
      bitrateKbps: number | null;
      latencyMs: number | null;
    }
  | { name: 'error'; ts: number; type: string; detail: string; fatal: boolean }
  | { name: 'recovery_action'; ts: number; action: string; from: string; to: string }
  | { name: 'end'; ts: number; watchMs: number; reason: EndReason };

export type EndReason = 'user' | 'fatal' | 'unload';

export interface QoeProbeOptions {
  /** Rebuffers shorter than this are ignored (default 200ms). */
  minStallMs?: number;
  /** Heartbeat interval (default 10000ms). */
  heartbeatMs?: number;
  /** Clock override for tests. */
  now?: () => number;
}

export interface QoeProbe {
  /** Subscribes to engine events; replaces any previously attached engine (pathway switch). */
  attachEngine(e: PlayerEngine): void;
  /** Marks the moment playback was requested (TTFF origin). */
  markPlayAttempt(): void;
  onEvent(cb: (e: QoeEvent) => void): () => void;
  /** Records a controller recovery action into the event stream. */
  recordRecovery(action: string, from: string, to: string): void;
  /** Injects an error into the event stream (controller-level failures). */
  recordError(type: string, detail: string, fatal: boolean): void;
  /** Emits `end` exactly once. */
  end(reason: EndReason): void;
  destroy(): void;
}

const LATENCY_SAMPLE_MS = 5000;

/**
 * Computes QoE metrics from `<video>` events and engine events:
 * TTFF, stalls (≥ minStallMs, excluding pre-first-frame / seeking / paused), heartbeats with
 * playing/stalled time and frame counters, periodic latency samples, forwarded errors.
 */
export function createQoeProbe(video: HTMLVideoElement, opts: QoeProbeOptions = {}): QoeProbe {
  const minStallMs = opts.minStallMs ?? 200;
  const heartbeatMs = opts.heartbeatMs ?? 10_000;
  const now = opts.now ?? (() => Date.now());

  const listeners = new Set<(e: QoeEvent) => void>();
  const createdAt = now();
  let playAttemptAt: number | null = null;
  let firstFrameAt: number | null = null;
  let protocol = 'unknown';
  let latestStats: EngineStats | null = null;
  let ended = false;
  let destroyed = false;

  // Stall tracking. `stallWaitAt` is when buffering began; the stall is only reported once
  // it outlives `minStallMs`.
  let seeking = false;
  let stallWaitAt: number | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let inStall = false;

  // Accumulators for the heartbeat window.
  let playingSince: number | null = null;
  let playingMs = 0;
  let stalledMs = 0;

  let detachEngine: (() => void) | null = null;

  const emit = (e: QoeEvent) => {
    for (const cb of Array.from(listeners)) {
      try {
        cb(e);
      } catch (err) {
        console.error('[player-core] qoe listener error', err);
      }
    }
  };

  const flushPlaying = (t: number) => {
    if (playingSince != null) {
      playingMs += Math.max(0, t - playingSince);
      playingSince = t;
    }
  };

  const cancelPendingStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = null;
    if (!inStall) stallWaitAt = null;
  };

  const endStall = (t: number, durationOverride?: number) => {
    cancelPendingStall();
    if (inStall && stallWaitAt != null) {
      const durationMs = durationOverride ?? t - stallWaitAt;
      stalledMs += durationMs;
      emit({ name: 'stall_end', ts: t, durationMs });
    }
    inStall = false;
    stallWaitAt = null;
  };

  const onFirstFrame = (t: number) => {
    if (firstFrameAt != null) return;
    firstFrameAt = t;
    emit({ name: 'first_frame', ts: t, ttffMs: t - (playAttemptAt ?? createdAt), protocol });
  };

  const onPlaying = (durationOverride?: number) => {
    const t = now();
    onFirstFrame(t);
    endStall(t, durationOverride);
    if (playingSince == null) playingSince = t;
  };

  const onWaiting = () => {
    const t = now();
    flushPlaying(t);
    playingSince = null;
    if (firstFrameAt == null || seeking || video.paused || stallWaitAt != null) return;
    stallWaitAt = t;
    stallTimer = setTimeout(() => {
      stallTimer = null;
      inStall = true;
      emit({ name: 'stall_start', ts: now() });
    }, minStallMs);
  };

  const onSeeking = () => {
    seeking = true;
    if (!inStall) cancelPendingStall();
  };
  const onSeeked = () => {
    seeking = false;
  };
  const onPause = () => {
    const t = now();
    flushPlaying(t);
    playingSince = null;
    // A pause is not a stall: close any stall in progress.
    endStall(t);
  };
  const onTimeUpdate = () => {
    if (firstFrameAt == null && video.currentTime > 0) onPlaying();
  };

  const onVideoPlaying = () => onPlaying();
  video.addEventListener('playing', onVideoPlaying);
  video.addEventListener('waiting', onWaiting);
  video.addEventListener('seeking', onSeeking);
  video.addEventListener('seeked', onSeeked);
  video.addEventListener('pause', onPause);
  video.addEventListener('ended', onPause);
  video.addEventListener('timeupdate', onTimeUpdate);
  const detachVideo = () => {
    video.removeEventListener('playing', onVideoPlaying);
    video.removeEventListener('waiting', onWaiting);
    video.removeEventListener('seeking', onSeeking);
    video.removeEventListener('seeked', onSeeked);
    video.removeEventListener('pause', onPause);
    video.removeEventListener('ended', onPause);
    video.removeEventListener('timeupdate', onTimeUpdate);
  };

  const heartbeatTimer = setInterval(() => {
    const t = now();
    flushPlaying(t);
    emit({
      name: 'heartbeat',
      ts: t,
      playingMs,
      stalledMs,
      droppedFrames: latestStats?.droppedFrames ?? 0,
      totalFrames: latestStats?.totalFrames ?? 0,
      bitrateKbps: latestStats?.bitrateKbps ?? null,
      latencyMs: latestStats?.latencyMs ?? null,
    });
    playingMs = 0;
    stalledMs = 0;
  }, heartbeatMs);

  const latencyTimer = setInterval(() => {
    if (latestStats?.latencyMs == null) return;
    emit({ name: 'latency_sample', ts: now(), latencyMs: latestStats.latencyMs, bufferMs: latestStats.bufferMs });
  }, LATENCY_SAMPLE_MS);

  return {
    attachEngine(engine) {
      detachEngine?.();
      protocol = engine.kind;
      const offs = [
        engine.on('ready', (p) => {
          protocol = p.kind;
        }),
        engine.on('stats', (s) => {
          latestStats = s;
        }),
        engine.on('stall_start', onWaiting),
        engine.on('stall_end', (p) => onPlaying(p.durationMs)),
        engine.on('error', (e) => emit({ name: 'error', ts: now(), type: e.type, detail: e.detail, fatal: e.fatal })),
        engine.on('level_switch', (l) => emit({ name: 'level_switch', ts: now(), level: l.level, bitrateKbps: l.bitrateKbps })),
      ];
      detachEngine = () => offs.forEach((off) => off());
    },
    markPlayAttempt() {
      playAttemptAt = now();
      emit({ name: 'play_attempt', ts: playAttemptAt });
    },
    onEvent(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    recordRecovery(action, from, to) {
      emit({ name: 'recovery_action', ts: now(), action, from, to });
    },
    recordError(type, detail, fatal) {
      emit({ name: 'error', ts: now(), type, detail, fatal });
    },
    end(reason) {
      if (ended) return;
      ended = true;
      const t = now();
      flushPlaying(t);
      emit({ name: 'end', ts: t, watchMs: t - (playAttemptAt ?? createdAt), reason });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearInterval(heartbeatTimer);
      clearInterval(latencyTimer);
      cancelPendingStall();
      detachEngine?.();
      detachEngine = null;
      detachVideo();
      listeners.clear();
    },
  };
}
