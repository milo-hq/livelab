import { describe, expect, it } from 'vitest';
import { createQueue } from './queue.js';

describe('createQueue', () => {
  it('accepts items up to max and reports size', () => {
    const q = createQueue<number>({ max: 3 });
    expect(q.push(1)).toBe(true);
    expect(q.push(2)).toBe(true);
    expect(q.push(3)).toBe(true);
    expect(q.size()).toBe(3);
  });

  it('drops NEW items when full (keeps the oldest)', () => {
    const q = createQueue<number>({ max: 2 });
    q.push(1);
    q.push(2);
    expect(q.push(3)).toBe(false);
    expect(q.size()).toBe(2);
    expect(q.drain()).toEqual([1, 2]);
  });

  it('drain empties the queue and returns items in FIFO order', () => {
    const q = createQueue<string>({ max: 10 });
    q.push('a');
    q.push('b');
    expect(q.drain()).toEqual(['a', 'b']);
    expect(q.size()).toBe(0);
    expect(q.drain()).toEqual([]);
  });

  it('take(n) removes only the first n items', () => {
    const q = createQueue<number>({ max: 10 });
    [1, 2, 3, 4].forEach((n) => q.push(n));
    expect(q.take(2)).toEqual([1, 2]);
    expect(q.size()).toBe(2);
    expect(q.take(10)).toEqual([3, 4]);
  });

  it('unshift re-inserts items at the front, still respecting max', () => {
    const q = createQueue<number>({ max: 3 });
    q.push(3);
    expect(q.unshift([1, 2])).toBe(2);
    expect(q.drain()).toEqual([1, 2, 3]);
    q.push(9);
    // Only two slots remain; the LAST items of the re-inserted list are dropped.
    expect(q.unshift([5, 6, 7])).toBe(2);
    expect(q.drain()).toEqual([5, 6, 9]);
  });
});
