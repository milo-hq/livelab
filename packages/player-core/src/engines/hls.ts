import type Hls from 'hls.js';
import type { ErrorData, LevelSwitchedData } from 'hls.js';
import { createEmitter } from '../emitter.js';
import { bufferAheadMs, emptyStats, frameCounters } from '../types.js';
import type { EngineEventMap, EngineOptions, EngineStats, PlayerEngine } from '../types.js';
import { buildHlsConfig, readStoredBandwidth, storeBandwidth } from './hls-config.js';

const STATS_INTERVAL_MS = 1000;
/** A second fatal error of the same class within this window is reported as fatal. */
const RECOVERY_WINDOW_MS = 10_000;

/**
 * hls.js based engine for HLS / LL-HLS.
 *
 * `load()` resolves once hls.js is wired to the media element; `ready` fires when the manifest
 * is parsed. A fatal NETWORK error triggers one `startLoad()` retry, a fatal MEDIA error one
 * `recoverMediaError()`; if the same class of fatal error repeats within 10s it is surfaced as
 * `error{fatal:true}` so the controller can move on to the next pathway.
 */
export class HlsEngine implements PlayerEngine {
  readonly kind = 'hls' as const;

  private hls: Hls | null = null;
  private video: HTMLVideoElement | null = null;
  private readonly em = createEmitter<EngineEventMap>();
  private loaded = false;
  private destroyed = false;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private stats: EngineStats = emptyStats();
  private pendingSwitchReason: EngineEventMap['level_switch']['reason'] = 'abr';
  private lastRecovery: { network: number; media: number } = { network: -Infinity, media: -Infinity };
  private detachVideo: (() => void) | null = null;

  async load(video: HTMLVideoElement, src: string, opts: EngineOptions): Promise<void> {
    if (this.loaded) throw new Error('HlsEngine.load() may only be called once');
    this.loaded = true;
    this.video = video;

    const { default: HlsCtor } = await import('hls.js');
    if (this.destroyed) return;
    if (!HlsCtor.isSupported()) {
      const err = { type: 'unsupported', detail: 'mse_unsupported', fatal: true };
      this.em.emit('error', err);
      throw new Error('hls.js is not supported in this browser');
    }

    const effective: EngineOptions = opts.bandwidthEstimate
      ? opts
      : { ...opts, bandwidthEstimate: readStoredBandwidth() };
    const hls = new HlsCtor(buildHlsConfig(effective));
    this.hls = hls;
    const { Events } = HlsCtor;

    hls.on(Events.MANIFEST_PARSED, () => this.em.emit('ready', { kind: this.kind }));
    hls.on(Events.LEVEL_SWITCHED, (_e: string, data: LevelSwitchedData) => {
      const reason = this.pendingSwitchReason;
      this.pendingSwitchReason = 'abr';
      this.em.emit('level_switch', { level: data.level, bitrateKbps: this.levelBitrateKbps(data.level), reason });
    });
    hls.on(Events.ERROR, (_e: string, data: ErrorData) => this.handleError(HlsCtor, data));

    const onPlaying = () => this.em.emit('playing', {});
    video.addEventListener('playing', onPlaying);
    this.detachVideo = () => video.removeEventListener('playing', onPlaying);

    hls.loadSource(src);
    hls.attachMedia(video);

    this.statsTimer = setInterval(() => this.em.emit('stats', this.computeStats()), STATS_INTERVAL_MS);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.detachVideo?.();
    this.detachVideo = null;
    if (this.hls) {
      storeBandwidth(this.hls.bandwidthEstimate);
      this.hls.destroy();
      this.hls = null;
    }
    this.em.clear();
  }

  getStats(): EngineStats {
    return this.hls ? this.computeStats() : this.stats;
  }

  setLevel(level: number): void {
    if (!this.hls) return;
    this.pendingSwitchReason = 'manual';
    this.hls.currentLevel = level;
  }

  seekToLive(): void {
    const { hls, video } = this;
    if (!hls || !video) return;
    const live = hls.liveSyncPosition;
    if (live != null && Number.isFinite(live)) {
      video.currentTime = live;
      return;
    }
    const { buffered } = video;
    if (buffered.length > 0) video.currentTime = buffered.end(buffered.length - 1);
  }

  on<K extends keyof EngineEventMap>(ev: K, cb: (p: EngineEventMap[K]) => void): () => void {
    return this.em.on(ev, cb);
  }

  private levelBitrateKbps(level: number): number | null {
    const bitrate = this.hls?.levels[level]?.bitrate;
    return bitrate ? bitrate / 1000 : null;
  }

  private computeStats(): EngineStats {
    const { hls, video } = this;
    if (!hls || !video) return this.stats;
    const latency = hls.latency;
    const level = hls.currentLevel;
    this.stats = {
      latencyMs: Number.isFinite(latency) ? latency * 1000 : null,
      bufferMs: bufferAheadMs(video),
      bitrateKbps: this.levelBitrateKbps(level),
      level: level >= 0 ? level : null,
      levels: hls.levels.length,
      ...frameCounters(video),
      playbackRate: video.playbackRate,
    };
    return this.stats;
  }

  private handleError(HlsCtor: typeof Hls, data: ErrorData): void {
    const base = { type: String(data.type), detail: String(data.details), raw: data };
    if (!data.fatal || !this.hls) {
      this.em.emit('error', { ...base, fatal: false });
      return;
    }
    const now = Date.now();
    const { ErrorTypes } = HlsCtor;
    if (data.type === ErrorTypes.NETWORK_ERROR) {
      if (now - this.lastRecovery.network > RECOVERY_WINDOW_MS) {
        this.lastRecovery.network = now;
        this.em.emit('log', { level: 'warn', msg: `fatal network error ${data.details}; retrying startLoad()` });
        this.em.emit('error', { ...base, fatal: false });
        this.hls.startLoad();
        return;
      }
    } else if (data.type === ErrorTypes.MEDIA_ERROR) {
      if (now - this.lastRecovery.media > RECOVERY_WINDOW_MS) {
        this.lastRecovery.media = now;
        this.em.emit('log', { level: 'warn', msg: `fatal media error ${data.details}; calling recoverMediaError()` });
        this.em.emit('error', { ...base, fatal: false });
        this.hls.recoverMediaError();
        return;
      }
    }
    this.em.emit('error', { ...base, fatal: true });
  }
}
