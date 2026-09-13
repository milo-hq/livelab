import { vi } from 'vitest';

/** Minimal RTCPeerConnection stand-in for WHEP tests (jsdom has no WebRTC). */
export class FakePeerConnection extends EventTarget {
  static instances: FakePeerConnection[] = [];
  config: RTCConfiguration | undefined;
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  iceGatheringState: RTCIceGatheringState = 'new';
  connectionState: RTCPeerConnectionState = 'new';
  ontrack: ((ev: RTCTrackEvent) => void) | null = null;
  transceivers: Array<{ kind: string; init: RTCRtpTransceiverInit | undefined }> = [];
  statsReport: Array<Record<string, unknown>> = [];
  close = vi.fn(() => {
    this.connectionState = 'closed';
  });

  constructor(config?: RTCConfiguration) {
    super();
    this.config = config;
    FakePeerConnection.instances.push(this);
  }
  addTransceiver(kind: string, init?: RTCRtpTransceiverInit) {
    this.transceivers.push({ kind, init });
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'v=0\r\no=- offer\r\n' };
  }
  async setLocalDescription(desc: RTCSessionDescriptionInit) {
    this.localDescription = desc;
  }
  async setRemoteDescription(desc: RTCSessionDescriptionInit) {
    this.remoteDescription = desc;
  }
  async getStats() {
    return new Map(this.statsReport.map((s, i) => [String(i), s]));
  }
  /** Test helpers */
  finishIceGathering() {
    this.iceGatheringState = 'complete';
    this.dispatchEvent(new Event('icegatheringstatechange'));
  }
  setConnectionState(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.dispatchEvent(new Event('connectionstatechange'));
  }
}

export function installFakeRtc() {
  const g = globalThis as Record<string, unknown>;
  const prev = g['RTCPeerConnection'];
  g['RTCPeerConnection'] = FakePeerConnection;
  FakePeerConnection.instances.length = 0;
  return () => {
    g['RTCPeerConnection'] = prev;
  };
}

export function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(String(input), init ?? {})));
}
