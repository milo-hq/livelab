/**
 * Session identity, environment detection and sampling decisions.
 *
 * Everything in this file is pure (no timers, no network) so it can be unit
 * tested without jsdom tricks and reused by the ingest side if needed.
 */
import type { TelemetryContext } from '@livelab/protocol';

/** Wall-clock timestamp in epoch milliseconds (what `TelemetryEvent.ts` carries). */
export function nowMs(): number {
  return Date.now();
}

/**
 * `crypto.randomUUID()` is available in every modern browser and in Node 19+,
 * but only in secure contexts (https / localhost). Because the SDK may run on
 * a plain-http LAN demo we fall back to a Math.random-based v4-shaped id: it
 * is not cryptographically strong, but it only needs to be unique enough to
 * distinguish sessions in ClickHouse.
 */
function randomId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${hex(4)}-${hex(12)}`;
}

/** One `sessionId` per page/tab lifetime: created when `createTelemetry` runs. */
export function createSessionId(): string {
  return randomId();
}

/** One `viewId` per playback attempt (a new one each time the player starts a stream). */
export function createViewId(): string {
  return randomId();
}

/**
 * 32-bit FNV-1a hash. We use it (rather than a crypto hash) because the
 * sampling decision only needs a cheap, deterministic, well-distributed
 * mapping from a string to a number; it does not need to resist attackers.
 */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // Multiply by the FNV prime (16777619) using shifts to stay in 32-bit space.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Per-session sampling.
 *
 * Why per session rather than per event? High-volume events (heartbeat every
 * 10 s, latency samples) are only useful as a *time series within one
 * session*: you want to see how latency drifted over a viewer's whole watch.
 * If we sampled each event independently at 20 %, every session would have
 * 80 % of its points missing and no session would be analysable end to end.
 * Hashing `sessionId|eventName` instead means a session either keeps ALL of
 * its heartbeats or none of them, and the fleet-wide volume still drops to
 * `rate`. The decision is also stable across page reloads of the same tab
 * (same sessionId) and needs no stored state.
 */
export function isSampled(sessionId: string, name: string, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  const bucket = (fnv1a(`${sessionId}|${name}`) % 1000) / 1000;
  return bucket < rate;
}

export type OsName = 'iOS' | 'Android' | 'macOS' | 'Windows' | 'Linux' | 'other';
export type BrowserName = 'Chrome' | 'Safari' | 'Firefox' | 'Edge' | 'other';

/**
 * Minimal user-agent classifier. We only need the coarse buckets used as
 * ClickHouse `LowCardinality` dimensions (`os`, `browser`) for dashboards
 * like "TTFF p95 by browser"; a full UA parser would add ~20 KB for no gain.
 * Order matters: iOS before macOS (iPadOS may claim "Mac OS X"), Edge before
 * Chrome, and Chrome before Safari (Chrome's UA also contains "Safari").
 */
export function parseUserAgent(ua: string): { os: OsName; browser: BrowserName } {
  let os: OsName = 'other';
  if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Linux|X11/.test(ua)) os = 'Linux';

  let browser: BrowserName = 'other';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Chrome\/|CriOS\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) browser = 'Safari';

  return { os, browser };
}

/** The part of the context the caller must supply; the SDK fills in the rest. */
export type PartialContext = Omit<TelemetryContext, 'sessionId' | 'os' | 'browser' | 'netType'>;

/**
 * Complete the wire context with what the browser can tell us. `netType`
 * comes from the Network Information API (`effectiveType`: 'slow-2g' … '4g'),
 * which is Chromium-only, hence the `'unknown'` fallback.
 */
export function buildContext(sessionId: string, partial: PartialContext): TelemetryContext {
  const nav = globalThis.navigator as (Navigator & { connection?: { effectiveType?: string } }) | undefined;
  const { os, browser } = parseUserAgent(nav?.userAgent ?? '');
  return {
    ...partial,
    sessionId,
    os,
    browser,
    netType: nav?.connection?.effectiveType ?? 'unknown',
  };
}
