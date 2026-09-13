import type { RoomHub } from './hub.js';

/**
 * Like aggregation. Clients already coalesce clicks (`like{n}` every 500ms); the server folds all
 * viewers' counts into one `like_agg{count,total}` per room per second, so a room with 10k
 * enthusiastic viewers costs one broadcast per second instead of thousands.
 */
export class Likes {
  private readonly pending = new Map<string, number>();
  private readonly totals = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly hub: RoomHub, private readonly intervalMs = 1000) {}

  add(room: string, n: number): void {
    if (this.closed) return;
    this.pending.set(room, (this.pending.get(room) ?? 0) + n);
    if (!this.totals.has(room)) this.totals.set(room, this.hub.state(room).likes);
    if (!this.timer) this.timer = setTimeout(() => this.tick(), this.intervalMs);
  }

  total(room: string): number {
    return this.totals.get(room) ?? 0;
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private tick(): void {
    this.timer = null;
    for (const [room, count] of this.pending) {
      if (count <= 0) continue;
      const total = (this.totals.get(room) ?? 0) + count;
      this.totals.set(room, total);
      void this.hub.broadcast(room, { t: 'like_agg', lane: 'system', room, count, total }).catch(() => {});
    }
    this.pending.clear();
  }
}
