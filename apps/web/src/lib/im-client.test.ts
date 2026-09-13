import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backoffDelay, createImClient } from './im-client';

class FakeWS {
  static instances: FakeWS[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = FakeWS.CLOSED;
    this.onclose?.();
  }
  open() {
    this.readyState = FakeWS.OPEN;
    this.onopen?.();
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const user = { id: 'u', name: 'n', role: 'viewer' as const };

describe('backoffDelay', () => {
  it('doubles from 1s and caps', () => {
    const r = () => 0;
    expect(backoffDelay(1, 20_000, r)).toBe(1000);
    expect(backoffDelay(2, 20_000, r)).toBe(2000);
    expect(backoffDelay(3, 20_000, r)).toBe(4000);
    expect(backoffDelay(10, 20_000, r)).toBe(20_000);
  });
});

describe('createImClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWS.instances = [];
  });
  afterEach(() => vi.useRealTimers());

  it('sends hello on open and resumes with the highest seq seen after reconnect', () => {
    const frames: unknown[] = [];
    const statuses: string[] = [];
    createImClient({ url: 'ws://x/ws', room: 'demo', token: 't', onFrame: (f) => frames.push(f), onStatus: (s) => statuses.push(s),
      WebSocketImpl: FakeWS as unknown as typeof WebSocket, random: () => 0 });
    const ws1 = FakeWS.instances[0]!;
    expect(ws1.url).toContain('room=demo');
    ws1.open();
    expect(JSON.parse(ws1.sent[0]!)).toEqual({ t: 'hello', room: 'demo' });
    ws1.receive({ t: 'welcome', seq: 5, state: { online: 1, slowModeSec: 0, pinned: null, announce: null, poll: null, likes: 0 }, history: [] });
    ws1.receive({ t: 'batch', msgs: [{ t: 'chat', lane: 'chat', seq: 7, room: 'demo', ts: 1, id: 'm', user, text: 'hi' }] });
    expect(frames).toHaveLength(2);

    ws1.close(); // server drop
    expect(statuses.at(-1)).toBe('reconnecting');
    vi.advanceTimersByTime(1000);
    const ws2 = FakeWS.instances[1]!;
    ws2.open();
    expect(JSON.parse(ws2.sent[0]!)).toEqual({ t: 'hello', room: 'demo', lastSeq: 7 });
  });

  it('backs off 1s, 2s, 4s between attempts', () => {
    createImClient({ url: 'ws://x/ws', room: 'r', token: 't', onFrame: () => {}, WebSocketImpl: FakeWS as unknown as typeof WebSocket, random: () => 0 });
    FakeWS.instances[0]!.close();
    vi.advanceTimersByTime(999);
    expect(FakeWS.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWS.instances).toHaveLength(2);
    FakeWS.instances[1]!.close();
    vi.advanceTimersByTime(1999);
    expect(FakeWS.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWS.instances).toHaveLength(3);
    FakeWS.instances[2]!.close();
    vi.advanceTimersByTime(4000);
    expect(FakeWS.instances).toHaveLength(4);
  });

  it('pings every interval while open and stops after close()', () => {
    const c = createImClient({ url: 'ws://x/ws', room: 'r', token: 't', onFrame: () => {}, WebSocketImpl: FakeWS as unknown as typeof WebSocket, pingIntervalMs: 1000 });
    const ws = FakeWS.instances[0]!;
    ws.open();
    vi.advanceTimersByTime(2000);
    expect(ws.sent.filter((s) => s.includes('"ping"'))).toHaveLength(2);
    c.close();
    vi.advanceTimersByTime(5000);
    expect(ws.sent.filter((s) => s.includes('"ping"'))).toHaveLength(2);
    expect(c.status).toBe('closed');
  });

  it('ignores malformed frames', () => {
    const frames: unknown[] = [];
    createImClient({ url: 'ws://x/ws', room: 'r', token: 't', onFrame: (f) => frames.push(f), WebSocketImpl: FakeWS as unknown as typeof WebSocket });
    const ws = FakeWS.instances[0]!;
    ws.open();
    ws.onmessage?.({ data: 'not json' });
    ws.receive({ t: 'weird' });
    expect(frames).toHaveLength(0);
  });
});
