import type { QoeSummary } from '@livelab/protocol';

export const EMPTY_SUMMARY: QoeSummary = {
  ttffP50: null, ttffP95: null, fastStartPct: null, stallPer100s: null, stallViewPct: null, failurePct: null,
  sessions: 0, source: 'none',
};

export interface QoeSummaryOpts {
  url: string;
  user: string;
  password: string;
  fetchImpl?: typeof fetch;
  /** Look-back window. Default 15. */
  windowMinutes?: number;
}

/**
 * One query, one row (see docs/research/04-qoe-observability.md §4). Notes:
 *  - `sumIf(value_ms, event='heartbeat')/1000` is watched seconds because the mapper stores the
 *    heartbeat's `playingMs` in `value_ms`.
 *  - every ratio is NULL-guarded with `nullIf(denominator, 0)` so an empty window yields `null`
 *    rather than `nan`/`inf` (which would not survive JSON).
 */
export function summarySql(windowMinutes: number): string {
  const w = Math.max(1, Math.floor(windowMinutes));
  return `
SELECT
  if(countIf(event = 'first_frame') = 0, NULL, quantileIf(0.5)(value_ms, event = 'first_frame')) AS ttff_p50,
  if(countIf(event = 'first_frame') = 0, NULL, quantileIf(0.95)(value_ms, event = 'first_frame')) AS ttff_p95,
  100 * countIf(event = 'first_frame' AND value_ms <= 1000) / nullIf(countIf(event = 'first_frame'), 0) AS fast_start_pct,
  100 * (sumIf(value_ms, event = 'stall_end') / 1000) / nullIf(sumIf(value_ms, event = 'heartbeat') / 1000, 0) AS stall_per_100s,
  100 * uniqIf(view_id, event = 'stall_end') / nullIf(uniqIf(view_id, event = 'play_attempt'), 0) AS stall_view_pct,
  100 * uniqIf(view_id, event = 'error' AND fatal = 1) / nullIf(uniqIf(view_id, event = 'play_attempt'), 0) AS failure_pct,
  uniqIf(view_id, event = 'play_attempt') AS sessions
FROM qoe.events
WHERE ts >= now() - INTERVAL ${w} MINUTE
FORMAT JSONEachRow`.trim();
}

const num = (v: unknown, digits: number): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? Number(n.toFixed(digits)) : null;
};

export function createQoeSummary(opts: QoeSummaryOpts): () => Promise<QoeSummary> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const params = new URLSearchParams({
    // Return UInt64 as JSON numbers and never emit bare `nan`/`inf` tokens.
    output_format_json_quote_64bit_integers: '0',
    output_format_json_quote_denormals: '1',
  });
  const url = `${opts.url.replace(/\/+$/, '')}/?${params}`;
  const auth = `Basic ${Buffer.from(`${opts.user}:${opts.password}`).toString('base64')}`;
  const sql = summarySql(opts.windowMinutes ?? 15);

  return async () => {
    const res = await fetchImpl(url, { method: 'POST', headers: { authorization: auth }, body: sql, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`clickhouse summary failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const line = (await res.text()).split('\n').find((l) => l.trim() !== '');
    const row = line ? (JSON.parse(line) as Record<string, unknown>) : {};
    return {
      ttffP50: num(row['ttff_p50'], 0),
      ttffP95: num(row['ttff_p95'], 0),
      fastStartPct: num(row['fast_start_pct'], 2),
      stallPer100s: num(row['stall_per_100s'], 3),
      stallViewPct: num(row['stall_view_pct'], 2),
      failurePct: num(row['failure_pct'], 2),
      sessions: num(row['sessions'], 0) ?? 0,
      source: 'clickhouse',
    };
  };
}
