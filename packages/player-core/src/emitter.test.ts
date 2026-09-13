import { describe, expect, it, vi } from 'vitest';
import { createEmitter } from './emitter.js';

type M = { a: { x: number }; b: {} };

describe('createEmitter', () => {
  it('delivers payloads to subscribers and supports unsubscribe', () => {
    const em = createEmitter<M>();
    const cb = vi.fn();
    const off = em.on('a', cb);
    em.emit('a', { x: 1 });
    expect(cb).toHaveBeenCalledWith({ x: 1 });
    off();
    em.emit('a', { x: 2 });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('isolates listener exceptions and clears all listeners', () => {
    const em = createEmitter<M>();
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    em.on('b', bad);
    em.on('b', good);
    expect(() => em.emit('b', {})).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    em.clear();
    em.emit('b', {});
    expect(good).toHaveBeenCalledTimes(1);
  });
});
