import type { TelemetryBatch, TelemetryEvent } from '@livelab/protocol';

/** One `qoe.events` row (see infra/clickhouse/init.sql). Column names are the table's. */
export interface Row {
  /** `YYYY-MM-DD HH:mm:ss.SSS` in UTC, ClickHouse DateTime64(3). */
  ts: string;
  event: string;
  session_id: string;
  view_id: string;
  user_id: string;
  room_id: string;
  protocol: string;
  player: string;
  player_ver: string;
  cdn: string;
  region: string;
  isp: string;
  os: string;
  browser: string;
  net_type: string;
  value_ms: number;
  bitrate_kbps: number;
  level: number;
  buffer_ms: number;
  latency_ms: number;
  dropped_frames: number;
  total_frames: number;
  err_type: string;
  err_detail: string;
  fatal: 0 | 1;
  attrs: Record<string, string>;
}

const ATTR_MAX_LEN = 4096;
const UINT32_MAX = 0xffffffff;
const INT16_MIN = -32768;
const INT16_MAX = 32767;

/**
 * Sources for `value_ms`, by priority. `heartbeat` is special: its `playingMs` (played time in the
 * interval) goes into `value_ms` so the QoE SQL can use `sumIf(value_ms, event='heartbeat')/1000`
 * as watched seconds (denominator of "stall seconds per 100 s watched").
 */
const VALUE_KEYS = ['ttffMs', 'durationMs', 'latencyMs', 'watchMs', 'value'] as const;
const HEARTBEAT_VALUE_KEYS = ['playingMs', 'watchMs', 'durationMs', 'value'] as const;

/** camelCase attr → numeric column. */
const NUMERIC_COLUMNS = [
  ['bitrateKbps', 'bitrate_kbps'], ['level', 'level'], ['bufferMs', 'buffer_ms'],
  ['latencyMs', 'latency_ms'], ['droppedFrames', 'dropped_frames'], ['totalFrames', 'total_frames'],
] as const;

type AttrValue = string | number | boolean;

/** `video.first_frame` → `first_frame`; `web.vital` → `web_vital`. */
export function normalizeEventName(name: string): string {
  const stripped = name.startsWith('video.') ? name.slice('video.'.length) : name;
  return stripped.replace(/\./g, '_');
}

export function formatTs(ms: number): string {
  const d = new Date(Number.isFinite(ms) ? ms : Date.now());
  return d.toISOString().replace('T', ' ').slice(0, 23);
}

function toUint32(v: AttrValue | undefined): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : v === true ? 1 : 0;
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(UINT32_MAX, Math.round(n));
}

function toInt16(v: AttrValue | undefined): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : 0;
  if (!Number.isFinite(n)) return 0;
  return Math.max(INT16_MIN, Math.min(INT16_MAX, Math.round(n)));
}

function toStr(v: AttrValue | undefined): string {
  if (v === undefined) return '';
  const s = typeof v === 'string' ? v : String(v);
  return s.length > ATTR_MAX_LEN ? s.slice(0, ATTR_MAX_LEN) : s;
}

function isTruthy(v: AttrValue | undefined): boolean {
  return v === true || v === 1 || v === 'true' || v === '1';
}

export function toRow(ctx: TelemetryBatch['ctx'], ev: TelemetryEvent): Row {
  const event = normalizeEventName(ev.name);
  const attrs: Record<string, AttrValue> = { ...ev.attrs };
  const take = (k: string): AttrValue | undefined => { const v = attrs[k]; delete attrs[k]; return v; };

  let value: AttrValue | undefined;
  for (const k of event === 'heartbeat' ? HEARTBEAT_VALUE_KEYS : VALUE_KEYS) {
    if (attrs[k] !== undefined) { value = take(k); break; }
  }

  const numeric: Partial<Pick<Row, 'bitrate_kbps' | 'level' | 'buffer_ms' | 'latency_ms' | 'dropped_frames' | 'total_frames'>> = {};
  for (const [attr, col] of NUMERIC_COLUMNS) {
    if (attrs[attr] === undefined) continue;
    const v = take(attr);
    numeric[col] = col === 'level' ? toInt16(v) : toUint32(v);
  }
  // `latencyMs` may already have been consumed as value_ms (latency_sample); mirror it into the column.
  if (numeric.latency_ms === undefined && event === 'latency_sample' && value !== undefined) numeric.latency_ms = toUint32(value);

  const isError = event === 'error';
  const errType = isError ? toStr(take('type')) : '';
  const errDetail = isError ? toStr(take('detail')) : '';
  const fatal: 0 | 1 = isTruthy(take('fatal')) ? 1 : 0;
  const protocol = toStr(take('protocol'));
  const cdn = toStr(take('cdn'));
  const roomId = ev.roomId ?? toStr(take('roomId'));
  if (ev.roomId !== undefined) delete attrs['roomId'];

  const rest: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) rest[k] = toStr(v);

  return {
    ts: formatTs(ev.ts),
    event,
    session_id: ctx.sessionId,
    view_id: ev.viewId ?? '',
    user_id: ctx.userId ?? '',
    room_id: roomId,
    protocol,
    player: ctx.player,
    player_ver: ctx.playerVer,
    cdn,
    region: ctx.region,
    isp: ctx.isp,
    os: ctx.os,
    browser: ctx.browser,
    net_type: ctx.netType,
    value_ms: toUint32(value),
    bitrate_kbps: numeric.bitrate_kbps ?? 0,
    level: numeric.level ?? 0,
    buffer_ms: numeric.buffer_ms ?? 0,
    latency_ms: numeric.latency_ms ?? 0,
    dropped_frames: numeric.dropped_frames ?? 0,
    total_frames: numeric.total_frames ?? 0,
    err_type: errType,
    err_detail: errDetail,
    fatal,
    attrs: rest,
  };
}

export function toRows(batch: TelemetryBatch): Row[] {
  return batch.events.map((ev) => toRow(batch.ctx, ev));
}
