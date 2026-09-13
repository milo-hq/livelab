import { describe, expect, it } from 'vitest';
import { ClientFrame, ServerFrame, type ServerMsg } from './im.js';

describe('ClientFrame', () => {
  it('trims chat text', () => {
    const f = ClientFrame.parse({ t: 'chat', cid: 'a', text: '  hi  ' });
    expect(f).toEqual({ t: 'chat', cid: 'a', text: 'hi' });
  });
  it('rejects chat longer than 200 chars', () => {
    expect(() => ClientFrame.parse({ t: 'chat', cid: 'a', text: 'x'.repeat(201) })).toThrow();
  });
  it('rejects unknown frame type', () => {
    expect(() => ClientFrame.parse({ t: 'nope' })).toThrow();
  });
});

describe('ServerFrame', () => {
  it('round-trips a batch with chat and gift', () => {
    const user = { id: 'u1', name: 'Ann', role: 'viewer' as const };
    const msgs: ServerMsg[] = [
      { t: 'chat', lane: 'chat', seq: 1, room: 'r', ts: 1, id: 'm1', user, text: 'hello' },
      { t: 'gift', lane: 'gift', seq: 2, room: 'r', ts: 2, id: 'm2', user, count: 1,
        gift: { id: 'rose', name: 'Rose', price: 1, animation: 'hearts', icon: '🌹' } },
    ];
    const parsed = ServerFrame.parse(JSON.parse(JSON.stringify({ t: 'batch', msgs })));
    expect(parsed).toEqual({ t: 'batch', msgs });
  });
});
