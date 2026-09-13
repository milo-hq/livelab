/**
 * Lane allocation for scrolling danmaku (bullet comments).
 *
 * The stage is `stageWidth` px wide. Every item enters at x = stageWidth (its left edge just
 * outside the right border) and moves left at a constant `speed` (px/s) until its right edge
 * passes x = 0. We use a *constant duration* model: every item takes `durationMs` to travel
 * `stageWidth + width` px, so wider items move faster. That is exactly why lane allocation
 * needs a catch-up check: a wide (fast) item entering behind a narrow (slow) one can overtake
 * it while both are still on screen.
 *
 * Each lane only remembers the *last* item that entered it. Because items in a lane move
 * left in entry order and only the newest one can be caught up by a newcomer, that is enough
 * to guarantee no overlap inside the lane.
 */

export interface LaneState {
  /** Width (px) of the last item that entered this lane. */
  lastWidth: number;
  /** Speed (px/s) of the last item that entered this lane. */
  lastSpeed: number;
  /** Timestamp (ms, same clock as `now`) at which the last item entered. `-Infinity` if never. */
  lastEnterAt: number;
}

/** Create `n` lanes that have never been used. */
export function freshLanes(n: number): LaneState[] {
  const lanes: LaneState[] = [];
  for (let i = 0; i < n; i++) {
    lanes.push({ lastWidth: 0, lastSpeed: 0, lastEnterAt: -Infinity });
  }
  return lanes;
}

/**
 * Pick the lowest lane index in which a new item (`width` px, `speed` px/s) can enter at `now`
 * without ever overlapping the previous item of that lane while both are on stage.
 * Returns -1 when no lane is free.
 *
 * For each lane, with the previous item P and the new item N:
 *
 *   elapsed   = (now - lastEnterAt) / 1000                 seconds since P entered
 *   lastRight = stageWidth + lastWidth - lastSpeed*elapsed  P's right edge right now
 *
 * Condition (a) — no overlap at the moment N enters:
 *   N's left edge is at x = stageWidth, so P must have its right edge at or before that:
 *   lastRight <= stageWidth  (P is fully on stage).
 *
 * Condition (b) — N must not catch P while P is still on stage:
 *   gap = stageWidth - lastRight            distance between P's right edge and N's left edge
 *   If speed <= lastSpeed the gap never shrinks: free.
 *   Otherwise the gap closes at (speed - lastSpeed) px/s, so
 *     tc = gap / (speed - lastSpeed)         time until N touches P
 *     tl = lastRight / lastSpeed             time until P's right edge crosses x = 0 (P is gone)
 *   The lane is free iff tc >= tl: by the time N would touch P, P has already left.
 *
 * `durationMs` is accepted for API symmetry with the renderer; the geometry above already
 * accounts for the constant-duration model through `speed` and `lastSpeed`.
 */
export function pickLane(
  lanes: readonly LaneState[],
  now: number,
  stageWidth: number,
  width: number,
  speed: number,
  durationMs: number,
): number {
  void width; // N's own width does not affect its entry geometry — only its speed does.
  void durationMs;
  for (let i = 0; i < lanes.length; i++) {
    const lane = lanes[i]!;
    if (lane.lastEnterAt === -Infinity) return i; // never used

    const elapsed = (now - lane.lastEnterAt) / 1000;
    const lastRight = stageWidth + lane.lastWidth - lane.lastSpeed * elapsed;

    if (lastRight <= 0) return i; // (a') previous item already left the stage entirely
    if (lastRight > stageWidth) continue; // (a) previous item still sticking out the right border

    if (speed <= lane.lastSpeed) return i; // (b) slower or equal: gap never closes

    const gap = stageWidth - lastRight;
    const tc = gap / (speed - lane.lastSpeed);
    const tl = lastRight / lane.lastSpeed;
    if (tc >= tl) return i;
  }
  return -1;
}
