import { useEffect, useRef } from 'react';
import { useRoomStore } from '../../stores/room';
import { ANIMATIONS, createGiftQueue } from './animations';

/**
 * Full-bleed canvas over the player that plays gift animations. It subscribes to the store outside
 * React's render cycle (`useRoomStore.subscribe`) so a burst of gifts never re-renders the room page.
 */
export function GiftLayer() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const queue = createGiftQueue({ maxConcurrent: 2 });
    let raf = 0;
    let running = false;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(canvas.clientWidth * dpr);
      canvas.height = Math.floor(canvas.clientHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const frame = () => {
      const now = performance.now();
      const active = queue.tick(now);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);
      for (const a of active) {
        const t = Math.min(1, (now - a.startedAt) / a.durationMs);
        ctx.save();
        ANIMATIONS[a.gift.gift.animation].draw(ctx, t, w, h, a.seed);
        ctx.restore();
        // caption
        ctx.save();
        ctx.font = 'bold 16px sans-serif';
        ctx.fillStyle = 'rgba(0,0,0,.55)';
        const label = `${a.gift.user.name} 送出 ${a.gift.gift.icon} ${a.gift.gift.name} ×${a.gift.count}`;
        const tw = ctx.measureText(label).width + 20;
        ctx.fillRect(12, 12 + active.indexOf(a) * 34, tw, 26);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, 22, 30 + active.indexOf(a) * 34);
        ctx.restore();
      }
      if (active.length > 0 || queue.pendingCount > 0) raf = requestAnimationFrame(frame);
      else running = false;
    };
    const kick = () => {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(frame);
    };

    const unsub = useRoomStore.subscribe((s, prev) => {
      if (s.lastGift && s.lastGift !== prev.lastGift) {
        queue.push(s.lastGift);
        kick();
      }
    });
    return () => {
      unsub();
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />;
}
