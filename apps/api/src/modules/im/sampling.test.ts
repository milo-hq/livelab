import { describe, expect, it } from 'vitest';
import type { ServerMsg } from '@livelab/protocol';
import { sampleRate, shouldDeliver } from './sampling.js';

const user = { id: 'u1', name: 'A', role: 'viewer' as const };
const chat: ServerMsg = { t: 'chat', lane: 'chat', seq: 1, room: 'r', ts: 0, id: 'm1', user, text: 'hi' };
const gift: ServerMsg = { t: 'gift', lane: 'gift', seq: 2, room: 'r', ts: 0, id: 'g1', user, gift: { id: 'g', name: 'Rocket', price: 100, animation: 'rocket', icon: '🚀' }, count: 1 };
const system: ServerMsg = { t: 'system', lane: 'system', seq: 3, room: 'r', ts: 0, kind: 'join', payload: {} };

describe('sampleRate', () => {
  it('tiers by online count', () => {
    expect(sampleRate(0)).toBe(1);
    expect(sampleRate(99)).toBe(1);
    expect(sampleRate(100)).toBe(0.5);
    expect(sampleRate(999)).toBe(0.5);
    expect(sampleRate(1000)).toBe(0.2);
    expect(sampleRate(9999)).toBe(0.2);
    expect(sampleRate(10000)).toBe(0.05);
    expect(sampleRate(1_000_000)).toBe(0.05);
  });
});

describe('shouldDeliver', () => {
  it('always delivers chat in small rooms without consulting rnd', () => {
    expect(shouldDeliver(chat, 50, () => 0.999)).toBe(true);
  });
  it('samples chat by rate in large rooms', () => {
    expect(shouldDeliver(chat, 500, () => 0.49)).toBe(true);
    expect(shouldDeliver(chat, 500, () => 0.51)).toBe(false);
    expect(shouldDeliver(chat, 50_000, () => 0.04)).toBe(true);
    expect(shouldDeliver(chat, 50_000, () => 0.06)).toBe(false);
  });
  it('never samples gift or system', () => {
    expect(shouldDeliver(gift, 1_000_000, () => 0.999)).toBe(true);
    expect(shouldDeliver(system, 1_000_000, () => 0.999)).toBe(true);
  });
});
