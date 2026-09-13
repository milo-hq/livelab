import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Row } from './mapper.js';
import { createClickHouseSink, createConsoleSink, createTelemetrySink } from './sink.js';
import { createQoeSummary, summarySql } from './summary.js';

const row = (event: string, value_ms = 0): Row => ({
  ts: '2026-09-13 10:20:30.456', event, session_id: 's', view_id: 'v', user_id: '', room_id: 'demo', protocol: 'llhls',
  player: 'p', player_ver: '1', cdn: 'a', region: 'local', isp: 'local', os: 'mac', browser: 'chrome', net_type: '4g',
  value_ms, bitrate_kbps: 0, level: 0, buffer_ms: 0, latency_ms: 0, dropped_frames: 0, total_frames: 0,
  err_type: '', err_detail: '', fatal: 0, attrs: {},
});

interface Call { url: string; init: RequestInit }
function fakeFetch(status = 200) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(status === 200 ? '' : 'error text', { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('createClickHouseSink', () => {
  it('buffers rows and posts them as JSONEachRow with basic auth on flush', async () => {
    const { calls, fetchImpl } = fakeFetch();
    const sink = createClickHouseSink({ url: 'http://ch:8123/', user: 'default', password: 'livelab', fetchImpl });
    sink.write([row('first_frame', 812), row('heartbeat', 9800)]);
    sink.write([row('stall_end', 300)]);
    expect(calls).toHaveLength(0);
    await sink.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://ch:8123/?query=INSERT%20INTO%20qoe.events%20FORMAT%20JSONEachRow');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>)['authorization']).toBe(`Basic ${Buffer.from('default:livelab').toString('base64')}`);
    const lines = (calls[0]!.init.body as string).trimEnd().split('\n').map((l) => JSON.parse(l) as Row);
    expect(lines.map((l) => [l.event, l.value_ms])).toEqual([['first_frame', 812], ['heartbeat', 9800], ['stall_end', 300]]);
    await sink.flush();
    expect(calls).toHaveLength(1); // nothing new to send
  });

  it('flushes on the timer', async () => {
    const { calls, fetchImpl } = fakeFetch();
    const sink = createClickHouseSink({ url: 'http://ch:8123', user: 'u', password: 'p', fetchImpl, flushMs: 2000 });
    sink.write([row('a')]);
    await vi.advanceTimersByTimeAsync(1999);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
    sink.write([row('b')]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(2);
    await sink.close();
  });

  it('flushes immediately at maxRows', async () => {
    const { calls, fetchImpl } = fakeFetch();
    const sink = createClickHouseSink({ url: 'http://ch:8123', user: 'u', password: 'p', fetchImpl, maxRows: 3 });
    sink.write([row('a'), row('b')]);
    expect(calls).toHaveLength(0);
    sink.write([row('c')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect((calls[0]!.init.body as string).trimEnd().split('\n')).toHaveLength(3);
  });

  it('drops failed batches and logs at most once per minute', async () => {
    let now = 0;
    const { calls, fetchImpl } = fakeFetch(500);
    const log = { info: vi.fn(), warn: vi.fn() };
    const sink = createClickHouseSink({ url: 'http://ch:8123', user: 'u', password: 'p', fetchImpl, log, now: () => now });
    sink.write([row('a')]); await sink.flush();
    sink.write([row('b')]); await sink.flush();
    expect(calls).toHaveLength(2);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![0]).toMatch(/clickhouse insert failed: 500/);
    now = 60_000;
    sink.write([row('c')]); await sink.flush();
    expect(log.warn).toHaveBeenCalledTimes(2);
    // Network error path.
    const bad = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const sink2 = createClickHouseSink({ url: 'http://ch:8123', user: 'u', password: 'p', fetchImpl: bad, log });
    sink2.write([row('a')]); await sink2.flush();
    expect(log.warn.mock.calls[2]![0]).toMatch(/ECONNREFUSED/);
  });

  it('close() flushes and ignores later writes', async () => {
    const { calls, fetchImpl } = fakeFetch();
    const sink = createClickHouseSink({ url: 'http://ch:8123', user: 'u', password: 'p', fetchImpl });
    sink.write([row('a')]);
    await sink.close();
    expect(calls).toHaveLength(1);
    sink.write([row('b')]);
    await sink.flush();
    expect(calls).toHaveLength(1);
  });
});

describe('createConsoleSink / createTelemetrySink', () => {
  it('console sink summarises batches', () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const sink = createConsoleSink(log);
    sink.write([row('first_frame'), row('heartbeat'), row('heartbeat')]);
    expect(log.info).toHaveBeenCalledWith('telemetry (no ClickHouse): 3 row(s): first_frame×1, heartbeat×2');
    sink.write([]);
    expect(log.info).toHaveBeenCalledTimes(1);
  });
  it('picks the sink from config', () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    createTelemetrySink({ clickhouseUrl: undefined, clickhouseUser: 'u', clickhousePassword: 'p' }, log).write([row('x')]);
    expect(log.info).toHaveBeenCalledTimes(1);
    createTelemetrySink({ clickhouseUrl: 'http://ch:8123', clickhouseUser: 'u', clickhousePassword: 'p' }, log).write([row('x')]);
    expect(log.info).toHaveBeenCalledTimes(1);
  });
});

describe('createQoeSummary', () => {
  it('posts the 15-minute SQL and maps the JSONEachRow answer', async () => {
    const { calls, fetchImpl } = fakeFetch();
    vi.mocked(fetchImpl).mockImplementationOnce(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response('{"ttff_p50":812.5,"ttff_p95":2410,"fast_start_pct":66.6666,"stall_per_100s":1.23456,"stall_view_pct":12.5,"failure_pct":0,"sessions":8}\n');
    });
    const summary = createQoeSummary({ url: 'http://ch:8123', user: 'default', password: 'livelab', fetchImpl });
    expect(await summary()).toEqual({ ttffP50: 813, ttffP95: 2410, fastStartPct: 66.67, stallPer100s: 1.235, stallViewPct: 12.5, failurePct: 0, sessions: 8, source: 'clickhouse' });
    expect(calls[0]!.url).toBe('http://ch:8123/?output_format_json_quote_64bit_integers=0&output_format_json_quote_denormals=1');
    expect(calls[0]!.init.body).toBe(summarySql(15));
    expect(summarySql(15)).toContain("sumIf(value_ms, event = 'heartbeat')");
    expect(summarySql(15)).toContain('INTERVAL 15 MINUTE');
  });
  it('turns nulls/nan/empty windows into nulls and rejects on HTTP errors', async () => {
    const ok = vi.fn(async () => new Response('{"ttff_p50":null,"ttff_p95":"nan","fast_start_pct":null,"stall_per_100s":null,"stall_view_pct":null,"failure_pct":null,"sessions":"0"}\n')) as unknown as typeof fetch;
    expect(await createQoeSummary({ url: 'http://ch:8123', user: 'u', password: 'p', fetchImpl: ok })()).toEqual({ ttffP50: null, ttffP95: null, fastStartPct: null, stallPer100s: null, stallViewPct: null, failurePct: null, sessions: 0, source: 'clickhouse' });
    const bad = vi.fn(async () => new Response('Code: 60. DB::Exception: Table qoe.events does not exist', { status: 404 })) as unknown as typeof fetch;
    await expect(createQoeSummary({ url: 'http://ch:8123', user: 'u', password: 'p', fetchImpl: bad })()).rejects.toThrow(/404/);
  });
});
