import { ServerMsg, type RoomState, type ServerFrame, type UserRef } from '@livelab/protocol';
import type { Bus } from './bus.js';
import type { History } from './history.js';
import { shouldDeliver } from './sampling.js';

/** A connected client as seen by the hub (the WebSocket route adapts `ws` sockets to this). */
export interface Conn {
  id: string;
  user: UserRef;
  send(frame: ServerFrame): void;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** What callers hand to `broadcast()`: the hub stamps `seq` and `ts`. */
export type MsgInput = DistributiveOmit<ServerMsg, 'seq' | 'ts'>;

export type VoteResult = 'ok' | 'no_poll' | 'ended' | 'bad_option' | 'already_voted';

export interface HubDeps {
  bus: Bus;
  history: History;
  /** Batch window; 100–200ms is the sweet spot between latency and per-frame overhead. */
  batchMs?: number;
  /** Outbound queue cap per connection (slow consumers). */
  queueCap?: number;
  /** Rooms with fewer viewers than this get "X joined" notices; large rooms would drown in them. */
  joinNoticeBelow?: number;
  /** Minimum interval between `online` count broadcasts per room. */
  onlineEveryMs?: number;
  /** Per-room state seed (e.g. persisted slow-mode) applied when a room is first touched. */
  initialState?: (room: string) => Partial<RoomState>;
  now?: () => number;
  rnd?: () => number;
}

interface ConnEntry {
  conn: Conn;
  queue: ServerMsg[];
  flushTimer: NodeJS.Timeout | null;
  /** False until the welcome frame went out; nothing is flushed before that. */
  ready: boolean;
}

interface RoomEntry {
  conns: Map<string, ConnEntry>;
  state: Omit<RoomState, 'online'>;
  unsubscribe: () => void;
  /** Timestamps of messages seen in the last minute (for `msgRate`). */
  msgTimes: number[];
  onlineTimer: NodeJS.Timeout | null;
  onlineDirty: boolean;
  /** Users who voted in the current poll (one vote per user per poll). */
  voters: Set<string>;
}

const RATE_WINDOW_MS = 60_000;

/**
 * Room hub: membership, sequencing, history, fan-out and per-connection batching.
 *
 * Delivery pipeline for one message (docs/research/03 §1.4):
 *   broadcast() → seq (history.nextSeq) → history.append → bus.publish
 *     → every instance's subscriber → per-connection sampling (chat lane only) → outbound queue
 *     → one `batch` frame per connection every `batchMs` (fewer syscalls, one React commit per tick)
 *
 * Slow consumers: the queue is capped; when full the oldest `chat` messages are dropped first, and
 * `gift`/`system` are never dropped (a viewer who misses a gift animation is a support ticket).
 */
export class RoomHub {
  private readonly rooms = new Map<string, RoomEntry>();
  private readonly bus: Bus;
  private readonly history: History;
  private readonly batchMs: number;
  private readonly queueCap: number;
  private readonly joinNoticeBelow: number;
  private readonly onlineEveryMs: number;
  private readonly initialState: (room: string) => Partial<RoomState>;
  private readonly now: () => number;
  private readonly rnd: () => number;
  private closed = false;

  constructor(deps: HubDeps) {
    this.bus = deps.bus;
    this.history = deps.history;
    this.batchMs = deps.batchMs ?? 150;
    this.queueCap = deps.queueCap ?? 200;
    this.joinNoticeBelow = deps.joinNoticeBelow ?? 100;
    this.onlineEveryMs = deps.onlineEveryMs ?? 2000;
    this.initialState = deps.initialState ?? (() => ({}));
    this.now = deps.now ?? Date.now;
    this.rnd = deps.rnd ?? Math.random;
  }

  // ---------------------------------------------------------------------------------------------
  // Membership
  // ---------------------------------------------------------------------------------------------

  /**
   * Register `conn` in `room` and send `welcome{seq, state, history}`.
   * `lastSeq` = resume: replay everything after it; undefined = fresh join: the last 50 messages.
   */
  async join(room: string, conn: Conn, lastSeq?: number): Promise<void> {
    const r = this.room(room);
    const entry: ConnEntry = { conn, queue: [], flushTimer: null, ready: false };
    // Register before reading history so nothing published in between is lost; duplicates
    // (in history *and* queued) are removed below by seq.
    r.conns.set(conn.id, entry);
    const [seq, history] = await Promise.all([
      this.history.latestSeq(room),
      lastSeq === undefined ? this.history.since(room, 0, 50) : this.history.since(room, lastSeq),
    ]);
    if (r.conns.get(conn.id) !== entry) return; // left while we were reading
    conn.send({ t: 'welcome', seq, state: this.state(room), history });
    entry.ready = true;
    entry.queue = entry.queue.filter((m) => m.seq > seq);
    if (entry.queue.length) this.scheduleFlush(entry);

    if (r.conns.size < this.joinNoticeBelow) {
      void this.broadcast(room, { t: 'system', lane: 'system', room, kind: 'join', payload: { user: conn.user } }).catch(() => {});
    }
    this.scheduleOnline(room);
  }

  leave(room: string, conn: Conn): void {
    const r = this.rooms.get(room);
    const entry = r?.conns.get(conn.id);
    if (!r || !entry) return;
    r.conns.delete(conn.id);
    if (entry.flushTimer) clearTimeout(entry.flushTimer);
    entry.flushTimer = null;
    this.scheduleOnline(room);
  }

  online(room: string): number {
    return this.rooms.get(room)?.conns.size ?? 0;
  }

  /** Room ids this instance has touched (joined or broadcast to). */
  roomIds(): string[] {
    return [...this.rooms.keys()];
  }

  // ---------------------------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------------------------

