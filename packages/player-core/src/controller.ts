import type { Pathway, PlayPolicy, Protocol, RecoveryAction } from '@livelab/protocol';
import { detectCapabilities, type Capabilities } from './capabilities.js';
import { createEngine as defaultCreateEngine } from './create-engine.js';
import { createEmitter } from './emitter.js';
import { createQoeProbe, type QoeEvent, type QoeProbe } from './qoe-probe.js';
import type { EngineKind, EngineOptions, PlayerEngine } from './types.js';

export interface ControllerOptions {
  pathways: Pathway[];
  policy: PlayPolicy;
  caps?: Capabilities;
  forceProtocol?: Protocol;
  engineOptions: Omit<EngineOptions, 'targetLatencySec'>;
  createEngine?: (kind: EngineKind) => Promise<PlayerEngine>;
}

export interface PathwayChange {
  index: number;
  pathway: Pathway;
  engine: EngineKind;
}

export interface ControllerEventMap {
  pathway_change: PathwayChange;
  qoe: QoeEvent;
}

export interface PlayerController {
  /** Walks the selected pathways in order; resolves when one reaches `ready`, rejects when all fail. */
  start(): Promise<void>;
  stop(): void;
  current(): { pathway: Pathway; engine: PlayerEngine } | null;
  /** Index into the selected (ordered) pathway list. */
  switchPathway(i: number): Promise<void>;
  probe: QoeProbe;
  on<K extends keyof ControllerEventMap>(ev: K, cb: (p: ControllerEventMap[K]) => void): () => void;
}

/** Human-readable pathway label used in QoE events, e.g. `llhls@local-abr`. */
export function describePathway(p: Pathway): string {
  return `${p.protocol}@${p.cdn}`;
}

function isSupported(protocol: Protocol, caps: Capabilities): boolean {
  switch (protocol) {
    case 'whep':
      return caps.webrtc;
    case 'flv':
      return caps.mse || caps.managedMse;
    case 'llhls':
    case 'hls':
      return caps.mse || caps.managedMse || caps.nativeHls;
    default:
      return false;
  }
}

/**
 * Pure: drops pathways the browser cannot play and orders the rest by
 * forced protocol > policy.preferred > priority (lower first).
 */
export function selectPathways(pathways: Pathway[], policy: PlayPolicy, caps: Capabilities, force?: Protocol): Pathway[] {
  const rank = (p: Pathway) => (p.protocol === force ? 0 : 1) * 2 + (p.protocol === policy.preferred ? 0 : 1);
  return pathways
    .filter((p) => isSupported(p.protocol, caps))
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p) - rank(b.p) || a.p.priority - b.p.priority || a.i - b.i)
    .map(({ p }) => p);
}

export function engineKindFor(protocol: Protocol, caps: Capabilities): EngineKind {
  switch (protocol) {
    case 'whep':
      return 'whep';
    case 'flv':
      return 'flv';
    default:
      return caps.mse || caps.managedMse ? 'hls' : 'native-hls';
  }
}

const LADDER_RESET_MS = 60_000;
const DOWNGRADE_RESTORE_MS = 30_000;
const NUDGE_SEC = 0.1;

/**
 * Orchestrates engines over a list of pathways: capability-based selection, startup fallback
 * chain, post-startup failover, and a stall recovery ladder driven by the QoE probe.
 */
