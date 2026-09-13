import { createEmitter } from '../emitter.js';
import { bufferAheadMs, emptyStats, frameCounters } from '../types.js';
import type { EngineEventMap, EngineOptions, EngineStats, PlayerEngine } from '../types.js';

const STATS_INTERVAL_MS = 1000;

const MEDIA_ERROR_NAMES: Record<number, string> = {
  1: 'MEDIA_ERR_ABORTED',
  2: 'MEDIA_ERR_NETWORK',
  3: 'MEDIA_ERR_DECODE',
  4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
};

/**
 * Native `<video src="…m3u8">` engine for browsers without MSE (iOS Safari < 17.1).
 * No rendition control, no PDT access: latency is approximated by the forward buffer.
 */
export class NativeHlsEngine implements PlayerEngine {
  readonly kind = 'native-hls' as const;

  private video: HTMLVideoElement | null = null;
  private readonly em = createEmitter<EngineEventMap>();
  private loaded = false;
  private destroyed = false;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private stats: EngineStats = emptyStats();
  private detachVideo: (() => void) | null = null;

  async load(video: HTMLVideoElement, src: string, opts: EngineOptions): Promise<void> {
    if (this.loaded) throw new Error('NativeHlsEngine.load() may only be called once');
    this.loaded = true;
    this.video = video;

    const onMeta = () => this.em.emit('ready', { kind: this.kind });
    const onPlaying = () => this.em.emit('playing', {});
    const onError = () => {
      const err = video.error;
      const code = err?.code ?? 0;
      this.em.emit('error', { type: 'media', detail: MEDIA_ERROR_NAMES[code] ?? `MEDIA_ERR_${code}`, fatal: true, raw: err });
    };
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('error', onError);
    this.detachVideo = () => {
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('error', onError);
    };

    video.src = opts.requestTransform ? opts.requestTransform(src) : src;
    this.statsTimer = setInterval(() => this.em.emit('stats', this.computeStats()), STATS_INTERVAL_MS);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.detachVideo?.();
    this.detachVideo = null;
    if (this.video) {
      this.video.removeAttribute('src');
      try {
        this.video.load();
      } catch {
        // jsdom / detached elements may throw on load(); nothing to clean up.
      }
      this.video = null;
    }
    this.em.clear();
  }

  getStats(): EngineStats {
    return this.video ? this.computeStats() : this.stats;
  }

  /** The browser owns ABR for native HLS. */
  setLevel(_level: number): void {}

  seekToLive(): void {
    const video = this.video;
    if (!video) return;
    const { seekable, buffered } = video;
    const end = seekable.length > 0 ? seekable.end(seekable.length - 1) : buffered.length > 0 ? buffered.end(buffered.length - 1) : NaN;
    if (Number.isFinite(end)) video.currentTime = end;
  }

  on<K extends keyof EngineEventMap>(ev: K, cb: (p: EngineEventMap[K]) => void): () => void {
    return this.em.on(ev, cb);
  }

  private computeStats(): EngineStats {
    const video = this.video;
    if (!video) return this.stats;
    const bufferMs = bufferAheadMs(video);
    this.stats = {
      latencyMs: bufferMs,
      bufferMs,
      bitrateKbps: null,
      level: null,
      levels: 0,
      ...frameCounters(video),
      playbackRate: video.playbackRate,
    };
    return this.stats;
  }
}
