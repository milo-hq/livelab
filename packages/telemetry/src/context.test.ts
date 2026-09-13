import { describe, expect, it } from 'vitest';
import { createSessionId, createViewId, fnv1a, isSampled, nowMs, parseUserAgent } from './context.js';

describe('parseUserAgent', () => {
  const cases: Array<[string, string, string]> = [
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'iOS',
      'Safari',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
      'Android',
      'Chrome',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'macOS',
      'Chrome',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
      'macOS',
      'Safari',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
      'Windows',
      'Edge',
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0', 'Linux', 'Firefox'],
    ['curl/8.4.0', 'other', 'other'],
  ];
  it.each(cases)('%s', (ua, os, browser) => {
    expect(parseUserAgent(ua)).toEqual({ os, browser });
  });
});

describe('fnv1a', () => {
  it('is deterministic and matches known vectors', () => {
    expect(fnv1a('')).toBe(0x811c9dc5);
    expect(fnv1a('a')).toBe(0xe40c292c);
    expect(fnv1a('foobar')).toBe(0xbf9cf968);
    expect(fnv1a('hello')).toBe(fnv1a('hello'));
  });
});

describe('isSampled', () => {
  it('always keeps at rate 1 and always drops at rate 0', () => {
    for (let i = 0; i < 50; i++) {
      expect(isSampled(`s${i}`, 'video.heartbeat', 1)).toBe(true);
      expect(isSampled(`s${i}`, 'video.heartbeat', 0)).toBe(false);
    }
  });

  it('keeps roughly `rate` of sessions', () => {
    let kept = 0;
    for (let i = 0; i < 1000; i++) if (isSampled(`session-${i}`, 'video.heartbeat', 0.2)) kept++;
    expect(kept / 1000).toBeGreaterThan(0.12);
    expect(kept / 1000).toBeLessThan(0.28);
  });
});

describe('ids and clock', () => {
  it('creates uuid-ish ids', () => {
    expect(createSessionId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(createViewId()).not.toBe(createViewId());
  });
  it('nowMs is wall-clock epoch milliseconds', () => {
    expect(Math.abs(nowMs() - Date.now())).toBeLessThan(1000);
  });
});
