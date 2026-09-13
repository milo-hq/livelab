/**
 * `createTelemetry` — the browser QoE telemetry SDK.
 *
 * Responsibilities, in the order an event flows through:
 *   1. `track()` builds a `TelemetryEvent`, applies per-session sampling and
 *      enriches fatal errors / issue reports with the ring log + resource
 *      timing waterfall;
 *   2. events wait in bounded in-memory queues (a normal one and a small
 *      "must-deliver" one for events we never want to lose);
 *   3. `flush()` drains the queues into `TelemetryBatch` POSTs using
 *      `fetch(..., { keepalive: true })`, triggered by batch size, a timer,
 *      and the page being hidden/unloaded.
 *
 * Nothing here may throw into the player: telemetry is best-effort and a
 * broken ingest endpoint must never degrade playback.
 */
import type { TelemetryBatch, TelemetryEvent } from '@livelab/protocol';
import { buildContext, createSessionId, isSampled, type PartialContext } from './context.js';
import { createQueue, type Queue } from './queue.js';
import { createRingLog } from './ring-log.js';
import { snapshotResources } from './resources.js';
import { captureVitals as captureWebVitals } from './vitals.js';

export type AttrValue = string | number | boolean;
export type Attrs = Record<string, AttrValue>;
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface TelemetryOptions {
  /** Ingest URL, e.g. `/v1/telemetry`. Receives `TelemetryBatch` JSON. */
  endpoint: string;
  /** Static context; `sessionId`, `os`, `browser`, `netType` are filled in by the SDK. */
  ctx: PartialContext;
  /**
   * Per-event-name keep rate in [0, 1], keyed by the full event name.
   * Defaults: `video.heartbeat` 0.2, `video.latency_sample` 0.2, others 1.
   */
  sampleRates?: Partial<Record<string, number>>;
  /** Flush as soon as this many events are pending. Default 20. */
  batchSize?: number;
  /** Flush at least this often while events are pending. Default 5000. */
  flushIntervalMs?: number;
  /** Cap of the normal queue; newer events are dropped beyond it. Default 500. */
  maxQueue?: number;
  /** Injectable fetch (tests, SSR). Default `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for `ts` (epoch ms). Default `Date.now`. */
  now?: () => number;
  /** Mirror `log()` lines to `console.debug`. */
  debug?: boolean;
}

export interface TrackOptions {
  viewId?: string;
  roomId?: string;
}

export interface Telemetry {
  /** Stable for the lifetime of the page/tab. */
  readonly sessionId: string;
  track(name: string, attrs?: Attrs, opts?: TrackOptions): void;
  log(level: LogLevel, msg: string): void;
  /** Send everything pending now. Concurrent calls share one in-flight request. */
  flush(): Promise<void>;
  /** User-initiated bug report: never sampled out, enriched, flushed immediately. */
  reportIssue(description: string, extra?: Record<string, string>): Promise<void>;
  /** Start reporting LCP/INP/CLS/TTFB/FCP as `web.vital` events. */
  captureVitals(): void;
  /** Stop timers/listeners and perform a final flush. */
  destroy(): void;
}

const DEFAULT_SAMPLE_RATES: Record<string, number> = {
  'video.heartbeat': 0.2,
  'video.latency_sample': 0.2,
};

/** Events that describe session outcome or failures (plus every `*.error`): never sampled, never dropped when the queue is full. */
const MUST_DELIVER = new Set(['video.report_issue', 'video.first_frame', 'video.end']);
const MUST_DELIVER_CAP = 100;

/** `TelemetryBatch.events` is capped at 500 by the protocol schema. */
const MAX_EVENTS_PER_BATCH = 500;

/**
 * Browsers cap the total size of in-flight `keepalive` request bodies at
 * 64 KB per origin (Fetch spec §4.5). A bigger body makes `fetch` reject
 * synchronously and the batch would be lost precisely when it matters most
 * (page unload). We stay well under the cap so several batches can be in
 * flight at once.
 */
const MAX_BODY_BYTES = 60 * 1024;

const RING_LINES_ATTACHED = 50;
const ATTACHMENT_MAX_BYTES = 8 * 1024;
const RESOURCE_WINDOW_MS = 60_000;

