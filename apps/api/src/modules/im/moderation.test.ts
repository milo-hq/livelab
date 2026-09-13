import { describe, expect, it } from 'vitest';
import { openDb } from '../../db.js';
import { DEFAULT_MUTE_SEC, Moderation } from './moderation.js';

function make(start = 100_000) {
  let now = start;
  const db = openDb(':memory:');
  const mod = new Moderation(db, () => now);
  return { mod, db, tick: (ms: number) => { now += ms; return now; }, now: () => now };
}

describe('Moderation', () => {
  it('slow mode: second post within the window is rejected with retryAfterMs', () => {
    const { mod, tick, now } = make();
    mod.slowMode('r', 10);
    expect(mod.canPost('r', 'u1', now())).toEqual({ ok: true });
    tick(3000);
    const v = mod.canPost('r', 'u1', now());
    expect(v).toMatchObject({ ok: false, code: 'slow_mode', retryAfterMs: 7000 });
    // another user is not affected
    expect(mod.canPost('r', 'u2', now())).toEqual({ ok: true });
    tick(7000);
    expect(mod.canPost('r', 'u1', now())).toEqual({ ok: true });
    // host/admin bypass slow mode
    expect(mod.canPost('r', 'u1', now(), { privileged: true })).toEqual({ ok: true });
  });

  it('rate limit: at most 5 messages per 10s', () => {
    const { mod, tick, now } = make();
    for (let i = 0; i < 5; i++) { expect(mod.canPost('r', 'u1', now())).toEqual({ ok: true }); tick(100); }
    const v = mod.canPost('r', 'u1', now());
    expect(v).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(v.ok === false && v.retryAfterMs).toBe(10_000 - 500);
    tick(9_500);
    expect(mod.canPost('r', 'u1', now())).toEqual({ ok: true });
  });

  it('mute is timed, ban is forever, unmute lifts both', () => {
    const { mod, tick, now } = make();
    mod.mute('r', 'u1', 60);
    expect(mod.isMuted('r', 'u1')).toBe(true);
    expect(mod.canPost('r', 'u1', now())).toMatchObject({ ok: false, code: 'muted', retryAfterMs: 60_000 });
    tick(60_001);
    expect(mod.isMuted('r', 'u1')).toBe(false);
    expect(mod.canPost('r', 'u1', now())).toEqual({ ok: true });
    mod.ban('r', 'u1');
    tick(365 * 24 * 3600 * 1000);
    const v = mod.canPost('r', 'u1', now(), { privileged: true });
    expect(v).toMatchObject({ ok: false, code: 'muted' });
    expect(v.ok === false && v.retryAfterMs).toBeUndefined();
    expect(mod.state('r')).toMatchObject({ banned: ['u1'], muted: [] });
    mod.unmute('r', 'u1');
    expect(mod.canPost('r', 'u1', now())).toEqual({ ok: true });
    expect(mod.mute('r', 'u2')).toBe(now() + DEFAULT_MUTE_SEC * 1000);
  });

  it('keyword filter masks occurrences case-insensitively and blocks pure-keyword messages', () => {
    const { mod } = make();
    mod.addKeyword('r', 'Spam');
    mod.addKeyword('r', 'bad word');
    expect(mod.state('r').keywords).toEqual(['spam', 'bad word']);
    expect(mod.filter('r', 'no SPAM here, spam!')).toBe('no *** here, ***!');
    expect(mod.filter('r', 'a Bad Word indeed')).toBe('a *** indeed');
    expect(mod.filter('r', 'clean')).toBe('clean');
    expect(mod.filter('r', '  spam ')).toBeNull();
    mod.removeKeyword('r', 'SPAM');
    expect(mod.filter('r', 'spam')).toBe('spam');
    expect(mod.filter('other', 'spam')).toBe('spam');
  });

  it('persists state per room in mod_state and reloads it', () => {
    const { mod, db } = make();
    mod.slowMode('r', 30);
    mod.ban('r', 'u9');
    mod.addKeyword('r', 'x');
    const again = new Moderation(db);
    expect(again.state('r')).toMatchObject({ slowModeSec: 30, banned: ['u9'], keywords: ['x'] });
    expect(again.state('other')).toEqual({ muted: [], banned: [], keywords: [], slowModeSec: 0 });
  });
});
