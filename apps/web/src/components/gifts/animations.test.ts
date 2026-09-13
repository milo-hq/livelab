import { describe, expect, it } from 'vitest';
import { createGiftQueue } from './animations';
import type { GiftMsg } from '@livelab/protocol';

const user = { id: 'u', name: 'n', role: 'viewer' as const };
const gift = (id: string, price: number, animation: GiftMsg['gift']['animation'] = 'hearts'): GiftMsg =>
  ({ t: 'gift', lane: 'gift', seq: 1, room: 'r', ts: 1, id, user, count: 1, gift: { id, name: id, price, animation, icon: 'x' } });

describe('createGiftQueue', () => {
  it('plays at most maxConcurrent and lets big gifts jump the queue', () => {
    const q = createGiftQueue({ maxConcurrent: 1 });
    q.push(gift('a', 1));
    q.push(gift('b', 1));
    q.push(gift('rocket', 500, 'rocket'));
    q.push(gift('c', 1));
    // the rocket was pushed third but is played first: big gifts jump ahead of waiting small ones
    expect(q.tick(0).map((a) => a.gift.id)).toEqual(['rocket']);
    expect(q.pendingCount).toBe(3);
    // rocket (3200ms) finishes → small gifts resume in arrival order
    expect(q.tick(3200).map((a) => a.gift.id)).toEqual(['a']);
    expect(q.tick(3200 + 2200).map((a) => a.gift.id)).toEqual(['b']);
  });

  it('runs two animations concurrently', () => {
    const q = createGiftQueue({ maxConcurrent: 2 });
    q.push(gift('a', 1));
    q.push(gift('b', 50, 'confetti'));
    q.push(gift('c', 1));
    expect(q.tick(0)).toHaveLength(2);
    expect(q.activeCount).toBe(2);
    expect(q.pendingCount).toBe(1);
  });
});
