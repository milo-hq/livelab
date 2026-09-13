export class WhepError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'WhepError';
  }
}

export interface WhepClientOptions {
  iceServers?: RTCIceServer[];
  fetch?: typeof fetch;
  /** Upper bound for waiting on ICE gathering before the offer is sent (default 1000ms). */
  iceGatheringTimeoutMs?: number;
}

/**
 * Hand-written WHEP (WebRTC-HTTP Egress Protocol) client, ~50 lines of the protocol:
 *   POST <endpoint> (application/sdp offer) → 201 + Location + answer SDP → DELETE <Location> to release.
 * The offer is sent after ICE gathering completes (non-trickle), which is what MediaMTX expects.
 */
export class WhepClient {
  readonly pc: RTCPeerConnection;
  resourceUrl: string | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly iceTimeoutMs: number;

  constructor(
    readonly endpoint: string,
    opts: WhepClientOptions = {},
  ) {
    this.fetchImpl = opts.fetch ?? ((...args) => globalThis.fetch(...args));
    this.iceTimeoutMs = opts.iceGatheringTimeoutMs ?? 1000;
    this.pc = new RTCPeerConnection(opts.iceServers ? { iceServers: opts.iceServers } : undefined);
  }

  async connect(video: HTMLVideoElement): Promise<void> {
    const { pc } = this;
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.ontrack = (ev) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      if (video.srcObject !== stream) video.srcObject = stream;
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.waitForIceGathering();

    const sdp = pc.localDescription?.sdp ?? offer.sdp ?? '';
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/sdp' },
      body: sdp,
    });
    if (res.status !== 201) {
      throw new WhepError(`WHEP offer rejected with HTTP ${res.status}`, res.status);
    }
    const location = res.headers.get('location');
    this.resourceUrl = location ? new URL(location, this.endpoint).toString() : null;
    const answer = await res.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
  }

  async close(): Promise<void> {
    const url = this.resourceUrl;
    this.resourceUrl = null;
    if (url) {
      try {
        await this.fetchImpl(url, { method: 'DELETE' });
      } catch {
        // Releasing the server-side resource is best effort; the session times out anyway.
      }
    }
    this.pc.close();
  }

  private waitForIceGathering(): Promise<void> {
    const { pc } = this;
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      };
      const onChange = () => {
        if (pc.iceGatheringState === 'complete') done();
      };
      const timer = setTimeout(done, this.iceTimeoutMs);
      pc.addEventListener('icegatheringstatechange', onChange);
    });
  }
}
