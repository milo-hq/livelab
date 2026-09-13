import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { ServerFrame, type ClientFrame, type UserRef } from '@livelab/protocol';
import { buildApp } from '../../server.js';

/** In-process api on a random port with in-memory sqlite/bus/history (never touches 8787). */
export async function startTestApp() {
  const app = await buildApp({ dbPath: ':memory:', logger: false, cfg: { redisUrl: undefined, clickhouseUrl: undefined } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { app, port, url: `ws://127.0.0.1:${port}` };
}

export const token = (app: FastifyInstance, user: UserRef) => app.signToken(user);

export interface TestClient {
  ws: WebSocket;
  frames: ServerFrame[];
  send(frame: ClientFrame): void;
  /** Resolve with the first frame (not yet consumed by a previous `next`) matching `pred`. */
  next<T extends ServerFrame>(pred: (f: ServerFrame) => f is T, timeoutMs?: number): Promise<T>;
  next(pred: (f: ServerFrame) => boolean, timeoutMs?: number): Promise<ServerFrame>;
  closed: Promise<{ code: number; reason: string }>;
  close(): void;
}

/** Connect a real `ws` client; frames are validated with `ServerFrame` on the way in. */
export async function connect(url: string, query: { room?: string; token?: string }, opts: { hello?: boolean; lastSeq?: number } = {}): Promise<TestClient> {
  const q = new URLSearchParams();
  if (query.room !== undefined) q.set('room', query.room);
  if (query.token !== undefined) q.set('token', query.token);
  const ws = new WebSocket(`${url}/ws?${q}`);
  const frames: ServerFrame[] = [];
  const waiters: Array<{ pred: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }> = [];
  let cursor = 0;
  ws.on('message', (raw) => {
    const f = ServerFrame.parse(JSON.parse(raw.toString()));
    frames.push(f);
    for (let i = 0; i < waiters.length; i++) {
      const w = waiters[i]!;
      if (w.pred(f)) { waiters.splice(i, 1); cursor = frames.length; w.resolve(f); break; }
    }
  });
  const closed = new Promise<{ code: number; reason: string }>((res) => ws.on('close', (code, reason) => res({ code, reason: reason.toString() })));
  await new Promise<void>((res, rej) => { ws.once('open', res); ws.once('error', rej); ws.once('close', () => res()); });
  const client: TestClient = {
    ws,
    frames,
    send: (frame) => ws.send(JSON.stringify(frame)),
    next: ((pred: (f: ServerFrame) => boolean, timeoutMs = 3000) =>
      new Promise<ServerFrame>((resolve, reject) => {
        for (let i = cursor; i < frames.length; i++) {
          const f = frames[i]!;
          if (pred(f)) { cursor = i + 1; return resolve(f); }
        }
        const timer = setTimeout(() => reject(new Error(`timeout waiting for frame; got ${JSON.stringify(frames)}`)), timeoutMs);
        waiters.push({ pred, resolve: (f) => { clearTimeout(timer); resolve(f); } });
      })) as TestClient['next'],
    closed,
    close: () => ws.close(),
  };
  if (opts.hello && query.room) {
    client.send({ t: 'hello', room: query.room, ...(opts.lastSeq !== undefined ? { lastSeq: opts.lastSeq } : {}) });
    await client.next(isWelcome);
  }
  return client;
}

/** Poll until `cond()` is true (server-side close handlers run shortly after the client sees the close). */
export async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > until) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

export const isWelcome = (f: ServerFrame): f is Extract<ServerFrame, { t: 'welcome' }> => f.t === 'welcome';
export const isBatch = (f: ServerFrame): f is Extract<ServerFrame, { t: 'batch' }> => f.t === 'batch';
export const isPong = (f: ServerFrame): f is Extract<ServerFrame, { t: 'pong' }> => f.t === 'pong';
export const isError = (f: ServerFrame): f is Extract<ServerFrame, { t: 'error' }> => f.t === 'error';
export const isState = (f: ServerFrame): f is Extract<ServerFrame, { t: 'state' }> => f.t === 'state';
export const batchWith = (pred: (m: Extract<ServerFrame, { t: 'batch' }>['msgs'][number]) => boolean) =>
  (f: ServerFrame): f is Extract<ServerFrame, { t: 'batch' }> => f.t === 'batch' && f.msgs.some(pred);

export const viewer: UserRef = { id: 'u_viewer', name: 'Viewer', role: 'viewer' };
export const host: UserRef = { id: 'u_host', name: 'Host', role: 'host' };
export const admin: UserRef = { id: 'u_admin', name: 'Admin', role: 'admin' };
