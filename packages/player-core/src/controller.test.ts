import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pathway, PlayPolicy } from '@livelab/protocol';
import { createPlayerController, describePathway, selectPathways } from './controller.js';
import type { Capabilities } from './capabilities.js';
import { createEmitter } from './emitter.js';
import { emptyStats } from './types.js';
import type { EngineEventMap, EngineKind, EngineOptions, PlayerEngine } from './types.js';
import type { QoeEvent } from './qoe-probe.js';

const allCaps: Capabilities = { mse: true, managedMse: false, nativeHls: false, webrtc: true, isIOS: false, isSafari: false };
const pathways: Pathway[] = [
  { protocol: 'whep', url: 'http://m/demo/whep', cdn: 'local-rt', priority: 0 },
  { protocol: 'llhls', url: 'http://m/demo/index.m3u8', cdn: 'local-abr', priority: 1 },
  { protocol: 'llhls', url: 'http://cdn2/demo/index.m3u8', cdn: 'cdn-b', priority: 2 },
  { protocol: 'flv', url: 'http://srs/demo.flv', cdn: 'srs', priority: 3 },
];
const policy: PlayPolicy = { preferred: 'llhls', targetLatencySec: 2, maxStartupMs: 3000, stallLadder: ['seek_live', 'downgrade', 'switch_pathway'] };

describe('selectPathways', () => {
  it('filters unsupported protocols by capability', () => {
    const noRtc = { ...allCaps, webrtc: false };
    expect(selectPathways(pathways, policy, noRtc).map((p) => p.protocol)).toEqual(['llhls', 'llhls', 'flv']);
    const nativeOnly: Capabilities = { ...allCaps, mse: false, webrtc: false, nativeHls: true };
    expect(selectPathways(pathways, policy, nativeOnly).map((p) => p.cdn)).toEqual(['local-abr', 'cdn-b']);
    const nothing: Capabilities = { ...allCaps, mse: false, webrtc: false, nativeHls: false };
    expect(selectPathways(pathways, policy, nothing)).toEqual([]);
  });

  it('orders by force > preferred > priority', () => {
    expect(selectPathways(pathways, policy, allCaps).map(describePathway)).toEqual(['llhls@local-abr', 'llhls@cdn-b', 'whep@local-rt', 'flv@srs']);
    expect(selectPathways(pathways, policy, allCaps, 'flv').map(describePathway)).toEqual(['flv@srs', 'llhls@local-abr', 'llhls@cdn-b', 'whep@local-rt']);
    expect(selectPathways(pathways, { ...policy, preferred: 'whep' }, allCaps).map(describePathway)[0]).toBe('whep@local-rt');
  });

  it('does not mutate the input', () => {
    const copy = [...pathways];
    selectPathways(pathways, policy, allCaps);
    expect(pathways).toEqual(copy);
  });
});

// ---- fake engines --------------------------------------------------------------
class FakeEngine implements PlayerEngine {
  em = createEmitter<EngineEventMap>();
  loadedWith: { src: string; opts: EngineOptions } | null = null;
  destroy = vi.fn();
  setLevel = vi.fn();
  seekToLive = vi.fn();
  loadImpl: () => Promise<void> = async () => {};
  constructor(readonly kind: EngineKind) {}
  async load(_v: HTMLVideoElement, src: string, opts: EngineOptions) {
    this.loadedWith = { src, opts };
    await this.loadImpl();
  }
  getStats() {
    return emptyStats();
  }
  on<K extends keyof EngineEventMap>(ev: K, cb: (p: EngineEventMap[K]) => void) {
    return this.em.on(ev, cb);
  }
  ready() {
    this.em.emit('ready', { kind: this.kind });
  }
  fatal(detail = 'boom') {
    this.em.emit('error', { type: 'test', detail, fatal: true });
  }
}

function harness(
  opts: { pathways?: Pathway[]; policy?: PlayPolicy; caps?: Capabilities; forceProtocol?: 'whep' | 'llhls' | 'hls' | 'flv'; onCreate?: (e: FakeEngine) => void } = {},
) {
  const engines: FakeEngine[] = [];
  const video = document.createElement('video');
  Object.defineProperty(video, 'paused', { value: false, writable: true });
  Object.defineProperty(video, 'currentTime', { value: 10, writable: true });
  const controller = createPlayerController(video, {
    pathways: opts.pathways ?? pathways,
    policy: opts.policy ?? policy,
    caps: opts.caps ?? allCaps,
    forceProtocol: opts.forceProtocol,
    engineOptions: { bandwidthEstimate: 1e6 },
    createEngine: async (kind) => {
      const e = new FakeEngine(kind);
      engines.push(e);
      opts.onCreate?.(e);
      return e;
    },
  });
  const qoe: QoeEvent[] = [];
  controller.on('qoe', (e) => qoe.push(e));
  const changes: Array<{ index: number; engine: EngineKind; cdn: string }> = [];
  controller.on('pathway_change', (p) => changes.push({ index: p.index, engine: p.engine, cdn: p.pathway.cdn }));
  const recoveries = () => qoe.filter((e): e is Extract<QoeEvent, { name: 'recovery_action' }> => e.name === 'recovery_action');
  return { controller, engines, video, qoe, changes, recoveries };
}

