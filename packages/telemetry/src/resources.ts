/**
 * Snapshot of recent media network activity, attached to fatal errors and
 * issue reports.
 *
 * When a stream dies, the single most useful piece of evidence is the
 * "waterfall" of the last minute: which playlists/segments were requested,
 * how long each took, how big they were and whether the CDN answered 4xx/5xx.
 * The browser already records all of that in the Resource Timing buffer, so
 * we do not need to instrument hls.js/mpegts.js ourselves; we just read the
 * buffer at the moment of failure and keep only media URLs to stay small.
 */
export interface ResourceSnapshot {
  name: string;
  duration: number;
  transferSize: number;
  /** HTTP status when the browser exposes `responseStatus` (Chromium 109+). */
  status?: number;
}

/** Media playlist/segment/WebRTC signaling URLs; ignores JS/CSS/images. */
const MEDIA_URL = /\.(m3u8|m4s|mp4|ts|flv)(\?|$)|\/whep/;

export function snapshotResources(sinceMs = 60_000): ResourceSnapshot[] {
  try {
    const perf = globalThis.performance;
    if (!perf || typeof perf.getEntriesByType !== 'function') return [];
    const cutoff = perf.now() - sinceMs;
    const out: ResourceSnapshot[] = [];
    for (const e of perf.getEntriesByType('resource')) {
      if (e.startTime < cutoff || !MEDIA_URL.test(e.name)) continue;
      const r = e as PerformanceResourceTiming & { responseStatus?: number };
      const snap: ResourceSnapshot = {
        name: r.name,
        duration: Math.round(r.duration),
        transferSize: r.transferSize ?? 0,
      };
      if (typeof r.responseStatus === 'number') snap.status = r.responseStatus;
      out.push(snap);
    }
    return out;
  } catch {
    // Some privacy-hardened browsers throw on Performance access; diagnostics
    // are best-effort and must never break the caller.
    return [];
  }
}
