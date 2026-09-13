import { useEffect, useRef, useState } from 'react';
import { WhipClient } from '@livelab/player-core';
import type { Cohost } from '@livelab/protocol';

/**
 * The guest side of 连麦: grab camera + mic, publish to the MediaMTX path the server handed out
 * (WHIP), and show a local preview. Everyone else plays the same path via WHEP (see CohostLayer).
 */
export function CohostPublisher({ cohost, onEnd }: { cohost: Cohost; onEnd: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<'starting' | 'live' | 'error'>('starting');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let client: WhipClient | null = null;
    let stream: MediaStream | null = null;
    let cancelled = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } }, audio: { echoCancellation: true, noiseSuppression: true } });
        if (cancelled) return;
        if (videoRef.current) { videoRef.current.srcObject = stream; void videoRef.current.play().catch(() => {}); }
        client = new WhipClient(cohost.whip);
        await client.publish(stream);
        if (cancelled) return;
        setStatus('live');
        client.pc.addEventListener('connectionstatechange', () => {
          if (client && (client.pc.connectionState === 'failed' || client.pc.connectionState === 'closed')) { setStatus('error'); setError('连接中断'); }
        });
      } catch (e) {
        if (cancelled) return;
        setStatus('error');
        setError(e instanceof DOMException && e.name === 'NotAllowedError' ? '未获得摄像头/麦克风权限' : (e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      client?.close().catch(() => {});
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [cohost.whip]);

  return (
    <div className="pointer-events-auto absolute bottom-3 left-3 w-44 overflow-hidden rounded-lg border border-brand bg-black shadow-lg">
      <video ref={videoRef} muted playsInline className="aspect-video w-full object-cover" />
      <div className="flex items-center justify-between px-2 py-1 text-[11px]">
        <span>{status === 'live' ? '● 我在麦上' : status === 'starting' ? '连接中…' : `✕ ${error}`}</span>
        <button onClick={onEnd} className="rounded bg-zinc-800 px-2 py-0.5 hover:bg-red-700">挂断</button>
      </div>
    </div>
  );
}
