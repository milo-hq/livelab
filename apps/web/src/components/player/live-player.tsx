import { useEffect, useState, type ReactNode } from 'react';
import type { Protocol } from '@livelab/protocol';
import {
  MediaController, MediaControlBar, MediaPlayButton, MediaMuteButton, MediaVolumeRange,
  MediaLiveButton, MediaPipButton, MediaFullscreenButton, MediaLoadingIndicator,
} from 'media-chrome/react';
import { usePlayer, type WeaknetParams } from '../../hooks/use-player';
import { StatsOverlay } from './stats-overlay';
import { ReportIssue } from './report-issue';

export interface LivePlayerProps {
  roomId: string;
  muted?: boolean;
  forceProtocol?: Protocol;
  weaknet?: WeaknetParams;
  runKey?: number;
  /** Overlays (danmaku / gifts) rendered above the video but below the controls. */
  children?: ReactNode;
  showStats?: boolean;
  compact?: boolean;
}

/**
 * The player = three decoupled layers:
 *   1. engine (hls.js / mpegts.js / WHEP) → writes into the <video> (player-core)
 *   2. UI chrome (media-chrome web components, framework-agnostic; swappable for Video.js v10)
 *   3. overlays (danmaku canvas, gift canvas, QoE stats) that only touch the DOM around the video
 */
export function LivePlayer({ roomId, muted = true, forceProtocol, weaknet, runKey, children, showStats: showStatsProp, compact }: LivePlayerProps) {
  const p = usePlayer({ roomId, forceProtocol, weaknet, runKey });
  const [showStats, setShowStats] = useState(showStatsProp ?? false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'i' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) setShowStats((v) => !v); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const latency = p.stats?.latencyMs;

  return (
    <MediaController defaultStreamType="live" className="relative block h-full w-full bg-black" style={{ aspectRatio: 'auto' }}>
      <video ref={p.videoRef} slot="media" playsInline muted={muted} autoPlay preload="metadata" className="h-full w-full object-contain" />
      {/* overlays live in the default slot so media-chrome stacks them above the media */}
      <div slot="centered-chrome" className="pointer-events-none absolute inset-0">{children}</div>
      <div slot="top-chrome" className="flex w-full items-start justify-between p-2">
        <div className="flex items-center gap-2">
          <span className="rounded bg-brand px-1.5 py-0.5 text-[11px] font-semibold text-white">LIVE</span>
          {p.pathway && <span className="rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-zinc-200">{p.pathway.protocol.toUpperCase()} · {p.pathway.cdn}</span>}
          {latency != null && !Number.isNaN(latency) && <span className="rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-zinc-200">延迟 {(latency / 1000).toFixed(1)}s</span>}
          {p.state === 'stalled' && <span className="rounded bg-amber-600 px-1.5 py-0.5 text-[11px]">缓冲中</span>}
        </div>
        {!compact && (
          <div className="flex items-center gap-1">
            <button onClick={() => setShowStats((v) => !v)} className="rounded bg-black/60 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-black/80">统计 (i)</button>
            <ReportIssue onReport={p.reportIssue} />
          </div>
        )}
      </div>
      {showStats && (
        <div slot="middle-chrome" className="absolute left-0 top-10">
          <StatsOverlay pathway={p.pathway} engineKind={p.engineKind} stats={p.stats} events={p.events} ttffMs={p.ttffMs} pathways={p.playData?.pathways} onSwitch={p.switchPathway} />
        </div>
      )}
      {p.state === 'error' && (
        <div slot="middle-chrome" className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 text-sm">
          <div>播放失败：{p.errorText}</div>
          <div className="text-xs text-zinc-400">已尝试所有线路。检查 `pnpm infra:up` 是否运行、推流是否在线。</div>
        </div>
      )}
      {p.playError && <div slot="middle-chrome" className="absolute inset-0 flex items-center justify-center text-sm text-red-300">{p.playError.message}</div>}
      <MediaLoadingIndicator slot="centered-chrome" noAutohide />
      <MediaControlBar>
        <MediaPlayButton />
        <MediaMuteButton />
        <MediaVolumeRange />
        <span className="flex-1" />
        <MediaLiveButton />
        <MediaPipButton />
        <MediaFullscreenButton />
      </MediaControlBar>
    </MediaController>
  );
}
