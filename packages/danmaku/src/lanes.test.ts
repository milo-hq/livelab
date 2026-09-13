import { describe, expect, it } from 'vitest';
import { freshLanes, pickLane, type LaneState } from './lanes.js';

const STAGE = 1000;
const DURATION = 8000;

/** Speed under the constant-duration model: every item crosses stage+width in DURATION. */
const speedFor = (width: number) => (STAGE + width) / (DURATION / 1000);

describe('freshLanes', () => {
  it('creates n lanes that have never been used', () => {
    const lanes = freshLanes(3);
    expect(lanes).toHaveLength(3);
    for (const lane of lanes) {
      expect(lane).toEqual({ lastWidth: 0, lastSpeed: 0, lastEnterAt: -Infinity });
    }
  });
});

describe('pickLane', () => {
  it('returns 0 when every lane is empty', () => {
    const lanes = freshLanes(3);
    expect(pickLane(lanes, 0, STAGE, 100, speedFor(100), DURATION)).toBe(0);
  });

  it('skips lane 0 when a wide item entered it just now', () => {
    const lanes = freshLanes(3);
    const w = 400;
    lanes[0] = { lastWidth: w, lastSpeed: speedFor(w), lastEnterAt: 1000 };
    // At now === lastEnterAt the previous item is still entirely off-stage to the right,
    // so it would overlap the new one at x = stageWidth.
    expect(pickLane(lanes, 1000, STAGE, 100, speedFor(100), DURATION)).toBe(1);
  });

  it('returns -1 when all lanes are busy', () => {
    const w = 400;
    const lanes: LaneState[] = [
      { lastWidth: w, lastSpeed: speedFor(w), lastEnterAt: 1000 },
      { lastWidth: w, lastSpeed: speedFor(w), lastEnterAt: 1000 },
    ];
    expect(pickLane(lanes, 1000, STAGE, 100, speedFor(100), DURATION)).toBe(-1);
  });

  it('is free once the previous item is fully on stage and the new one is slower', () => {
    const lanes = freshLanes(1);
    const w = 400;
    const speed = speedFor(w); // 175 px/s
    // 400px wide item needs 400/175 ≈ 2.29 s to be fully on stage. After 3 s its right edge is
    // at 1000 + 400 - 175 * 3 = 875 < 1000, so the gap at entry is positive.
    lanes[0] = { lastWidth: w, lastSpeed: speed, lastEnterAt: 0 };
    // A narrower (hence slower) item can never catch up: lane is free.
    expect(pickLane(lanes, 3000, STAGE, 100, speedFor(100), DURATION)).toBe(0);
  });

  it('rejects a faster new item that would catch the previous one before it exits', () => {
    const lanes = freshLanes(1);
    // Previous: narrow and slow. After 1.5 s its right edge is 1000 + 100 - 137.5*1.5 ≈ 893.75.
    lanes[0] = { lastWidth: 100, lastSpeed: speedFor(100), lastEnterAt: 0 };
    // New: very wide and fast (900 px → 237.5 px/s).
    // gap = 1000 - 893.75 = 106.25; closes at 237.5 - 137.5 = 100 px/s → tc ≈ 1.06 s.
    // Previous exits at tl = 893.75 / 137.5 ≈ 6.5 s. tc < tl → collision → -1.
    expect(pickLane(lanes, 1500, STAGE, 900, speedFor(900), DURATION)).toBe(-1);
  });

  it('accepts a faster new item when the catch-up happens only after the previous one exits', () => {
    const lanes = freshLanes(1);
    // Previous: narrow and slow (137.5 px/s). After 7 s its right edge is
    // 1000 + 100 - 137.5*7 = 137.5 → it leaves the stage in tl = 1 s.
    lanes[0] = { lastWidth: 100, lastSpeed: speedFor(100), lastEnterAt: 0 };
    // New: wider and faster (300 px → 162.5 px/s). gap = 862.5, closing at 25 px/s → tc = 34.5 s.
    // tc >= tl → no collision on stage → lane 0.
    expect(pickLane(lanes, 7000, STAGE, 300, speedFor(300), DURATION)).toBe(0);
  });

  it('is free after the previous item has completely left the stage', () => {
    const lanes = freshLanes(1);
    const w = 900;
    lanes[0] = { lastWidth: w, lastSpeed: speedFor(w), lastEnterAt: 0 };
    // Any item faster than the previous one is fine once the previous one is gone.
    expect(pickLane(lanes, DURATION + 1, STAGE, 950, speedFor(950), DURATION)).toBe(0);
  });

  it('picks the lowest free lane index', () => {
    const lanes = freshLanes(4);
    const busy = { lastWidth: 400, lastSpeed: speedFor(400), lastEnterAt: 1000 };
    lanes[0] = { ...busy };
    lanes[1] = { ...busy };
    lanes[3] = { ...busy };
    expect(pickLane(lanes, 1000, STAGE, 100, speedFor(100), DURATION)).toBe(2);
  });
});
