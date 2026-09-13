import type { ServerMsg } from '@livelab/protocol';

/**
 * Tiered chat sampling for hot rooms (docs/research/03 §1.4 pattern 1, as practised by 美拍/B站):
 * a viewer can only read a few dozen messages per second anyway, so above a size threshold the
 * server delivers a random fraction of the `chat` lane to each connection. Gifts, system notices
 * and host messages are business-critical and always go through — the lanes exist for this.
 */
export function sampleRate(online: number): number {
  if (online < 100) return 1;
  if (online < 1000) return 0.5;
  if (online < 10000) return 0.2;
  return 0.05;
}

/** Decide, per connection, whether `msg` is delivered. `rnd` is injectable for tests. */
export function shouldDeliver(msg: ServerMsg, online: number, rnd: () => number = Math.random): boolean {
  if (msg.lane !== 'chat') return true;
  const rate = sampleRate(online);
  return rate >= 1 || rnd() < rate;
}
