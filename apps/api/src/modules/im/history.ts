import type { Redis } from 'ioredis';
import { ServerMsg } from '@livelab/protocol';

/** Messages kept per room for resume-on-reconnect (`hello.lastSeq`). */
export const HISTORY_SIZE = 500;
/** Upper bound on one `welcome.history` payload. */
export const HISTORY_REPLAY_MAX = 200;

/**
 * Per-room sequence counter + recent-message window.
 *
 * `seq` is what makes reconnection cheap (docs/research/03 §1.4 "offset/epoch 恢复"): the client
 * remembers the highest seq it saw and sends it in `hello.lastSeq`; the server replays only what
 * was missed. When the gap is larger than the window the client gets the newest messages and must
 * treat the welcome as a full refresh (design spec §5 "超出历史窗口则全量刷新").
 */
export interface History {
  append(room: string, msg: ServerMsg): Promise<void>;
  /** Messages with `seq > since`, ascending. At most `limit` (the *newest* ones win when truncating). */
  since(room: string, since: number, limit?: number): Promise<ServerMsg[]>;
  /** Allocate the next seq for the room (monotonic, starts at 1). */
  nextSeq(room: string): Promise<number>;
  /** Highest seq allocated so far (0 for an untouched room). */
  latestSeq(room: string): Promise<number>;
}

export function createMemoryHistory(size = HISTORY_SIZE): History {
  const rings = new Map<string, ServerMsg[]>();
  const seqs = new Map<string, number>();
  return {
    async append(room, msg) {
      let ring = rings.get(room);
      if (!ring) rings.set(room, (ring = []));
      ring.push(msg);
      if (ring.length > size) ring.splice(0, ring.length - size);
    },
    async since(room, since, limit = HISTORY_REPLAY_MAX) {
      const ring = rings.get(room) ?? [];
      const out = ring.filter((m) => m.seq > since);
      return out.length > limit ? out.slice(out.length - limit) : out;
    },
    async nextSeq(room) {
      const n = (seqs.get(room) ?? 0) + 1;
      seqs.set(room, n);
      return n;
    },
    async latestSeq(room) {
      return seqs.get(room) ?? 0;
    },
  };
}

/**
 * Redis-backed history: `hist:<room>` is a list, newest first (`LPUSH` + `LTRIM 0 size-1`), and
 * `seq:<room>` is a plain counter (`INCR` is atomic, so several api instances can allocate seqs
 * concurrently without collisions).
 */
export function createRedisHistory(redis: Redis, size = HISTORY_SIZE): History {
  const hist = (room: string) => `hist:${room}`;
  const seq = (room: string) => `seq:${room}`;
  return {
    async append(room, msg) {
      await redis.multi().lpush(hist(room), JSON.stringify(msg)).ltrim(hist(room), 0, size - 1).exec();
    },
    async since(room, since, limit = HISTORY_REPLAY_MAX) {
      // Newest `limit` entries only: a client further behind than that gets a "full refresh" anyway.
      const raw = await redis.lrange(hist(room), 0, limit - 1);
      const out: ServerMsg[] = [];
      for (const s of raw) {
        let parsed: unknown;
        try { parsed = JSON.parse(s); } catch { continue; }
        const r = ServerMsg.safeParse(parsed);
        if (r.success && r.data.seq > since) out.push(r.data);
      }
      return out.reverse();
    },
    async nextSeq(room) {
      return redis.incr(seq(room));
    },
    async latestSeq(room) {
      const v = await redis.get(seq(room));
      return v ? Number(v) : 0;
    },
  };
}
