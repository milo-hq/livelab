/**
 * Bounded in-memory FIFO queue used to buffer telemetry events between flushes.
 *
 * Why a bounded queue? Telemetry must never hurt playback. If the ingest
 * endpoint is down for a long time an unbounded buffer would grow with every
 * heartbeat until the tab runs out of memory. We cap the buffer and, when it
 * is full, drop the *newest* item (`push` returns `false`). Dropping new items
 * rather than evicting old ones keeps the earliest part of a session (play
 * attempt, first frame, first stalls) intact, which is the part analysts care
 * about most when a session is broken.
 */
export interface QueueOptions {
  /** Maximum number of items held at once. */
  max: number;
}

export interface Queue<T> {
  /** Append an item. Returns `false` (and drops the item) when the queue is full. */
  push(item: T): boolean;
  /** Remove and return every item in FIFO order. */
  drain(): T[];
  /** Remove and return up to `n` items from the front. */
  take(n: number): T[];
  /**
   * Re-insert items at the front (used to retry a failed flush without
   * reordering events). Returns how many items fit; the tail of `items`
   * is dropped when there is not enough room.
   */
  unshift(items: T[]): number;
  size(): number;
}

export function createQueue<T>(opts: QueueOptions): Queue<T> {
  const max = Math.max(0, Math.floor(opts.max));
  let items: T[] = [];

  return {
    push(item) {
      if (items.length >= max) return false;
      items.push(item);
      return true;
    },
    drain() {
      const out = items;
      items = [];
      return out;
    },
    take(n) {
      return items.splice(0, Math.max(0, n));
    },
    unshift(incoming) {
      const room = Math.max(0, max - items.length);
      const accepted = incoming.slice(0, room);
      items = accepted.concat(items);
      return accepted.length;
    },
    size() {
      return items.length;
    },
  };
}
