import type { Pathway } from '@livelab/protocol';
import type { EngineStats } from '@livelab/player-core';
import type { PlayerEventRow } from '../../hooks/use-player';

export function StatsOverlay({ pathway, engineKind, stats, events, ttffMs, pathways, onSwitch }: {
  pathway: Pathway | null; engineKind: string | null; stats: EngineStats | null; events: PlayerEventRow[]; ttffMs: number | null;
  pathways?: Pathway[]; onSwitch?: (i: number) => void;
}) {
  const fmt = (v: number | null | undefined, unit = '') => (v == null || Number.isNaN(v) ? '—' : `${Math.round(v)}${unit}`);
  return (
    <div className="pointer-events-auto absolute left-2 top-2 z-10 w-[300px] rounded bg-black/75 p-2 font-mono text-[11px] leading-4 text-zinc-200 backdrop-blur">
      <div className="mb-1 flex justify-between text-zinc-400"><span>QoE · 按 i 关闭</span><span>{engineKind ?? '—'}</span></div>
      <div className="grid grid-cols-2 gap-x-2">
        <span>pathway</span><span className="truncate">{pathway ? `${pathway.protocol}@${pathway.cdn}` : '—'}</span>
        <span>TTFF</span><span>{fmt(ttffMs, ' ms')}</span>
        <span>latency</span><span>{fmt(stats?.latencyMs, ' ms')}</span>
        <span>buffer</span><span>{fmt(stats?.bufferMs, ' ms')}</span>
        <span>bitrate</span><span>{fmt(stats?.bitrateKbps, ' kbps')} L{stats?.level ?? '-'}/{stats?.levels ?? '-'}</span>
        <span>dropped</span><span>{stats ? `${stats.droppedFrames}/${stats.totalFrames}` : '—'}</span>
        <span>rate</span><span>{stats ? `${stats.playbackRate.toFixed(2)}x` : '—'}</span>
      </div>
      {pathways && onSwitch && (
        <div className="mt-1 flex flex-wrap gap-1">
          {pathways.map((p, i) => (
            <button key={i} onClick={() => onSwitch(i)} className={`rounded px-1 ${pathway?.url === p.url ? 'bg-brand text-white' : 'bg-zinc-700 hover:bg-zinc-600'}`}>{p.protocol}@{p.cdn}</button>
          ))}
        </div>
      )}
      <div className="mt-1 max-h-28 overflow-y-auto border-t border-zinc-700 pt-1 text-zinc-400">
        {events.slice(-10).map((e, i) => <div key={`${e.at}-${i}`} className="truncate">{new Date(e.at).toLocaleTimeString('en-GB', { hour12: false })} {e.text}</div>)}
      </div>
    </div>
  );
}
