import { useEffect, useRef, useState } from 'react';
import type { ClientFrame } from '@livelab/protocol';
import { useRoomStore } from '../../stores/room';

const HEARTS = ['❤️', '🧡', '💛', '💚', '💙', '💜'];

/**
 * Likes are the highest-frequency interaction. Two levels of aggregation keep them cheap:
 *  1. client: clicks are counted and flushed as one `like{n}` frame every 500ms;
 *  2. server: per-room totals are broadcast once per second as `like_agg`.
 * The burst animation uses the aggregated count so everyone sees the room "heating up".
 */
export function LikeButton({ send }: { send: (f: ClientFrame) => boolean }) {
  const total = useRoomStore((s) => s.likeTotal);
  const burst = useRoomStore((s) => s.likeBurst);
  const pendingRef = useRef(0);
  const [hearts, setHearts] = useState<{ id: number; x: number; emoji: string }[]>([]);
  const idRef = useRef(0);
  const lastBurst = useRef(burst);

  useEffect(() => {
    const t = setInterval(() => {
      if (pendingRef.current > 0) {
        send({ t: 'like', n: Math.min(50, pendingRef.current) });
        pendingRef.current = 0;
      }
    }, 500);
    return () => clearInterval(t);
  }, [send]);

  // Spawn a few floating hearts when the room's aggregated like count grows.
  useEffect(() => {
    const delta = burst - lastBurst.current;
    lastBurst.current = burst;
    if (delta <= 0) return;
    const n = Math.min(6, delta);
    const spawned = Array.from({ length: n }, () => ({ id: idRef.current++, x: 10 + Math.random() * 60, emoji: HEARTS[Math.floor(Math.random() * HEARTS.length)]! }));
    setHearts((h) => [...h, ...spawned].slice(-30));
    const t = setTimeout(() => setHearts((h) => h.filter((x) => !spawned.includes(x))), 1500);
    return () => clearTimeout(t);
  }, [burst]);

  const click = () => {
    pendingRef.current += 1;
    const local = { id: idRef.current++, x: 20 + Math.random() * 40, emoji: HEARTS[Math.floor(Math.random() * HEARTS.length)]! };
    setHearts((h) => [...h, local].slice(-30));
    setTimeout(() => setHearts((h) => h.filter((x) => x.id !== local.id)), 1500);
  };

  return (
    <div className="relative">
      <div className="pointer-events-none absolute bottom-full left-0 h-40 w-full overflow-hidden">
        {hearts.map((h) => (
          <span key={h.id} className="absolute bottom-0 animate-[float_1.5s_ease-out_forwards] text-xl" style={{ left: `${h.x}%` }}>{h.emoji}</span>
        ))}
      </div>
      <button onClick={click} className="flex items-center gap-1 rounded-full bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700 active:scale-95">
        ❤️ <span className="tabular-nums">{total}</span>
      </button>
      <style>{`@keyframes float { 0% { transform: translateY(0) scale(.8); opacity: 1 } 100% { transform: translateY(-140px) scale(1.3); opacity: 0 } }`}</style>
    </div>
  );
}
