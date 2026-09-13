import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';
import { RoomWithKey } from '@livelab/protocol';
import { api } from '../../lib/api';

function Copy({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button onClick={() => { navigator.clipboard?.writeText(text); setOk(true); setTimeout(() => setOk(false), 1200); }} className="rounded bg-zinc-800 px-2 py-0.5 text-xs hover:bg-zinc-700">
      {ok ? '已复制' : '复制'}
    </button>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="w-14 shrink-0 text-zinc-400">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded bg-zinc-950 px-2 py-1 text-xs">{value}</code>
      <Copy text={value} />
    </div>
  );
}

export function StreamSetup({ roomId }: { roomId: string }) {
  const q = useQuery({ queryKey: ['room-key', roomId], queryFn: () => api.get(`/v1/rooms/${roomId}/key`, RoomWithKey) });
  const qc = useQueryClient();
  const reset = useMutation({ mutationFn: () => api.post(`/v1/rooms/${roomId}/key/reset`, {}, z.object({ streamKey: z.string() })), onSuccess: () => qc.invalidateQueries({ queryKey: ['room-key', roomId] }) });
  const [reveal, setReveal] = useState(false);
  const r = q.data;
  if (!r) return <div className="text-sm text-zinc-400">{q.isError ? (q.error as Error).message : '加载中…'}</div>;
  const key = reveal ? r.streamKey : '•'.repeat(16);
  return (
    <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">推流设置</h3>
        <div className="flex gap-2 text-xs">
          <button className="text-zinc-400 hover:text-zinc-200" onClick={() => setReveal((v) => !v)}>{reveal ? '隐藏密钥' : '显示密钥'}</button>
          <button className="text-zinc-400 hover:text-red-300" onClick={() => reset.mutate()}>重置密钥</button>
        </div>
      </div>
      <Row label="RTMP" value={r.ingest.rtmp} />
      <Row label="WHIP" value={r.ingest.whip} />
      <Row label="SRT" value={r.ingest.srt} />
      <Row label="密钥" value={key} />
      <details className="text-xs text-zinc-400">
        <summary className="cursor-pointer">OBS / FFmpeg 示例</summary>
        <pre className="mt-2 overflow-x-auto rounded bg-zinc-950 p-2 text-[11px] leading-4">{`# OBS: 设置 → 直播 → 服务 Custom，服务器 ${r.ingest.rtmp.replace(/\/[^/]+$/, '')}，串流密钥 ${r.streamPath}
# OBS ≥30 WHIP: 服务 WHIP，服务器 ${r.ingest.whip}
ffmpeg -re -stream_loop -1 -i input.mp4 -c:v libx264 -preset veryfast -tune zerolatency -g 60 -c:a aac -f flv ${r.ingest.rtmp}`}</pre>
      </details>
      <p className="text-[11px] text-zinc-500">演示环境 MediaMTX 未开启推流鉴权，密钥仅作展示；生产环境应在 MediaMTX `authHTTPAddress` 回调中校验密钥。</p>
    </div>
  );
}
