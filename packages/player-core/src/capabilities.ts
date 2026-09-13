export interface Capabilities {
  /** `MediaSource` available (hls.js / mpegts.js can run). */
  mse: boolean;
  /** `ManagedMediaSource` available (iOS 17.1+ Safari). */
  managedMse: boolean;
  /** `<video>` can play HLS natively (Safari). */
  nativeHls: boolean;
  webrtc: boolean;
  isIOS: boolean;
  isSafari: boolean;
}

/** Detects playback capabilities of the current browser. Safe to call on the server (returns all-false). */
export function detectCapabilities(): Capabilities {
  const g = globalThis as Record<string, unknown>;
  const hasDom = typeof document !== 'undefined' && typeof document.createElement === 'function';
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent ?? '' : '';

  let nativeHls = false;
  if (hasDom) {
    try {
      const v = document.createElement('video');
      const answer = v.canPlayType('application/vnd.apple.mpegurl') || v.canPlayType('application/x-mpegURL');
      nativeHls = answer === 'maybe' || answer === 'probably';
    } catch {
      nativeHls = false;
    }
  }

  const isIOS =
    /iPhone|iPad|iPod/.test(ua) ||
    // iPadOS 13+ reports itself as Macintosh but exposes touch points.
    (/Macintosh/.test(ua) && typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 1);
  const isSafari = /Safari/.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Android/.test(ua);

  return {
    mse: typeof g['MediaSource'] !== 'undefined',
    managedMse: typeof g['ManagedMediaSource'] !== 'undefined',
    nativeHls,
    webrtc: typeof g['RTCPeerConnection'] !== 'undefined',
    isIOS,
    isSafari,
  };
}
