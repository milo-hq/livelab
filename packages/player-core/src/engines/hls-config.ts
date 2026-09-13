import type { HlsConfig, LoaderContext } from 'hls.js';
import type { EngineOptions } from '../types.js';

/**
 * Builds the hls.js 1.7 configuration for low-latency live playback.
 * Pure function: no DOM, no hls.js runtime import (type-only), so it is unit-testable in Node.
 */
export function buildHlsConfig(opts: EngineOptions): Partial<HlsConfig> {
  const { targetLatencySec, requestTransform } = opts;

  const config: Partial<HlsConfig> = {
    lowLatencyMode: true,
    // Where hls.js tries to sit relative to the live edge, and the point past which it
    // catches up (playbackRate up to 1.5x) instead of drifting further behind.
    liveSyncDuration: targetLatencySec,
    liveMaxLatencyDuration: targetLatencySec * 3,
    maxLiveSyncPlaybackRate: 1.5,
    backBufferLength: 30,
    maxBufferLength: 30,
    // The ESM build does not inline its worker; the app passes the worker URL explicitly.
    enableWorker: true,
    workerPath: opts.workerUrl ?? null,
    startFragPrefetch: true,
    startLevel: opts.startLevel ?? -1,
    // Seeding the estimate (e.g. restored from a previous session) lets ABR pick a
    // sensible first rendition without the bandwidth test round-trip.
    abrEwmaDefaultEstimate: opts.bandwidthEstimate ?? 500_000,
    testBandwidth: opts.bandwidthEstimate ? false : true,
  };

  if (opts.cmcd) {
    config.cmcd = {
      sessionId: opts.cmcd.sessionId,
      contentId: opts.cmcd.contentId,
      version: 2,
      useHeaders: false,
    };
  }

  if (requestTransform) {
    // hls.js 1.7 loader hooks:
    // - FetchLoader calls `fetchSetup(context, initParams)` and uses the returned Request, so we
    //   simply build the Request against the rewritten URL while keeping headers/signal/range intact.
    // - XhrLoader calls `xhrSetup(xhr, url, context)` before sending and only calls `xhr.open()`
    //   itself when `xhr.readyState` is still 0, so opening the XHR here with the rewritten URL
    //   is the documented way to change the request URL.
    config.fetchSetup = (context: LoaderContext, initParams: RequestInit) =>
      new Request(requestTransform(context.url), initParams);
    config.xhrSetup = (xhr: XMLHttpRequest, url: string) => {
      xhr.open('GET', requestTransform(url), true);
    };
  }

  return config;
}

const BW_KEY = 'livelab.bw';

/** Reads the bandwidth estimate persisted by a previous session (bits/s), if any. */
export function readStoredBandwidth(): number | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(BW_KEY);
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

export function storeBandwidth(bps: number): void {
  if (!Number.isFinite(bps) || bps <= 0) return;
  try {
    globalThis.localStorage?.setItem(BW_KEY, String(Math.round(bps)));
  } catch {
    // Storage may be unavailable (private mode, quota, SSR) — persisting is best effort.
  }
}
