import { WhepError } from './whep-client.js';

export interface WhipClientOptions {
  iceServers?: RTCIceServer[];
  fetch?: typeof fetch;
  iceGatheringTimeoutMs?: number;
}

/**
 * Hand-written WHIP (WebRTC-HTTP Ingestion Protocol, RFC 9725) client — the mirror image of WHEP:
 *   add local tracks (sendonly) → POST offer (application/sdp) → 201 + Location + answer → DELETE to hang up.
 * Used by the co-host (连麦) flow: a viewer's browser publishes camera/mic straight to MediaMTX.
 */
export class WhipClient {
  readonly pc: RTCPeerConnection;
  resourceUrl: string | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly iceTimeoutMs: number;

  constructor(
    readonly endpoint: string,
    opts: WhipClientOptions = {},
  ) {
    this.fetchImpl = opts.fetch ?? ((...args) => globalThis.fetch(...args));
    this.iceTimeoutMs = opts.iceGatheringTimeoutMs ?? 1000;
    this.pc = new RTCPeerConnection(opts.iceServers ? { iceServers: opts.iceServers } : undefined);
  }

  async publish(stream: MediaStream): Promise<void> {
    const { pc } = this;
    for (const track of stream.getTracks()) pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.waitForIceGathering();
    const sdp = pc.localDescription?.sdp ?? offer.sdp ?? '';
    const res = await this.fetchImpl(this.endpoint, { method: 'POST', headers: { 'content-type': 'application/sdp' }, body: sdp });
    if (res.status !== 201) throw new WhepError(`WHIP offer rejected with HTTP ${res.status}`, res.status);
    const location = res.headers.get('location');
    this.resourceUrl = location ? new URL(location, this.endpoint).toString() : null;
    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
  }

  async close(): Promise<void> {
    const url = this.resourceUrl;
    this.resourceUrl = null;
    if (url) {
      try {
        await this.fetchImpl(url, { method: 'DELETE' });
      } catch {
        /* best effort */
      }
    }
    this.pc.close();
  }

  private waitForIceGathering(): Promise<void> {
    const { pc } = this;
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', onChange); resolve(); };
      const onChange = () => { if (pc.iceGatheringState === 'complete') done(); };
      const timer = setTimeout(done, this.iceTimeoutMs);
      pc.addEventListener('icegatheringstatechange', onChange);
    });
  }
}
