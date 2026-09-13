import type { Config } from '../../config.js';
import type { Row } from './mapper.js';

export interface Sink {
  /** Enqueue rows; never throws, never blocks the request. */
  write(rows: Row[]): void;
  /** Push whatever is buffered now. */
  flush(): Promise<void>;
  /** Flush and stop timers. */
  close(): Promise<void>;
}

/** Minimal logger contract satisfied by pino loggers and `console`. */
export interface SinkLog { info(msg: string): void; warn(msg: string): void }

export interface ClickHouseSinkOpts {
  url: string;
  user: string;
  password: string;
  fetchImpl?: typeof fetch;
  /** Flush interval once the first row arrives. Default 2000. */
  flushMs?: number;
  /** Flush immediately when the buffer reaches this size. Default 1000. */
  maxRows?: number;
  log?: SinkLog;
  now?: () => number;
}

const ERROR_LOG_INTERVAL_MS = 60_000;

/**
 * Buffers rows and POSTs them as newline-delimited JSON with `INSERT ... FORMAT JSONEachRow`.
 * Telemetry is best-effort: on failure the batch is dropped and the error is logged at most once
 * per minute so a ClickHouse outage cannot fill the API log or affect playback.
 */
export function createClickHouseSink(opts: ClickHouseSinkOpts): Sink {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const flushMs = opts.flushMs ?? 2000;
  const maxRows = opts.maxRows ?? 1000;
  const now = opts.now ?? Date.now;
  const log = opts.log;
  const insertUrl = `${opts.url.replace(/\/+$/, '')}/?query=${encodeURIComponent('INSERT INTO qoe.events FORMAT JSONEachRow')}`;
  const auth = `Basic ${Buffer.from(`${opts.user}:${opts.password}`).toString('base64')}`;

  let buffer: Row[] = [];
  let timer: NodeJS.Timeout | null = null;
  let inflight: Promise<void> | null = null;
  let lastErrorAt = -Infinity;
  let closed = false;

  const reportError = (msg: string) => {
    const t = now();
    if (t - lastErrorAt < ERROR_LOG_INTERVAL_MS) return;
    lastErrorAt = t;
    log?.warn(`telemetry: ${msg} (further errors suppressed for 60s)`);
  };

  const send = async (rows: Row[]) => {
    const body = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    try {
      const res = await fetchImpl(insertUrl, {
        method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/x-ndjson' },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) reportError(`clickhouse insert failed: ${res.status} ${(await res.text()).slice(0, 200)} — dropped ${rows.length} rows`);
    } catch (e) {
      reportError(`clickhouse insert error: ${(e as Error).message} — dropped ${rows.length} rows`);
    }
  };

  const flush = async () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (inflight) await inflight;
    if (buffer.length === 0) return;
    const rows = buffer;
    buffer = [];
    inflight = send(rows).finally(() => { inflight = null; });
    await inflight;
  };

  return {
    write(rows) {
      if (closed || rows.length === 0) return;
      buffer.push(...rows);
      if (buffer.length >= maxRows) { void flush(); return; }
      if (!timer) {
        timer = setTimeout(() => { timer = null; void flush(); }, flushMs);
        timer.unref?.();
      }
    },
    flush,
    async close() {
      closed = true;
      await flush();
    },
  };
}

/** Development fallback: summarises each batch in the log instead of persisting it. */
export function createConsoleSink(log: SinkLog = console): Sink {
  return {
    write(rows) {
      if (rows.length === 0) return;
      const counts = new Map<string, number>();
      for (const r of rows) counts.set(r.event, (counts.get(r.event) ?? 0) + 1);
      const summary = [...counts].map(([k, n]) => `${k}×${n}`).join(', ');
      log.info(`telemetry (no ClickHouse): ${rows.length} row(s): ${summary}`);
    },
    flush: async () => undefined,
    close: async () => undefined,
  };
}

export function createTelemetrySink(cfg: Pick<Config, 'clickhouseUrl' | 'clickhouseUser' | 'clickhousePassword'>, log: SinkLog = console): Sink {
  return cfg.clickhouseUrl
    ? createClickHouseSink({ url: cfg.clickhouseUrl, user: cfg.clickhouseUser, password: cfg.clickhousePassword, log })
    : createConsoleSink(log);
}
