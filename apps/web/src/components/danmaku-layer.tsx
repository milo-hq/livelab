import { useEffect, useRef, useState } from 'react';
import { createDanmaku, type DanmakuHandle } from '@livelab/danmaku';
import { useRoomStore } from '../stores/room';

export type DanmakuDensity = 'off' | 'low' | 'normal' | 'high';

const DENSITY: Record<Exclude<DanmakuDensity, 'off'>, { maxPerSecond: number; area: 0.25 | 0.5 | 0.75 | 1 }> = {
  low: { maxPerSecond: 8, area: 0.25 },
  normal: { maxPerSecond: 25, area: 0.5 },
  high: { maxPerSecond: 60, area: 0.75 },
};

/**
 * Bullet-comment overlay. Subscribes to the store outside React so each 150ms IM batch becomes a
 * handful of `emit()` calls on the canvas renderer instead of a React re-render of the overlay.
 */
export function DanmakuLayer({ density = 'normal' }: { density?: DanmakuDensity }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<DanmakuHandle | null>(null);
  const [stats, setStats] = useState({ onScreen: 0, dropped: 0 });

  useEffect(() => {
    if (density === 'off') return;
    const canvas = canvasRef.current!;
    const handle = createDanmaku(canvas, { ...DENSITY[density], durationMs: 8000, laneHeight: 34 });
    handleRef.current = handle;
    let lastSeq = 0;
    const unsub = useRoomStore.subscribe((s) => {
      // Only messages newer than the last one we emitted (the store keeps a rolling window).
      for (const m of s.messages) {
        if (m.seq <= lastSeq) continue;
        lastSeq = m.seq;
        if (m.t === 'chat') handle.emit({ id: m.id, text: m.text, priority: m.user.role === 'host' ? 1 : 0, color: m.user.role === 'host' ? '#fda4af' : undefined });
        else if (m.t === 'gift') handle.emit({ id: m.id, text: `${m.user.name} 送出 ${m.gift.icon}${m.gift.name} ×${m.count}`, priority: 2, color: '#fde68a', border: true, size: 'lg' });
        else if (m.t === 'system' && m.kind === 'announce') handle.emit({ id: `a${m.seq}`, text: `📢 ${String(m.payload['text'] ?? '')}`, priority: 2, color: '#93c5fd', border: true });
      }
    });
    const statTimer = setInterval(() => setStats({ onScreen: handle.stats.onScreen, dropped: handle.stats.dropped }), 1000);
    return () => {
      unsub();
      clearInterval(statTimer);
      handle.destroy();
      handleRef.current = null;
    };
  }, [density]);

  if (density === 'off') return null;
  return (
    <>
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
      <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/40 px-1 text-[10px] text-zinc-400">弹幕 {stats.onScreen} · 丢弃 {stats.dropped}</span>
    </>
  );
}
