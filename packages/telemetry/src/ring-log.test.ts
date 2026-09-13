import { describe, expect, it } from 'vitest';
import { createRingLog } from './ring-log.js';

describe('createRingLog', () => {
  it('returns lines in insertion order while under capacity', () => {
    const log = createRingLog(3);
    log.push('a');
    log.push('b');
    expect(log.dump()).toEqual(['a', 'b']);
  });

  it('overwrites the oldest line once capacity is reached', () => {
    const log = createRingLog(3);
    ['a', 'b', 'c', 'd', 'e'].forEach((l) => log.push(l));
    expect(log.dump()).toEqual(['c', 'd', 'e']);
    expect(log.size()).toBe(3);
  });

  it('tail(n) returns the last n lines', () => {
    const log = createRingLog(500);
    for (let i = 0; i < 100; i++) log.push(`line ${i}`);
    expect(log.tail(2)).toEqual(['line 98', 'line 99']);
    expect(log.tail(1000)).toHaveLength(100);
  });

  it('defaults to a capacity of 500', () => {
    const log = createRingLog();
    for (let i = 0; i < 600; i++) log.push(String(i));
    expect(log.size()).toBe(500);
    expect(log.dump()[0]).toBe('100');
  });
});
