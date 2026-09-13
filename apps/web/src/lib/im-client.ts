import { ClientFrame, ServerFrame } from '@livelab/protocol';

export type ImStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface ImClientOptions {
  /** Base ws url, e.g. `ws://localhost:5174/ws` (Vite proxies it to the api). */
  url: string;
  room: string;
  token: string;
  onFrame: (frame: ServerFrame) => void;
  onStatus?: (status: ImStatus, info?: { attempt: number; delayMs?: number }) => void;
  /** Injectable for tests. */
  WebSocketImpl?: typeof WebSocket;
  pingIntervalMs?: number;
  maxBackoffMs?: number;
  random?: () => number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}

export interface ImClient {
  send(frame: ClientFrame): boolean;
  close(): void;
  readonly lastSeq: number;
  readonly status: ImStatus;
}

/**
 * Exponential backoff with jitter: 1s, 2s, 4s … capped at `max`, plus 0–500ms jitter so a fleet of
 * clients reconnecting after a gateway restart does not stampede the server at the same instant.
 */
export function backoffDelay(attempt: number, max = 20_000, random = Math.random): number {
  const base = Math.min(max, 1000 * 2 ** Math.max(0, attempt - 1));
  return base + Math.floor(random() * 500);
}

/**
 * Minimal resilient WebSocket client for the room protocol:
 *  - sends `hello{room, lastSeq}` on every (re)connect so the server replays what we missed;
 *  - tracks the highest `seq` seen so the resume point is always exact;
 *  - pings every 25s (server closes idle sockets after 60s);
 *  - reconnects with exponential backoff + jitter, never in a tight loop.
 */
export function createImClient(opts: ImClientOptions): ImClient {
  const WS = opts.WebSocketImpl ?? WebSocket;
  const setT = opts.setTimeoutImpl ?? setTimeout;
  const clearT = opts.clearTimeoutImpl ?? clearTimeout;
  const pingEvery = opts.pingIntervalMs ?? 25_000;
  let ws: WebSocket | null = null;
  let status: ImStatus = 'connecting';
  let attempt = 0;
  let lastSeq = 0;
  let closedByUser = false;
  let pingTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const setStatus = (s: ImStatus, info?: { attempt: number; delayMs?: number }) => {
    status = s;
    opts.onStatus?.(s, info);
  };

  const schedulePing = () => {
    if (pingTimer) clearT(pingTimer);
    pingTimer = setT(() => {
      if (ws?.readyState === WS.OPEN) ws.send(JSON.stringify({ t: 'ping', ts: Date.now() } satisfies ClientFrame));
      schedulePing();
    }, pingEvery);
  };

  const connect = () => {
    const url = `${opts.url}?room=${encodeURIComponent(opts.room)}&token=${encodeURIComponent(opts.token)}`;
    ws = new WS(url);
    ws.onopen = () => {
      attempt = 0;
      setStatus('open', { attempt });
      const hello: ClientFrame = lastSeq > 0 ? { t: 'hello', room: opts.room, lastSeq } : { t: 'hello', room: opts.room };
      ws?.send(JSON.stringify(hello));
      schedulePing();
    };
    ws.onmessage = (ev) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const r = ServerFrame.safeParse(parsed);
      if (!r.success) return;
      const frame = r.data;
      if (frame.t === 'welcome') lastSeq = Math.max(lastSeq, frame.seq);
      if (frame.t === 'batch') for (const m of frame.msgs) lastSeq = Math.max(lastSeq, m.seq);
      opts.onFrame(frame);
    };
    ws.onclose = () => {
      if (pingTimer) clearT(pingTimer);
      if (closedByUser) return setStatus('closed');
      attempt += 1;
      const delayMs = backoffDelay(attempt, opts.maxBackoffMs, opts.random);
      setStatus('reconnecting', { attempt, delayMs });
      reconnectTimer = setT(connect, delayMs);
    };
    ws.onerror = () => {
      // onclose always follows onerror; nothing to do here.
    };
  };

  connect();

  return {
    send(frame) {
      if (ws?.readyState !== WS.OPEN) return false;
      ws.send(JSON.stringify(frame));
      return true;
    },
    close() {
      closedByUser = true;
      if (pingTimer) clearT(pingTimer);
      if (reconnectTimer) clearT(reconnectTimer);
      ws?.close();
    },
    get lastSeq() {
      return lastSeq;
    },
    get status() {
      return status;
    },
  };
}
