import { Redis } from 'ioredis';
import { ServerMsg } from '@livelab/protocol';

/**
 * Room fan-out bus. Every broadcast is published here and each api instance's subscriber delivers
 * it to its *local* WebSocket connections, so N instances behind a load balancer all see the same
 * message stream (docs/research/03 §1.3: the "Comet/Job" split of goim, or Twitch's pubsub tree).
 *
 * Single-process deployments (and tests) use the in-memory bus; with `REDIS_URL` set and reachable
 * the Redis bus is used — channel `room:<roomId>`, JSON `ServerMsg` payloads.
 */
export interface Bus {
  publish(room: string, msg: ServerMsg): Promise<void>;
  subscribe(room: string, cb: (m: ServerMsg) => void): () => void;
  close(): Promise<void>;
}

export function createMemoryBus(): Bus {
  const subs = new Map<string, Set<(m: ServerMsg) => void>>();
  return {
    async publish(room, msg) {
      const set = subs.get(room);
      if (!set) return;
      for (const cb of [...set]) cb(msg);
    },
    subscribe(room, cb) {
      let set = subs.get(room);
      if (!set) subs.set(room, (set = new Set()));
      set.add(cb);
      return () => {
        set.delete(cb);
        if (set.size === 0) subs.delete(room);
      };
    },
    async close() {
      subs.clear();
    },
  };
}

export interface RedisBus extends Bus {
  /** Resolves once both connections are ready; rejects (after `timeoutMs`) when Redis is unreachable. */
  ready(timeoutMs?: number): Promise<void>;
  /** The publishing connection — safe to reuse for plain commands (the history keeps its lists here). */
  client: Redis;
}

const channel = (room: string) => `room:${room}`;

/**
 * Redis Pub/Sub needs two connections: a connection in subscriber mode can only issue
 * SUBSCRIBE/UNSUBSCRIBE, so publishing (and any other command) must go over a second one.
 */
export function createRedisBus(url: string, opts: { onError?: (e: unknown) => void } = {}): RedisBus {
  const onError = opts.onError ?? (() => {});
  const redisOpts = { lazyConnect: true, maxRetriesPerRequest: 2, enableOfflineQueue: false, retryStrategy: (n: number) => Math.min(200 * n, 2000) };
  const pub = new Redis(url, redisOpts);
  const sub = new Redis(url, redisOpts);
  pub.on('error', onError);
  sub.on('error', onError);
  const subs = new Map<string, Set<(m: ServerMsg) => void>>();

  sub.on('message', (ch: string, payload: string) => {
    const set = subs.get(ch.startsWith('room:') ? ch.slice(5) : ch);
    if (!set) return;
    let parsed: unknown;
    try { parsed = JSON.parse(payload); } catch { return; }
    // Validate at the trust boundary: another instance (or a stray publisher) may send garbage.
    const r = ServerMsg.safeParse(parsed);
    if (!r.success) return;
    for (const cb of [...set]) cb(r.data);
  });
  // Subscriptions do not survive a reconnect on a fresh connection; re-issue them.
  sub.on('ready', () => {
    if (subs.size) sub.subscribe(...[...subs.keys()].map(channel)).catch(onError);
  });

  return {
    client: pub,
    async ready(timeoutMs = 2000) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`redis connect timeout after ${timeoutMs}ms`)), timeoutMs); });
      try {
        await Promise.race([Promise.all([pub.connect(), sub.connect()]), timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
    async publish(room, msg) {
      await pub.publish(channel(room), JSON.stringify(msg));
    },
    subscribe(room, cb) {
      let set = subs.get(room);
      if (!set) {
        subs.set(room, (set = new Set()));
        sub.subscribe(channel(room)).catch(onError);
      }
      set.add(cb);
      return () => {
        set.delete(cb);
        if (set.size === 0) {
          subs.delete(room);
          sub.unsubscribe(channel(room)).catch(onError);
        }
      };
    },
    async close() {
      subs.clear();
      // `disconnect()` (not `quit()`): never wait on a server that may already be gone.
      pub.disconnect();
      sub.disconnect();
    },
  };
}
