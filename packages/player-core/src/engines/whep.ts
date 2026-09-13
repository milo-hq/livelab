import { createEmitter } from '../emitter.js';
import { emptyStats } from '../types.js';
import type { EngineEventMap, EngineOptions, EngineStats, PlayerEngine } from '../types.js';
import { WhepClient, WhepError, type WhepClientOptions } from './whep-client.js';

const STATS_INTERVAL_MS = 1000;

interface InboundRtpStats {
  type: string;
  kind?: string;
  framesDropped?: number;
  framesDecoded?: number;
  jitterBufferDelay?: number;
  jitterBufferEmittedCount?: number;
  bytesReceived?: number;
  packetsLost?: number;
}

/**
 * WebRTC (WHEP) engine for the sub-second interactive path.
 * `ready` is reported when the peer connection reaches `connected`; `disconnected`/`connected`
 * transitions map to stall_start/stall_end, `failed` is fatal. Stats come from `inbound-rtp`.
 */
export class WhepEngine implements PlayerEngine {
  readonly kind = 'whep' as const;

  private client: WhepClient | null = null;
  private readonly em = createEmitter<EngineEventMap>();
  private loaded = false;
  private destroyed = false;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private stats: EngineStats = emptyStats();
  private lastBytes: { bytes: number; at: number } | null = null;
  private stallStartedAt: number | null = null;
  private readySent = false;
  private detach: (() => void) | null = null;

  constructor(private readonly clientOptions: WhepClientOptions = {}) {}

  async load(video: HTMLVideoElement, src: string, opts: EngineOptions): Promise<void> {
    if (this.loaded) throw new Error('WhepEngine.load() may only be called once');
    this.loaded = true;

    const endpoint = opts.requestTransform ? opts.requestTransform(src) : src;
    const client = new WhepClient(endpoint, this.clientOptions);
    this.client = client;
    const { pc } = client;

    const onState = () => this.handleConnectionState(pc.connectionState);
    const onPlaying = () => this.em.emit('playing', {});
    pc.addEventListener('connectionstatechange', onState);
    video.addEventListener('playing', onPlaying);
    this.detach = () => {
      pc.removeEventListener('connectionstatechange', onState);
      video.removeEventListener('playing', onPlaying);
    };

    this.statsTimer = setInterval(() => {
      void this.pollStats(video);
    }, STATS_INTERVAL_MS);

    try {
      await client.connect(video);
    } catch (err) {
      if (!this.destroyed) {
        const detail = err instanceof WhepError ? `http_${err.status}` : 'offer_failed';
        this.em.emit('error', { type: 'whep', detail, fatal: true, raw: err });
      }
      throw err;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.detach?.();
    this.detach = null;
    if (this.client) {
      void this.client.close();
      this.client = null;
    }
    this.em.clear();
  }

  getStats(): EngineStats {
    return this.stats;
  }

  /** Single rendition from the SFU; simulcast selection is out of scope. */
  setLevel(_level: number): void {}

  /** WebRTC playback is always at the live edge. */
  seekToLive(): void {}

  on<K extends keyof EngineEventMap>(ev: K, cb: (p: EngineEventMap[K]) => void): () => void {
    return this.em.on(ev, cb);
  }

  private handleConnectionState(state: RTCPeerConnectionState): void {
    switch (state) {
      case 'connected':
        if (!this.readySent) {
          this.readySent = true;
          this.em.emit('ready', { kind: this.kind });
        }
        if (this.stallStartedAt != null) {
          this.em.emit('stall_end', { durationMs: Date.now() - this.stallStartedAt });
          this.stallStartedAt = null;
        }
        break;
      case 'disconnected':
        if (this.stallStartedAt == null) {
          this.stallStartedAt = Date.now();
          this.em.emit('stall_start', {});
        }
        break;
      case 'failed':
        this.em.emit('error', { type: 'webrtc', detail: 'connection_failed', fatal: true });
        break;
      default:
        break;
    }
  }

  private async pollStats(video: HTMLVideoElement): Promise<void> {
    const pc = this.client?.pc;
    if (!pc) return;
    let report: RTCStatsReport;
    try {
      report = await pc.getStats();
    } catch {
      return;
    }
    if (this.destroyed) return;

    const inbound: InboundRtpStats[] = [];
    report.forEach((s: InboundRtpStats) => {
      if (s.type === 'inbound-rtp') inbound.push(s);
    });
    const bytes = inbound.reduce((sum, s) => sum + (s.bytesReceived ?? 0), 0);
    const v = inbound.find((s) => s.kind === 'video') ?? null;

    const now = Date.now();
    let bitrateKbps: number | null = this.stats.bitrateKbps;
    if (this.lastBytes && now > this.lastBytes.at) {
      bitrateKbps = ((bytes - this.lastBytes.bytes) * 8) / (now - this.lastBytes.at);
    }
    this.lastBytes = { bytes, at: now };

    const emitted = v?.jitterBufferEmittedCount ?? 0;
    const latencyMs = v && emitted > 0 && v.jitterBufferDelay != null ? (v.jitterBufferDelay / emitted) * 1000 : null;

    this.stats = {
      latencyMs,
      bufferMs: latencyMs ?? 0,
      bitrateKbps,
      level: null,
      levels: 0,
      droppedFrames: v?.framesDropped ?? 0,
      totalFrames: v?.framesDecoded ?? 0,
      playbackRate: video.playbackRate,
    };
    this.em.emit('stats', this.stats);
  }
}