export function createPlayerController(video: HTMLVideoElement, opts: ControllerOptions): PlayerController {
  const caps = opts.caps ?? detectCapabilities();
  const createEngine = opts.createEngine ?? defaultCreateEngine;
  const ordered = selectPathways(opts.pathways, opts.policy, caps, opts.forceProtocol);
  const probe = createQoeProbe(video);
  const em = createEmitter<ControllerEventMap>();

  let currentIndex = -1;
  let engine: PlayerEngine | null = null;
  let started = false;
  let stopped = false;
  /** Incremented on every switch/stop so stale async work can bail out. */
  let generation = 0;
  let ladderIndex = 0;
  let lastStallAt = -Infinity;
  let restoreLevelTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while a pathway is loading and has not reported `ready` yet. */
  let settling = false;

  const pathwayAt = (i: number): Pathway => {
    const p = ordered[i];
    if (!p) throw new Error(`Pathway index ${i} out of range (0..${ordered.length - 1})`);
    return p;
  };

  const teardownEngine = () => {
    if (restoreLevelTimer) clearTimeout(restoreLevelTimer);
    restoreLevelTimer = null;
    engine?.destroy();
    engine = null;
  };

  type AttemptResult = 'ok' | 'failed' | 'superseded';

  /**
   * Loads pathway `i` and waits for `ready`. `failed` covers a fatal error, a rejected
   * `load()`, or no `ready` within `maxStartupMs * 2`; `superseded` means another
   * switch/stop happened meanwhile and the caller must not keep walking.
   */
  const attempt = (i: number): Promise<AttemptResult> => {
    const gen = ++generation;
    teardownEngine();
    currentIndex = i;
    settling = true;
    const pathway = pathwayAt(i);
    const kind = engineKindFor(pathway.protocol, caps);

    return new Promise<AttemptResult>((resolve) => {
      void (async () => {
        let e: PlayerEngine;
        try {
          e = await createEngine(kind);
        } catch {
          if (gen === generation) {
            settling = false;
            probe.recordError('controller', `engine_create_failed:${kind}`, true);
          }
          resolve(gen === generation ? 'failed' : 'superseded');
          return;
        }
        if (gen !== generation) {
          e.destroy();
          resolve('superseded');
          return;
        }
        engine = e;
        probe.attachEngine(e);
        em.emit('pathway_change', { index: i, pathway, engine: kind });

        let settled = false;
        const timer = setTimeout(() => finish(false), opts.policy.maxStartupMs * 2);
        const offs: Array<() => void> = [];
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          offs.forEach((off) => off());
          if (gen !== generation) {
            resolve('superseded');
            return;
          }
          settling = false;
          if (ok) {
            // Post-startup fatal errors fail over to the next pathway (wrapping around).
            e.on('error', (err) => {
              if (err.fatal && gen === generation) void switchTo(nextIndex(i, false), 'failover');
            });
          }
          resolve(ok ? 'ok' : 'failed');
        };
        offs.push(e.on('ready', () => finish(true)));
        offs.push(e.on('error', (err) => err.fatal && finish(false)));

        try {
          await e.load(video, pathway.url, { ...opts.engineOptions, targetLatencySec: opts.policy.targetLatencySec });
        } catch {
          finish(false);
        }
      })();
    });
  };

  const nextIndex = (from: number, preferOtherProtocol: boolean): number => {
    const n = ordered.length;
    if (preferOtherProtocol) {
      const fromProtocol = pathwayAt(from).protocol;
      for (let step = 1; step < n; step++) {
        const j = (from + step) % n;
        if (pathwayAt(j).protocol !== fromProtocol) return j;
      }
    }
    return (from + 1) % n;
  };

  const recordSwitch = (from: number, to: number) => {
    const a = pathwayAt(from);
    const b = pathwayAt(to);
    const action: RecoveryAction = a.protocol === b.protocol ? 'switch_pathway' : 'switch_protocol';
    probe.recordRecovery(action, describePathway(a), describePathway(b));
  };

  /** Switches to pathway `to` (after startup). Keeps walking on failure until one succeeds or stop() is called. */
  const switchTo = async (to: number, _reason: 'failover' | 'ladder' | 'manual'): Promise<void> => {
    let from = currentIndex;
    let target = to;
    while (!stopped) {
      recordSwitch(from, target);
      const result = await attempt(target);
      if (result !== 'failed' || stopped) return;
      from = target;
      target = nextIndex(target, false);
    }
  };

  const runLadder = () => {
    // Buffering while a freshly switched pathway is still starting is startup, not a stall to act on.
    if (!engine || currentIndex < 0 || settling) return;
    const ladder = opts.policy.stallLadder;
    if (ladder.length === 0) return;
    const t = Date.now();
    if (t - lastStallAt > LADDER_RESET_MS) ladderIndex = 0;
    lastStallAt = t;
    const action = ladder[Math.min(ladderIndex, ladder.length - 1)]!;
    ladderIndex++;

    const here = describePathway(pathwayAt(currentIndex));
    const e = engine;
    switch (action) {
      case 'nudge':
        video.currentTime += NUDGE_SEC;
        probe.recordRecovery(action, here, here);
        break;
      case 'seek_live':
        e.seekToLive();
        probe.recordRecovery(action, here, here);
        break;
      case 'downgrade': {
        e.setLevel(0);
        if (restoreLevelTimer) clearTimeout(restoreLevelTimer);
        restoreLevelTimer = setTimeout(() => {
          restoreLevelTimer = null;
          if (engine === e) e.setLevel(-1);
        }, DOWNGRADE_RESTORE_MS);
        probe.recordRecovery(action, here, here);
        break;
      }
      case 'switch_pathway':
        void switchTo(nextIndex(currentIndex, false), 'ladder');
        break;
      case 'switch_protocol':
        void switchTo(nextIndex(currentIndex, true), 'ladder');
        break;
      default:
        break;
    }
  };

  probe.onEvent((ev) => {
    em.emit('qoe', ev);
    if (ev.name === 'stall_start') runLadder();
  });

  return {
    probe,
    on: (ev, cb) => em.on(ev, cb),

    async start() {
      if (started) throw new Error('PlayerController.start() may only be called once');
      started = true;
      probe.markPlayAttempt();
      if (ordered.length === 0) {
        probe.recordError('controller', 'no_playable_pathway', true);
        probe.end('fatal');
        throw new Error('No playable pathway for this browser');
      }
      for (let i = 0; i < ordered.length && !stopped; i++) {
        if (i > 0) recordSwitch(i - 1, i);
        const result = await attempt(i);
        if (result !== 'failed') return;
      }
      if (stopped) return;
      generation++;
      teardownEngine();
      currentIndex = -1;
      probe.recordError('controller', 'all_pathways_failed', true);
      probe.end('fatal');
      throw new Error('All pathways failed');
    },

    stop() {
      if (stopped) return;
      stopped = true;
      generation++;
      teardownEngine();
      currentIndex = -1;
      probe.end('user');
      probe.destroy();
      em.clear();
    },

    current() {
      if (!engine || currentIndex < 0) return null;
      return { pathway: pathwayAt(currentIndex), engine };
    },

    async switchPathway(i) {
      pathwayAt(i); // validates the index
      await switchTo(i, 'manual');
    },
  };
}
