import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PlayResponse, type Pathway, type Protocol } from '@livelab/protocol';
import { createPlayerController, describePathway, type EngineStats, type PlayerController, type QoeEvent } from '@livelab/player-core';
import hlsWorkerUrl from 'hls.js/dist/hls.worker.js?url';
import { api } from '../lib/api';
import { telemetry, createViewId } from '../lib/telemetry-client';

export interface WeaknetParams { delayMs: number; lossPct: number; bandwidthKbps: number }

export type PlayerState = 'idle' | 'loading' | 'playing' | 'stalled' | 'error';

export interface UsePlayerOptions {
  roomId: string;
  forceProtocol?: Protocol;
  weaknet?: WeaknetParams;
  /** Re-create the player when this changes (lab "restart" button). */
  runKey?: number;
}

export interface PlayerEventRow { at: number; text: string }

const MAX_EVENTS = 200;

/** Rewrites media URLs through the api's weak-network proxy (see apps/api/src/modules/weaknet). */
export function weaknetTransform(p: WeaknetParams | undefined): ((url: string) => string) | undefined {
  if (!p || (p.delayMs === 0 && p.lossPct === 0 && p.bandwidthKbps === 0)) return undefined;
  return (url) => `/weaknet?u=${encodeURIComponent(url)}&delay=${p.delayMs}&loss=${p.lossPct}&bw=${p.bandwidthKbps}`;
}

function describeEvent(e: QoeEvent): string {
  switch (e.name) {
    case 'first_frame': return `first_frame ${e.ttffMs}ms (${e.protocol})`;
    case 'stall_end': return `stall_end ${e.durationMs}ms`;
    case 'level_switch': return `level_switch → L${e.level} ${e.bitrateKbps ?? '?'}kbps`;
    case 'latency_sample': return `latency ${e.latencyMs}ms buffer ${e.bufferMs}ms`;
    case 'heartbeat': return `heartbeat playing ${e.playingMs}ms stalled ${e.stalledMs}ms dropped ${e.droppedFrames}/${e.totalFrames}`;
    case 'error': return `error ${e.type}/${e.detail}${e.fatal ? ' FATAL' : ''}`;
    case 'recovery_action': return `recovery ${e.action} ${e.from} → ${e.to}`;
    case 'end': return `end ${e.reason} ${e.watchMs}ms`;
    default: return e.name;
  }
}

/**
 * Binds a <video> to the player controller for one room:
 *   GET /v1/rooms/:id/play → pathways + policy → controller.start() (engine lazy-loaded)
 * and forwards every QoE event to telemetry with pathway/protocol/cdn dimensions.
 */
export function usePlayer(opts: UsePlayerOptions) {
  const { roomId, forceProtocol, weaknet, runKey = 0 } = opts;
  const videoRef = useRef<HTMLVideoElement>(null);
  const controllerRef = useRef<PlayerController | null>(null);
  const [state, setState] = useState<PlayerState>('idle');
  const [pathway, setPathway] = useState<Pathway | null>(null);
  const [engineKind, setEngineKind] = useState<string | null>(null);
  const [stats, setStats] = useState<EngineStats | null>(null);
  const [events, setEvents] = useState<PlayerEventRow[]>([]);
  const [ttffMs, setTtff] = useState<number | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const viewIdRef = useRef<string>('');

  const play = useQuery({ queryKey: ['play', roomId], queryFn: () => api.get(`/v1/rooms/${roomId}/play`, PlayResponse), staleTime: 60_000 });

  const delayMs = weaknet?.delayMs ?? 0;
  const lossPct = weaknet?.lossPct ?? 0;
  const bandwidthKbps = weaknet?.bandwidthKbps ?? 0;

  useEffect(() => {
    const video = videoRef.current;
    const data = play.data;
    if (!video || !data) return;

    const viewId = createViewId();
    viewIdRef.current = viewId;
    setEvents([]);
    setTtff(null);
    setErrorText(null);
    setState('loading');

    const wn = weaknetTransform({ delayMs, lossPct, bandwidthKbps });
    const controller = createPlayerController(video, {
      pathways: data.pathways,
      policy: data.policy,
      forceProtocol,
      engineOptions: {
        workerUrl: hlsWorkerUrl,
        cmcd: { sessionId: telemetry.sessionId, contentId: roomId },
        requestTransform: wn,
      },
    });
    controllerRef.current = controller;

    const dims = (): Record<string, string> => {
      const cur = controller.current();
      return cur ? { protocol: cur.pathway.protocol, cdn: cur.pathway.cdn, pathway: describePathway(cur.pathway), engine: cur.engine.kind } : {};
    };

    const offQoe = controller.on('qoe', (e) => {
      const { name, ts, ...rest } = e;
      const attrs: Record<string, string | number | boolean> = { ...dims(), weaknet: wn ? `${delayMs}/${lossPct}/${bandwidthKbps}` : 'off' };
      for (const [k, v] of Object.entries(rest)) if (v !== null && v !== undefined && typeof v !== 'object') attrs[k] = v as string | number | boolean;
      telemetry.track(`video.${name}`, attrs, { viewId, roomId });
      telemetry.log(name === 'error' ? 'error' : 'info', describeEvent(e));

      if (name === 'first_frame') { setTtff(e.ttffMs); setState('playing'); }
      else if (name === 'stall_start') setState('stalled');
      else if (name === 'stall_end') setState('playing');
      else if (name === 'error' && e.fatal) { setState('error'); setErrorText(`${e.type}/${e.detail}`); }
      setEvents((prev) => [...prev, { at: ts, text: describeEvent(e) }].slice(-MAX_EVENTS));
    });
    const offPath = controller.on('pathway_change', (p) => {
      setPathway(p.pathway);
      setEngineKind(p.engine);
    });
    const statsTimer = setInterval(() => {
      const cur = controller.current();
      if (cur) setStats(cur.engine.getStats());
    }, 1000);

    controller.start().catch(() => {
      setState('error');
      setErrorText((t) => t ?? 'all pathways failed');
    });

    const onHide = () => { if (document.visibilityState === 'hidden') telemetry.flush(); };
    document.addEventListener('visibilitychange', onHide);

    return () => {
      document.removeEventListener('visibilitychange', onHide);
      offQoe();
      offPath();
      clearInterval(statsTimer);
      controller.probe.end('user');
      controller.stop();
      controllerRef.current = null;
      setState('idle');
      setPathway(null);
      setStats(null);
    };
    // weaknet is deliberately spread into primitives so a new object literal per render doesn't restart the player
  }, [play.data, roomId, forceProtocol, delayMs, lossPct, bandwidthKbps, runKey]);

  const switchPathway = useCallback((i: number) => controllerRef.current?.switchPathway(i), []);
  const reportIssue = useCallback((description: string) => telemetry.reportIssue(description, { roomId, viewId: viewIdRef.current, pathway: pathway ? describePathway(pathway) : '' }), [roomId, pathway]);

  return { videoRef, state, pathway, engineKind, stats, events, ttffMs, errorText, playData: play.data, playError: play.error as Error | null, switchPathway, reportIssue };
}