function isMustDeliver(name: string): boolean {
  return MUST_DELIVER.has(name) || name.endsWith('.error');
}

function byteLength(s: string): number {
  return typeof TextEncoder === 'function' ? new TextEncoder().encode(s).length : s.length;
}

/** Keep the *most recent* part of a text attachment within `max` bytes. */
function truncateTail(s: string, max: number): string {
  if (byteLength(s) <= max) return s;
  // Cheap approximation: slice by chars then re-check; attachments are ASCII-heavy.
  let out = s.slice(-max);
  while (byteLength(out) > max) out = out.slice(Math.ceil((byteLength(out) - max) / 2) || 1);
  return out;
}

/**
 * Serialize a resource waterfall under `max` bytes by dropping the *oldest*
 * entries first, so the attachment stays valid JSON and keeps the requests
 * closest to the failure.
 */
function resourcesJson(max: number): string {
  const entries = snapshotResources(RESOURCE_WINDOW_MS);
  let json = JSON.stringify(entries);
  while (entries.length > 0 && byteLength(json) > max) {
    entries.shift();
    json = JSON.stringify(entries);
  }
  return byteLength(json) > max ? '[]' : json;
}

export function createTelemetry(opts: TelemetryOptions): Telemetry {
  const batchSize = opts.batchSize ?? 20;
  const flushIntervalMs = opts.flushIntervalMs ?? 5000;
  const maxQueue = opts.maxQueue ?? 500;
  const now = opts.now ?? (() => Date.now());
  const sampleRates: Partial<Record<string, number>> = { ...DEFAULT_SAMPLE_RATES, ...opts.sampleRates };
  const fetchImpl: typeof fetch | undefined =
    opts.fetchImpl ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined);

  const sessionId = createSessionId();
  const ctx = buildContext(sessionId, opts.ctx);
  const ring = createRingLog(500);

  const queue: Queue<TelemetryEvent> = createQueue({ max: maxQueue });
  const mustDeliver: Queue<TelemetryEvent> = createQueue({ max: MUST_DELIVER_CAP });
  /**
   * Events that already failed once. We retry a failed batch exactly once
   * (transient network blips are common on mobile) and then drop, so a dead
   * endpoint cannot make the queue spin forever. A WeakSet marks the event
   * objects without changing the wire payload.
   */
  const retried = new WeakSet<TelemetryEvent>();

  let inFlight: Promise<void> | null = null;
  let destroyed = false;
  let warned = false;

  const pending = () => queue.size() + mustDeliver.size();

  const warnOnce = (msg: string, err?: unknown) => {
    if (warned) return;
    warned = true;
    console.warn(`[telemetry] ${msg}`, err ?? '');
  };

  // ---- transport ----------------------------------------------------------

  async function post(events: TelemetryEvent[]): Promise<boolean> {
    if (!fetchImpl) return false;
    const batch: TelemetryBatch = { ctx, events };
    try {
      const res = await fetchImpl(opts.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(batch),
        // `keepalive` lets the request outlive the page: on `pagehide` a
        // normal fetch is cancelled by navigation, a keepalive one completes.
        keepalive: true,
      });
      return res.ok;
    } catch (err) {
      warnOnce('flush failed', err);
      return false;
    }
  }

  /** Split so every request body stays under `MAX_BODY_BYTES` (and 500 events). */
  function chunk(events: TelemetryEvent[]): TelemetryEvent[][] {
    const out: TelemetryEvent[][] = [];
    const visit = (part: TelemetryEvent[]) => {
      if (part.length === 0) return;
      const tooMany = part.length > MAX_EVENTS_PER_BATCH;
      const tooBig = part.length > 1 && byteLength(JSON.stringify({ ctx, events: part })) > MAX_BODY_BYTES;
      if (tooMany || tooBig) {
        const mid = Math.ceil(part.length / 2);
        visit(part.slice(0, mid));
        visit(part.slice(mid));
      } else {
        out.push(part);
      }
    };
    visit(events);
    return out;
  }

  function requeue(events: TelemetryEvent[]): void {
    const again = events.filter((e) => !retried.has(e));
    again.forEach((e) => retried.add(e));
    // Preserve original ordering: must-deliver events sit ahead of normal ones.
    mustDeliver.unshift(again.filter((e) => isMustDeliver(e.name)));
    queue.unshift(again.filter((e) => !isMustDeliver(e.name)));
    if (again.length < events.length) warnOnce('dropping events after retry');
  }

  async function doFlush(): Promise<void> {
    // Snapshot what is pending now; anything tracked while we await goes to the next flush.
    const events = [...mustDeliver.drain(), ...queue.drain()];
    for (const part of chunk(events)) {
      const ok = await post(part);
      if (!ok) requeue(part);
    }
  }

  function flush(): Promise<void> {
    if (inFlight) return inFlight;
    if (pending() === 0) return Promise.resolve();
    inFlight = doFlush().finally(() => {
      inFlight = null;
      // Events that arrived while we were busy may already fill a batch; and
      // after destroy() there is no timer left, so drain whatever remains.
      if (pending() > 0 && (destroyed || pending() >= batchSize)) void flush();
    });
    return inFlight;
  }

  // ---- triggers -----------------------------------------------------------

  const g = globalThis as typeof globalThis & { document?: Document; window?: Window };

  const timer = setInterval(() => {
    if (pending() > 0) void flush();
  }, flushIntervalMs);

  /**
   * `visibilitychange → hidden` is the last reliable moment to send data on
   * mobile (tabs are frozen/killed without `unload`). `pagehide` covers
   * desktop navigations and bfcache. Both fire before the page goes away and
   * the keepalive request finishes in the background.
   */
  const onVisibility = () => {
    if (g.document?.visibilityState === 'hidden') void flush();
  };
  const onPageHide = () => void flush();
  g.document?.addEventListener('visibilitychange', onVisibility);
  g.window?.addEventListener('pagehide', onPageHide);

  // ---- public API ---------------------------------------------------------

  function log(level: LogLevel, msg: string): void {
    ring.push(`${now()} ${level} ${msg}`);
    if (opts.debug) console.debug(`[telemetry] ${level} ${msg}`);
  }

  function enrich(name: string, attrs: Attrs): Attrs {
    const fatal = name.endsWith('.error') && attrs['fatal'] === true;
    if (!fatal && name !== 'video.report_issue') return attrs;
    return {
      ...attrs,
      log: truncateTail(ring.tail(RING_LINES_ATTACHED).join('\n'), ATTACHMENT_MAX_BYTES),
      resources: resourcesJson(ATTACHMENT_MAX_BYTES),
    };
  }

  function enqueue(name: string, attrs: Attrs, trackOpts: TrackOptions | undefined, bypassSampling: boolean) {
    if (destroyed) return;
    const must = isMustDeliver(name);
    if (!must && !bypassSampling && !isSampled(sessionId, name, sampleRates[name] ?? 1)) return;

    const event: TelemetryEvent = { name, ts: now(), attrs: enrich(name, attrs) };
    if (trackOpts?.viewId) event.viewId = trackOpts.viewId;
    if (trackOpts?.roomId) event.roomId = trackOpts.roomId;

    // Must-deliver events get their own small queue so a flood of heartbeats
    // can never push a `first_frame` or fatal `error` out of the buffer.
    const accepted = must ? mustDeliver.push(event) : queue.push(event);
    if (!accepted) warnOnce('queue full, dropping events');
    if (pending() >= batchSize) void flush();
  }

  function track(name: string, attrs: Attrs = {}, trackOpts?: TrackOptions): void {
    try {
      enqueue(name, attrs, trackOpts, false);
    } catch (err) {
      warnOnce('track failed', err);
    }
  }

  async function reportIssue(description: string, extra: Record<string, string> = {}): Promise<void> {
    enqueue('video.report_issue', { ...extra, description }, undefined, true);
    await flush();
  }

  function destroy(): void {
    if (destroyed) return;
    clearInterval(timer);
    g.document?.removeEventListener('visibilitychange', onVisibility);
    g.window?.removeEventListener('pagehide', onPageHide);
    void flush();
    destroyed = true;
  }

  return {
    sessionId,
    track,
    log,
    flush,
    reportIssue,
    captureVitals: () => captureWebVitals((name, attrs) => track(name, attrs)),
    destroy,
  };
}
