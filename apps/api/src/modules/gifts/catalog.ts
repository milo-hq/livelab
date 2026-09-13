import type { Gift } from '@livelab/protocol';

/** Server-side price list. Clients never send prices; `POST /v1/gifts` prices `count × price` here. */
export const GIFTS: readonly Gift[] = [
  { id: 'rose', name: '玫瑰', price: 1, animation: 'hearts', icon: '🌹' },
  { id: 'coffee', name: '咖啡', price: 10, animation: 'hearts', icon: '☕' },
  { id: 'confetti', name: '彩带', price: 50, animation: 'confetti', icon: '🎉' },
  { id: 'rocket', name: '火箭', price: 500, animation: 'rocket', icon: '🚀' },
];

export const giftById = (id: string): Gift | undefined => GIFTS.find((g) => g.id === id);