describe('createPlayerController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts the first selected pathway with the policy latency and resolves on ready', async () => {
    const h = harness();
    const p = h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.engines).toHaveLength(1);
    expect(h.engines[0]!.kind).toBe('hls');
    expect(h.engines[0]!.loadedWith).toEqual({ src: 'http://m/demo/index.m3u8', opts: { bandwidthEstimate: 1e6, targetLatencySec: 2 } });
    expect(h.changes).toEqual([{ index: 0, engine: 'hls', cdn: 'local-abr' }]);
    h.engines[0]!.ready();
    await p;
    expect(h.controller.current()?.pathway.cdn).toBe('local-abr');
    expect(h.qoe[0]?.name).toBe('play_attempt');
  });

  it('uses NativeHlsEngine when only native HLS is available', async () => {
    const h = harness({ caps: { ...allCaps, mse: false, managedMse: false, nativeHls: true, webrtc: false } });
    const p = h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.engines[0]!.kind).toBe('native-hls');
    h.engines[0]!.ready();
    await p;
  });

  it('falls through to the next pathway on a fatal error during startup', async () => {
    const h = harness();
    const p = h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    h.engines[0]!.fatal();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.engines[0]!.destroy).toHaveBeenCalled();
    expect(h.engines).toHaveLength(2);
    expect(h.recoveries().at(-1)).toMatchObject({ action: 'switch_pathway', from: 'llhls@local-abr', to: 'llhls@cdn-b' });
    h.engines[1]!.fatal();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.recoveries().at(-1)).toMatchObject({ action: 'switch_protocol', from: 'llhls@cdn-b', to: 'whep@local-rt' });
    expect(h.engines[2]!.kind).toBe('whep');
    h.engines[2]!.ready();
    await p;
    expect(h.changes.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it('treats a missing ready within maxStartupMs*2 and a rejected load() as failures', async () => {
    const h = harness({
      onCreate: (e) => {
        if (e.kind === 'whep') {
          e.loadImpl = async () => {
            throw new Error('load failed');
          };
        }
      },
    });
    const p = h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5999);
    expect(h.engines).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.engines).toHaveLength(2);
    expect(h.recoveries().at(-1)).toMatchObject({ action: 'switch_pathway' });
    h.engines[1]!.fatal();
    await vi.advanceTimersByTimeAsync(0);
    // engine 2 is whep and its load() rejects → straight on to flv
    expect(h.engines).toHaveLength(4);
    expect(h.engines[3]!.kind).toBe('flv');
    h.engines[3]!.ready();
    await p;
    expect(h.controller.current()?.pathway.protocol).toBe('flv');
  });

  it('a manual switch during a failover walk supersedes it', async () => {
    const h = harness();
    await startPlaying(h);
    h.engines[0]!.fatal();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.engines[1]!.loadedWith?.src).toBe('http://cdn2/demo/index.m3u8');
    const manual = h.controller.switchPathway(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.engines[1]!.destroy).toHaveBeenCalled();
    expect(h.engines[2]!.kind).toBe('flv');
    // The superseded engine failing must not spawn another attempt.
    h.engines[1]!.fatal();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.engines).toHaveLength(3);
    h.engines[2]!.ready();
    await manual;
  });

  it('does not run the ladder for buffering while a switched pathway is still starting', async () => {
    const h = harness({ policy: { ...policy, stallLadder: ['switch_pathway'] } });
    await startPlaying(h);
    await stall(h);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.engines).toHaveLength(2);
    await stall(h);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.engines).toHaveLength(2);
    h.engines[1]!.ready();
    await stall(h);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.engines).toHaveLength(3);
  });

  it('rejects start() and reports a fatal controller error when every pathway fails', async () => {
    const h = harness({ pathways: pathways.slice(1, 3) });
    const p = h.controller.start();
    const rejected = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    h.engines[0]!.fatal();
    await vi.advanceTimersByTimeAsync(0);
    h.engines[1]!.fatal();
    await vi.advanceTimersByTimeAsync(0);
    expect(await rejected).toBeInstanceOf(Error);
    expect(h.qoe.filter((e) => e.name === 'error').at(-1)).toMatchObject({ type: 'controller', detail: 'all_pathways_failed', fatal: true });
    expect(h.qoe.at(-1)).toMatchObject({ name: 'end', reason: 'fatal' });
    expect(h.controller.current()).toBeNull();
  });

  it('rejects when no pathway is playable', async () => {
    const h = harness({ caps: { ...allCaps, mse: false, webrtc: false, nativeHls: false } });
    await expect(h.controller.start()).rejects.toThrow();
    expect(h.engines).toHaveLength(0);
  });

  async function startPlaying(h: ReturnType<typeof harness>) {
    const p = h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    h.engines[0]!.ready();
    await p;
    h.video.dispatchEvent(new Event('playing'));
  }
  async function stall(h: ReturnType<typeof harness>) {
    h.video.dispatchEvent(new Event('waiting'));
    await vi.advanceTimersByTimeAsync(200);
    h.video.dispatchEvent(new Event('playing'));
  }

  it('walks the stall ladder: seek_live → downgrade → switch_pathway, staying on the last rung', async () => {
    const h = harness();
    await startPlaying(h);
    const e0 = h.engines[0]!;

    await stall(h);
    expect(e0.seekToLive).toHaveBeenCalledTimes(1);
    expect(h.recoveries().at(-1)).toMatchObject({ action: 'seek_live', from: 'llhls@local-abr', to: 'llhls@local-abr' });

    await stall(h);
    expect(e0.setLevel).toHaveBeenCalledWith(0);
    expect(h.recoveries().at(-1)).toMatchObject({ action: 'downgrade' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(e0.setLevel).toHaveBeenLastCalledWith(-1);

    await stall(h);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.recoveries().at(-1)).toMatchObject({ action: 'switch_pathway', from: 'llhls@local-abr', to: 'llhls@cdn-b' });
    expect(h.engines).toHaveLength(2);
    h.engines[1]!.ready();
    await vi.advanceTimersByTimeAsync(0);
    h.video.dispatchEvent(new Event('playing'));

    // Last rung repeats: another stall switches again (protocol differs this time).
    await stall(h);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.recoveries().at(-1)).toMatchObject({ action: 'switch_protocol', from: 'llhls@cdn-b', to: 'whep@local-rt' });
  });

  it('nudges by 0.1s and resets the ladder after 60s without stalls', async () => {
    const h = harness({ policy: { ...policy, stallLadder: ['nudge', 'seek_live'] } });
    await startPlaying(h);
    await stall(h);
    expect(h.video.currentTime).toBeCloseTo(10.1);
    expect(h.recoveries().at(-1)).toMatchObject({ action: 'nudge' });
    await vi.advanceTimersByTimeAsync(61_000);
    await stall(h);
    expect(h.recoveries().at(-1)).toMatchObject({ action: 'nudge' });
    await stall(h);
    expect(h.recoveries().at(-1)).toMatchObject({ action: 'seek_live' });
  });

  it('switches pathways on a fatal error after startup and wraps around', async () => {
    const h = harness({ pathways: pathways.slice(1, 3) });
    await startPlaying(h);
    h.engines[0]!.fatal();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.engines).toHaveLength(2);
    h.engines[1]!.ready();
    await vi.advanceTimersByTimeAsync(0);
    h.engines[1]!.fatal();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.engines).toHaveLength(3);
    expect(h.changes.map((c) => c.index)).toEqual([0, 1, 0]);
  });

  it('switchPathway(i) moves to an explicit pathway and stop() tears everything down', async () => {
    const h = harness();
    await startPlaying(h);
    const p = h.controller.switchPathway(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.engines[1]!.kind).toBe('flv');
    expect(h.recoveries().at(-1)).toMatchObject({ action: 'switch_protocol', to: 'flv@srs' });
    h.engines[1]!.ready();
    await p;
    expect(h.controller.current()?.pathway.protocol).toBe('flv');
    h.controller.stop();
    expect(h.engines[1]!.destroy).toHaveBeenCalled();
    expect(h.controller.current()).toBeNull();
    expect(h.qoe.at(-1)).toMatchObject({ name: 'end', reason: 'user' });
  });

  it('forwards probe events on the qoe channel', async () => {
    const h = harness();
    await startPlaying(h);
    h.engines[0]!.em.emit('level_switch', { level: 1, bitrateKbps: 800, reason: 'abr' });
    expect(h.qoe.at(-1)).toMatchObject({ name: 'level_switch', level: 1 });
  });
});
