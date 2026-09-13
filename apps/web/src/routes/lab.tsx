import { useState } from 'react';
import type { Protocol } from '@livelab/protocol';
import { LivePlayer } from '../components/player/live-player';
import type { WeaknetParams } from '../hooks/use-player';

const LANES: { protocol: Protocol; title: string; note: string }[] = [
  { protocol: 'llhls', title: 'LL-HLS（hls.js）', note: '广兼容路径，目标 2–4s' },
  { protocol: 'flv', title: 'HTTP-FLV（mpegts.js）', note: '桌面低延迟，需 pnpm infra:flv' },
  { protocol: 'whep', title: 'WebRTC（WHEP）', note: '亚秒互动路径' },
];

function Slider({ label, value, min, max, step, unit, onChange }: { label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="w-14 text-zinc-400">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="flex-1 accent-brand" />
      <span className="w-16 text-right tabular-nums">{value}{unit}</span>
    </label>
  );
}

export default function LabPage() {
  const [roomId, setRoomId] = useState('demo');
  const [wn, setWn] = useState<Record<Protocol, WeaknetParams>>({
    llhls: { delayMs: 0, lossPct: 0, bandwidthKbps: 0 }, flv: { delayMs: 0, lossPct: 0, bandwidthKbps: 0 }, whep: { delayMs: 0, lossPct: 0, bandwidthKbps: 0 }, hls: { delayMs: 0, lossPct: 0, bandwidthKbps: 0 },
  });
  const [applied, setApplied] = useState(wn);
  const [runKey, setRunKey] = useState(0);
  const [enabled, setEnabled] = useState<Record<Protocol, boolean>>({ llhls: true, flv: true, whep: true, hls: false });

  const restartAll = () => { setApplied(wn); setRunKey((k) => k + 1); };

  return (
    <div className="mx-auto max-w-[1500px] p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">播放实验室</h1>
        <p className="text-sm text-zinc-400">三条协议同时起播，对比首帧、延迟与弱网表现。画面时钟 − 当前时间 = 端到端延迟。</p>
        <select value={roomId} onChange={(e) => setRoomId(e.target.value)} className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm">
          <option value="demo">demo</option><option value="demo-rt">demo-rt</option>
        </select>
        <button onClick={restartAll} className="rounded bg-brand px-3 py-1 text-sm font-medium">全部重新起播</button>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {LANES.map((lane) => (
          <div key={lane.protocol} className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900 p-3">
            <div className="flex items-center justify-between">
              <div><div className="font-medium">{lane.title}</div><div className="text-xs text-zinc-500">{lane.note}</div></div>
              <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={enabled[lane.protocol]} onChange={(e) => setEnabled({ ...enabled, [lane.protocol]: e.target.checked })} /> 启用</label>
            </div>
            <div className="aspect-video overflow-hidden rounded bg-black">
              {enabled[lane.protocol] && <LivePlayer roomId={roomId} forceProtocol={lane.protocol} weaknet={applied[lane.protocol]} runKey={runKey} showStats compact />}
            </div>
            {lane.protocol !== 'whep' ? (
              <div className="space-y-1">
                <Slider label="延迟" value={wn[lane.protocol].delayMs} min={0} max={3000} step={50} unit="ms" onChange={(v) => setWn({ ...wn, [lane.protocol]: { ...wn[lane.protocol], delayMs: v } })} />
                <Slider label="丢包" value={wn[lane.protocol].lossPct} min={0} max={60} step={5} unit="%" onChange={(v) => setWn({ ...wn, [lane.protocol]: { ...wn[lane.protocol], lossPct: v } })} />
                <Slider label="带宽" value={wn[lane.protocol].bandwidthKbps} min={0} max={6000} step={100} unit="kbps" onChange={(v) => setWn({ ...wn, [lane.protocol]: { ...wn[lane.protocol], bandwidthKbps: v } })} />
                <p className="text-[11px] text-zinc-500">0 = 不限制。改动后点"全部重新起播"生效（经 api 的 /weaknet 代理）。</p>
              </div>
            ) : (
              <p className="text-[11px] text-zinc-500">WebRTC 走 UDP，不经 HTTP 代理；用 Chrome DevTools → Network conditions 或系统级限速（macOS Network Link Conditioner）模拟弱网。</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
