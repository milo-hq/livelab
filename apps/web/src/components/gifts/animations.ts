import type { GiftAnimation as GiftAnimationName, GiftMsg } from '@livelab/protocol';

/**
 * A gift animation is a pure draw function of normalized time t ∈ [0, 1]. Keeping it pure (no state,
 * seeded randomness) means it can be replayed, tested and moved to a worker. Production systems swap
 * this layer for SVGA / alpha-MP4 (VAP, YYEVA) assets designed by motion designers; the queueing and
 * priority logic below stays the same.
 */
export type GiftDrawFn = (ctx: CanvasRenderingContext2D, t: number, w: number, h: number, seed: number) => void;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);

export const hearts: GiftDrawFn = (ctx, t, w, h, seed) => {
  const rnd = mulberry32(seed);
  for (let i = 0; i < 24; i++) {
    const x0 = w * (0.3 + rnd() * 0.4);
    const drift = (rnd() - 0.5) * 120;
    const delay = rnd() * 0.4;
    const lt = Math.max(0, Math.min(1, (t - delay) / (1 - delay)));
    if (lt <= 0) continue;
    const y = h - easeOut(lt) * h * 0.9;
    const x = x0 + Math.sin(lt * Math.PI * 2 + i) * 20 + drift * lt;
    ctx.globalAlpha = 1 - lt;
    ctx.font = `${20 + rnd() * 20}px serif`;
    ctx.fillText('❤️', x, y);
  }
  ctx.globalAlpha = 1;
};

export const confetti: GiftDrawFn = (ctx, t, w, h, seed) => {
  const rnd = mulberry32(seed);
  const colors = ['#f43f5e', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#facc15'];
  for (let i = 0; i < 120; i++) {
    const angle = rnd() * Math.PI * 2;
    const speed = 200 + rnd() * 500;
    const gravity = 600;
    const x = w / 2 + Math.cos(angle) * speed * t;
    const y = h / 2 + Math.sin(angle) * speed * t + 0.5 * gravity * t * t;
    const size = 6 + rnd() * 8;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(t * 10 + i);
    ctx.globalAlpha = Math.max(0, 1 - t * 1.1);
    ctx.fillStyle = colors[i % colors.length]!;
    ctx.fillRect(-size / 2, -size / 4, size, size / 2);
    ctx.restore();
  }
};

export const rocket: GiftDrawFn = (ctx, t, w, h, seed) => {
  const rnd = mulberry32(seed);
  const x = w * 0.5;
  const y = h - easeOut(Math.min(1, t * 1.6)) * h * 0.75;
  // exhaust trail
  for (let i = 0; i < 40; i++) {
    const ty = y + 20 + i * 6;
    if (ty > h) break;
    ctx.globalAlpha = (1 - i / 40) * 0.8;
    ctx.fillStyle = i % 2 ? '#fb923c' : '#facc15';
    ctx.beginPath();
    ctx.arc(x + (rnd() - 0.5) * 16, ty, 8 - i * 0.15, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.font = '72px serif';
  ctx.textAlign = 'center';
  ctx.fillText('🚀', x, y);
  if (t > 0.6) {
    const bt = (t - 0.6) / 0.4;
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * Math.PI * 2;
      const r = easeOut(bt) * 220;
      ctx.globalAlpha = 1 - bt;
      ctx.fillStyle = i % 3 === 0 ? '#f43f5e' : i % 3 === 1 ? '#facc15' : '#38bdf8';
      ctx.beginPath();
      ctx.arc(x + Math.cos(a) * r, y - 40 + Math.sin(a) * r, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  ctx.textAlign = 'start';
};

export const ANIMATIONS: Record<GiftAnimationName, { draw: GiftDrawFn; durationMs: number }> = {
  hearts: { draw: hearts, durationMs: 2200 },
  confetti: { draw: confetti, durationMs: 1800 },
  rocket: { draw: rocket, durationMs: 3200 },
};

export interface ActiveGift { gift: GiftMsg; startedAt: number; durationMs: number; seed: number }

/**
 * Gift playback queue. Expensive gifts (price ≥ `bigPrice`) jump the queue so a rocket is never
 * stuck behind fifty roses; at most `maxConcurrent` animations play at once.
 */
export function createGiftQueue(opts: { maxConcurrent?: number; bigPrice?: number } = {}) {
  const maxConcurrent = opts.maxConcurrent ?? 2;
  const bigPrice = opts.bigPrice ?? 500;
  const pending: GiftMsg[] = [];
  const active: ActiveGift[] = [];
  let seedCounter = 1;

  return {
    push(gift: GiftMsg) {
      if (gift.gift.price >= bigPrice) {
        // insert after other big gifts already waiting, before the small ones
        const idx = pending.findIndex((g) => g.gift.price < bigPrice);
        if (idx === -1) pending.push(gift);
        else pending.splice(idx, 0, gift);
      } else {
        pending.push(gift);
      }
    },
    /** Advances the queue; returns the list of active animations for rendering. */
    tick(now: number): ActiveGift[] {
      for (let i = active.length - 1; i >= 0; i--) {
        if (now - active[i]!.startedAt >= active[i]!.durationMs) active.splice(i, 1);
      }
      while (active.length < maxConcurrent && pending.length > 0) {
        const gift = pending.shift()!;
        const anim = ANIMATIONS[gift.gift.animation];
        active.push({ gift, startedAt: now, durationMs: anim.durationMs, seed: seedCounter++ });
      }
      return active;
    },
    get pendingCount() {
      return pending.length;
    },
    get activeCount() {
      return active.length;
    },
  };
}
