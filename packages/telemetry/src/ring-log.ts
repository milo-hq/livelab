/**
 * Fixed-capacity ring buffer of log lines.
 *
 * Why a ring buffer instead of shipping every log line? Logs are only useful
 * for diagnosing *failures*, and shipping them continuously would cost far
 * more bandwidth than the metrics themselves. So the SDK keeps the last N
 * lines in memory (O(1) push, no reallocation once full) and attaches the
 * tail only to fatal errors and user-initiated issue reports. The buffer
 * silently overwrites the oldest line, so memory stays constant no matter
 * how long the tab lives.
 */
export interface RingLog {
  push(line: string): void;
  /** All retained lines, oldest first. */
  dump(): string[];
  /** The last `n` retained lines, oldest first. */
  tail(n: number): string[];
  size(): number;
}

export function createRingLog(cap = 500): RingLog {
  const capacity = Math.max(1, Math.floor(cap));
  const buf: string[] = new Array<string>(capacity);
  let head = 0; // index of the next write
  let count = 0; // number of valid entries (<= capacity)

  const dump = (): string[] => {
    const out: string[] = [];
    const start = (head - count + capacity) % capacity;
    for (let i = 0; i < count; i++) {
      const line = buf[(start + i) % capacity];
      if (line !== undefined) out.push(line);
    }
    return out;
  };

  return {
    push(line) {
      buf[head] = line;
      head = (head + 1) % capacity;
      if (count < capacity) count++;
    },
    dump,
    tail(n) {
      const all = dump();
      return n >= all.length ? all : all.slice(all.length - n);
    },
    size() {
      return count;
    },
  };
}
