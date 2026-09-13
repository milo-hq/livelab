import { describe, expect, it } from 'vitest';
import type { TelemetryBatch } from '@livelab/protocol';
import { formatTs, normalizeEventName, toRows } from './mapper.js';

const ctx: TelemetryBatch['ctx'] = {
  sessionId: 'sess_1', userId: 'u_1', player: 'livelab-web', playerVer: '0.1.0',
  os: 'macOS', browser: 'Chrome 140', netType: '4g', region: 'local', isp: 'local',
};
const TS = Date.UTC(2026, 8, 13, 10, 20, 30, 456);

const batch = (events: TelemetryBatch['events']): TelemetryBatch => ({ ctx, events });

describe('normalizeEventName / formatTs', () => {
  it('strips the video prefix and turns dots into underscores', () => {
    expect(normalizeEventName('video.first_frame')).toBe('first_frame');
    expect(normalizeEventName('video.stall_end')).toBe('stall_end');
    expect(normalizeEventName('web.vital')).toBe('web_vital');
    expect(normalizeEventName('custom')).toBe('custom');
  });
  it('formats DateTime64(3) in UTC', () => {
    expect(formatTs(TS)).toBe('2026-09-13 10:20:30.456');
    expect(formatTs(Number.NaN)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
  });
});

describe('toRows', () => {
  it('maps first_frame{ttffMs} to value_ms with ctx dimensions', () => {
    const [row] = toRows(batch([{ name: 'video.first_frame', ts: TS, viewId: 'view_1', roomId: 'demo', attrs: { ttffMs: 812.4, protocol: 'llhls', cdn: 'local-abr', pathway: 1 } }]));
    expect(row).toEqual({
      ts: '2026-09-13 10:20:30.456', event: 'first_frame', session_id: 'sess_1', view_id: 'view_1', user_id: 'u_1', room_id: 'demo',
      protocol: 'llhls', player: 'livelab-web', player_ver: '0.1.0', cdn: 'local-abr', region: 'local', isp: 'local',
      os: 'macOS', browser: 'Chrome 140', net_type: '4g',
      value_ms: 812, bitrate_kbps: 0, level: 0, buffer_ms: 0, latency_ms: 0, dropped_frames: 0, total_frames: 0,
      err_type: '', err_detail: '', fatal: 0, attrs: { pathway: '1' },
    });
  });

  it('picks value_ms by priority and never goes negative', () => {
    const rows = toRows(batch([
      { name: 'video.stall_end', ts: TS, attrs: { durationMs: 1499.6 } },
      { name: 'video.latency_sample', ts: TS, attrs: { latencyMs: 2100 } },
      { name: 'video.end', ts: TS, attrs: { watchMs: 65000 } },
      { name: 'web.vital', ts: TS, attrs: { name: 'LCP', value: 1234.56, rating: 'good' } },
      { name: 'video.play_attempt', ts: TS, attrs: { ttffMs: -5 } },
      { name: 'video.play_attempt', ts: TS, attrs: {} },
    ]));
    expect(rows.map((r) => [r.event, r.value_ms])).toEqual([
      ['stall_end', 1500], ['latency_sample', 2100], ['end', 65000], ['web_vital', 1235], ['play_attempt', 0], ['play_attempt', 0],
    ]);
    expect(rows[1]!.latency_ms).toBe(2100);
    expect(rows[3]!.attrs).toEqual({ name: 'LCP', rating: 'good' });
  });

  it('stores heartbeat playingMs in value_ms (watched-seconds denominator for stall_per_100s)', () => {
    const [row] = toRows(batch([{ name: 'video.heartbeat', ts: TS, attrs: { playingMs: 9800, watchMs: 30000, bufferMs: 2500.2, bitrateKbps: 2628, level: 1, latencyMs: 3100, droppedFrames: 3, totalFrames: 900 } }]));
    expect(row).toMatchObject({ event: 'heartbeat', value_ms: 9800, buffer_ms: 2500, bitrate_kbps: 2628, level: 1, latency_ms: 3100, dropped_frames: 3, total_frames: 900 });
    expect(row!.attrs).toEqual({ watchMs: '30000' });
  });

  it('maps error type/detail/fatal only for error events', () => {
    const rows = toRows(batch([
      { name: 'video.error', ts: TS, attrs: { type: 'networkError', detail: 'fragLoadError', fatal: true, url: 'http://x/seg.m4s' } },
      { name: 'video.error', ts: TS, attrs: { type: 'mediaError', detail: 'bufferStalledError', fatal: false } },
      { name: 'video.recovery_action', ts: TS, attrs: { type: 'nudge', fatal: 'true' } },
    ]));
    expect(rows[0]).toMatchObject({ event: 'error', err_type: 'networkError', err_detail: 'fragLoadError', fatal: 1, attrs: { url: 'http://x/seg.m4s' } });
    expect(rows[1]).toMatchObject({ err_type: 'mediaError', err_detail: 'bufferStalledError', fatal: 0 });
    expect(rows[2]).toMatchObject({ event: 'recovery_action', err_type: '', err_detail: '', fatal: 1, attrs: { type: 'nudge' } });
  });

  it('takes room_id from the event, then attrs; clamps level to Int16; truncates long attrs', () => {
    const long = 'x'.repeat(10_000);
    const rows = toRows(batch([
      { name: 'video.level_switch', ts: TS, attrs: { roomId: 'from-attrs', level: -1, note: long } },
      { name: 'video.level_switch', ts: TS, roomId: 'from-event', attrs: { roomId: 'ignored', level: 99999 } },
    ]));
    expect(rows[0]).toMatchObject({ room_id: 'from-attrs', level: -1 });
    expect(rows[0]!.attrs['note']).toHaveLength(4096);
    expect(rows[1]).toMatchObject({ room_id: 'from-event', level: 32767 });
    expect(rows[1]!.attrs).toEqual({});
  });

  it('fills missing ctx/event fields with empty strings', () => {
    const [row] = toRows({ ctx: { ...ctx, userId: undefined }, events: [{ name: 'video.end', ts: TS, attrs: {} }] });
    expect(row).toMatchObject({ user_id: '', view_id: '', room_id: '', protocol: '', cdn: '' });
  });
});