  /** Stamp seq/ts, persist to history and publish on the bus. Resolves with the final message. */
  async broadcast(room: string, partial: MsgInput): Promise<ServerMsg> {
    this.room(room);
    const seq = await this.history.nextSeq(room);
    const msg = ServerMsg.parse({ ...partial, seq, ts: this.now() });
    await this.history.append(room, msg);
    await this.bus.publish(room, msg);
    return msg;
  }

  /** Messages per second over the last minute (admin overview). */
  msgRate(room: string): number {
    const r = this.rooms.get(room);
    if (!r) return 0;
    this.pruneRate(r);
    return r.msgTimes.length / (RATE_WINDOW_MS / 1000);
  }

  // ---------------------------------------------------------------------------------------------
  // Room state
  // ---------------------------------------------------------------------------------------------

  state(room: string): RoomState {
    const r = this.room(room);
    return { ...r.state, online: r.conns.size };
  }

  /**
   * Merge `patch` into the room state and push a `state` frame to local connections right away
   * (not batched, not sequenced: it is a snapshot, not an event — a late joiner gets it in `welcome`).
   */
  setState(room: string, patch: Partial<Omit<RoomState, 'online'>>): RoomState {
    const r = this.room(room);
    Object.assign(r.state, patch);
    const frame: ServerFrame = { t: 'state', state: patch };
    for (const e of r.conns.values()) if (e.ready) e.conn.send(frame);
    return this.state(room);
  }

  /** Start a poll: resets the voter set so one user can vote once per poll. */
  startPoll(room: string, poll: RoomState['poll']): void {
    const r = this.room(room);
    r.voters.clear();
    this.setState(room, { poll });
  }

  vote(room: string, pollId: string, option: number, userId: string): VoteResult {
    const r = this.room(room);
    const poll = r.state.poll;
    if (!poll || poll.id !== pollId) return 'no_poll';
    if (poll.endsAt <= this.now()) return 'ended';
    if (option < 0 || option >= poll.options.length) return 'bad_option';
    if (r.voters.has(userId)) return 'already_voted';
    r.voters.add(userId);
    const votes = poll.votes.slice();
    votes[option] = (votes[option] ?? 0) + 1;
    this.setState(room, { poll: { ...poll, votes } });
    return 'ok';
  }

  // ---------------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------------

  async close(): Promise<void> {
    this.closed = true;
    for (const r of this.rooms.values()) {
      r.unsubscribe();
      if (r.onlineTimer) clearTimeout(r.onlineTimer);
      for (const e of r.conns.values()) if (e.flushTimer) clearTimeout(e.flushTimer);
      r.conns.clear();
    }
    this.rooms.clear();
  }

  // ---------------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------------

  private room(room: string): RoomEntry {
    let r = this.rooms.get(room);
    if (r) return r;
    r = {
      conns: new Map(),
      state: { slowModeSec: 0, pinned: null, announce: null, poll: null, likes: 0, cohosts: [], ...this.initialState(room) },
      unsubscribe: this.bus.subscribe(room, (m) => this.onBusMessage(room, m)),
      msgTimes: [],
      onlineTimer: null,
      onlineDirty: false,
      voters: new Set(),
    };
    this.rooms.set(room, r);
    return r;
  }

  /** Every instance runs this for every message of every room it has touched. */
  private onBusMessage(room: string, msg: ServerMsg): void {
    const r = this.rooms.get(room);
    if (!r || this.closed) return;
    r.msgTimes.push(this.now());
    if (r.msgTimes.length > 5000) this.pruneRate(r);
    // The like total rides on `like_agg`, so every instance's state converges without a state frame.
    if (msg.t === 'like_agg') r.state.likes = msg.total;
    const online = r.conns.size;
    for (const e of r.conns.values()) {
      if (!shouldDeliver(msg, online, this.rnd)) continue;
      this.enqueue(e, msg);
    }
  }

  private enqueue(e: ConnEntry, msg: ServerMsg): void {
    e.queue.push(msg);
    if (e.queue.length > this.queueCap) {
      // Drop the oldest chat first; gift/system stay even if that means running over the cap.
      const i = e.queue.findIndex((m) => m.lane === 'chat');
      if (i >= 0) e.queue.splice(i, 1);
    }
    if (e.ready) this.scheduleFlush(e);
  }

  private scheduleFlush(e: ConnEntry): void {
    if (e.flushTimer) return;
    e.flushTimer = setTimeout(() => {
      e.flushTimer = null;
      if (e.queue.length === 0) return;
      const msgs = e.queue;
      e.queue = [];
      e.conn.send({ t: 'batch', msgs });
    }, this.batchMs);
  }

  /**
   * Online count notices are coalesced: at most one per `onlineEveryMs` per room, trailing edge,
   * so a burst of joins/leaves costs one message. (Single-instance count: `online` here is the
   * number of local connections.)
   */
  private scheduleOnline(room: string): void {
    const r = this.rooms.get(room);
    if (!r || this.closed) return;
    if (r.onlineTimer) {
      r.onlineDirty = true;
      return;
    }
    r.onlineDirty = false;
    r.onlineTimer = setTimeout(() => {
      r.onlineTimer = null;
      if (this.closed) return;
      void this.broadcast(room, { t: 'system', lane: 'system', room, kind: 'online', payload: { online: r.conns.size } }).catch(() => {});
      if (r.onlineDirty) this.scheduleOnline(room);
    }, this.onlineEveryMs);
  }

  private pruneRate(r: RoomEntry): void {
    const cutoff = this.now() - RATE_WINDOW_MS;
    let i = 0;
    while (i < r.msgTimes.length && (r.msgTimes[i] ?? 0) < cutoff) i++;
    if (i > 0) r.msgTimes.splice(0, i);
  }
}
