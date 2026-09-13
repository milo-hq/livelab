import { useQuery } from '@tanstack/react-query';
import { useRef } from 'react';
import { StreamHealth } from '@livelab/protocol';
import { api } from '../../lib/api';

export function HealthCard({ roomId }: { roomId: string }) {
  const q = useQuery({ queryKey: ['health', roomId], queryFn: () => api.get(`/v1/rooms/${roomId}/health`, StreamHealth), refetchInterval: 2000 });
  const prev = useRef<{ bytes: number; at: number } | null>(null);
  const h = q.data;
  let kbps: number | null = null;
  if (h) {
    if (prev.current && h.sampledAt > prev.current.at) kbps = ((h.bytesReceived - prev.current.bytes) * 8) / ((h.sampledAt - prev.current.at) / 1000) / 1000;
    if (!prev.current || h.sampledAt !== prev.current.at) prev.current = { bytes: h.bytesReceived, at: h.sampledAt };
  }
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="mb-2 font-semibold">推流健康度</h3>
      {q.isError && <p className="text-sm text-red-400">{(q.error as Error).message}</p>}
      {h && (
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div>状态 <b className={h.ready ? 'text-green-400' : 'text-red-400'}>{h.ready ? '推流中' : '未推流'}</b></div>
          <div>观看连接 <b className="tabular-nums">{h.readers}</b></div>
          <div>入站码率 <b className="tabular-nums">{kbps == null ? '—' : `${Math.max(0, kbps).toFixed(0)} kbps`}</b></div>
          <div>来源 <b>{h.sourceType ?? '—'}</b></div>
          <div className="col-span-2 text-xs text-zinc-400">轨道：{h.tracks.join(', ') || '—'}</div>
        </div>
      )}
      <p className="mt-2 text-[11px] text-zinc-500">数据来自 MediaMTX API `/v3/paths/get/…`，api 侧缓存 2s。生产中应补充编码器上报的丢帧率与 RTT。</p>
    </div>
  );
}
