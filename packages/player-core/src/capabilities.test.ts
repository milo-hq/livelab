import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectCapabilities } from './capabilities.js';

const g = globalThis as Record<string, unknown>;

describe('detectCapabilities', () => {
  const origMediaSource = g['MediaSource'];
  const origManaged = g['ManagedMediaSource'];
  const origRtc = g['RTCPeerConnection'];

  afterEach(() => {
    g['MediaSource'] = origMediaSource;
    g['ManagedMediaSource'] = origManaged;
    g['RTCPeerConnection'] = origRtc;
    vi.restoreAllMocks();
  });

  it('reports nativeHls:true when canPlayType returns "maybe"', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockImplementation((t: string) =>
      t === 'application/vnd.apple.mpegurl' ? 'maybe' : '',
    );
    expect(detectCapabilities().nativeHls).toBe(true);
  });

  it('reports nativeHls:false when canPlayType returns ""', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('');
    expect(detectCapabilities().nativeHls).toBe(false);
  });

  it('reports mse:false when MediaSource is undefined', () => {
    delete g['MediaSource'];
    delete g['ManagedMediaSource'];
    const caps = detectCapabilities();
    expect(caps.mse).toBe(false);
    expect(caps.managedMse).toBe(false);
  });

  it('reports mse/managedMse/webrtc:true when globals exist', () => {
    g['MediaSource'] = class {};
    g['ManagedMediaSource'] = class {};
    g['RTCPeerConnection'] = class {};
    const caps = detectCapabilities();
    expect(caps.mse).toBe(true);
    expect(caps.managedMse).toBe(true);
    expect(caps.webrtc).toBe(true);
  });

  it('detects iOS and Safari from the user agent', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
    );
    const caps = detectCapabilities();
    expect(caps.isIOS).toBe(true);
    expect(caps.isSafari).toBe(true);
  });

  it('does not flag Chrome as Safari', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    );
    const caps = detectCapabilities();
    expect(caps.isIOS).toBe(false);
    expect(caps.isSafari).toBe(false);
  });
});
