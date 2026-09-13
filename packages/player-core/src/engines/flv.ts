import type Mpegts from 'mpegts.js';
import { createEmitter } from '../emitter.js';
import { bufferAheadMs, emptyStats } from '../types.js';
import type { EngineEventMap, EngineOptions, EngineStats, PlayerEngine } from '../types.js';

type MpegtsModule = typeof Mpegts;
type MpegtsPlayer = ReturnType<MpegtsModule['createPlayer']>;

interface StatisticsInfo {
  speed?: number; // KB/s
  droppedFrames?: number;
  decodedFrames?: number;
}

/**
 * mpegts.js based engine for HTTP-FLV (desktop low-latency path, 1–3s).
 *
 * mpegts.js exposes no per-request URL hook, so `requestTransform` is applied once to the
 * stream URL. `STATISTICS_INFO` (every ~600ms) is converted to the standard stats shape;
 * latency is approximated by the forward buffer because FLV carries no wall-clock timestamps.
 */
export class FlvEngine implements PlayerEngine {
  readonly kind = 'flv' as const;

  private player: MpegtsPlayer | null = null;
  private video: HTMLVideoElement | null = null;
  private readonly em = createEmitter<EngineEventMap>();
  private loaded = false;
  private destroyed = false;
  private stats: EngineStats = emptyStats();
  private timeoutRetried = false;
  private detachVideo: (() => void) | null = null;

  async load(video: HTMLVideoElement, src: string, opts: EngineOptions): Promise<void> {
    if (this.loaded) throw new Error('FlvEngine.load() may only be called once');
    this.loaded = true;
    this.video = video;

    const { default: mpegts } = await import('mpegts.js');
    if (this.destroyed) return;
    if (!mpegts.isSupported() || !mpegts.getFeatureList().mseLivePlayback) {
      this.em.emit('error', { type: 'unsupported', detail: 'mse_live_unsupported', fatal: true });
      throw new Error('mpegts.js live playback is not supported in this browser');
    }

    const url = opts.requestTransform ? opts.requestTransform(src) : src;
    const player = mpegts.createPlayer(
      { type: 'flv', isLive: true, url },
      {
        enableWorker: true,
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: opts.targetLatencySec,
        liveBufferLatencyMinRemain: 0.5,
        liveSync: true,
        liveSyncMaxLatency: opts.targetLatencySec,
        autoCleanupSourceBuffer: true,
      },
    );
    this.player = player;

    player.on(mpegts.Events.MEDIA_INFO, () => this.em.emit('ready', { kind: this.kind }));
    player.on(mpegts.Events.STATISTICS_INFO, (info: StatisticsInfo) => this.em.emit('stats', this.computeStats(info)));
    player.on(mpegts.Events.ERROR, (type: string, detail: string, info: unknown) => this.handleError(mpegts, type, detail, info));

    const onPlaying = () => this.em.emit('playing', {});
    video.addEventListener('playing', onPlaying);
    this.detachVideo = () => video.removeEventListener('playing', onPlaying);

    player.attachMediaElement(video);
    player.load();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.detachVideo?.();
    this.detachVideo = null;
    if (this.player) {
      try {
        this.player.unload();
        this.player.detachMediaElement();
      } finally {
        this.player.destroy();
        this.player = null;
      }
    }
    this.em.clear();
  }

  getStats(): EngineStats {
    return this.video ? this.computeStats() : this.stats;
  }

  /** Single-rendition protocol: nothing to switch. */
  setLevel(_level: number): void {}

  seekToLive(): void {
    const video = this.video;
    if (!video) return;
    const { buffered } = video;
    if (buffered.length === 0) return;
    // Keep `liveBufferLatencyMinRemain` (0.5s) of buffer so the jump does not immediately stall.
    const end = buffered.end(buffered.length - 1);
    video.currentTime = Math.max(buffered.start(buffered.length - 1), end - 0.5);
  }

  on<K extends keyof EngineEventMap>(ev: K, cb: (p: EngineEventMap[K]) => void): () => void {
    return this.em.on(ev, cb);
  }

  private computeStats(info?: StatisticsInfo): EngineStats {
    const video = this.video;
    if (!video) return this.stats;
    const bufferMs = bufferAheadMs(video);
    this.stats = {
      latencyMs: bufferMs,
      bufferMs,
      bitrateKbps: info?.speed != null ? info.speed * 8 : this.stats.bitrateKbps,
      level: null,
      levels: 0,
      droppedFrames: info?.droppedFrames ?? this.stats.droppedFrames,
      totalFrames: info?.decodedFrames ?? this.stats.totalFrames,
      playbackRate: video.playbackRate,
    };
    return this.stats;
  }

  private handleError(mpegts: MpegtsModule, type: string, detail: string, info: unknown): void {
    const base = { type, detail, raw: info };
    const { ErrorTypes, ErrorDetails } = mpegts;
    if (type === ErrorTypes.NETWORK_ERROR && detail === ErrorDetails.NETWORK_TIMEOUT && !this.timeoutRetried && this.player) {
      // One reconnect attempt for a stalled connection before giving up on this pathway.
      this.timeoutRetried = true;
      this.em.emit('log', { level: 'warn', msg: 'network timeout; reloading stream once' });
      this.em.emit('error', { ...base, fatal: false });
      this.player.unload();
      this.player.load();
      return;
    }
    const fatal = type === ErrorTypes.NETWORK_ERROR || type === ErrorTypes.MEDIA_ERROR;
    this.em.emit('error', { ...base, fatal });
  }
}
