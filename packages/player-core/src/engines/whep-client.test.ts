import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WhepClient, WhepError } from './whep-client.js';
import { FakePeerConnection, fakeFetch, installFakeRtc } from '../test/fake-rtc.js';

describe('WhepClient', () => {
  let restore: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    restore = installFakeRtc();
  });
  afterEach(() => {
    restore();
    vi.useRealTimers();
  });

  it('POSTs the SDP offer, applies the answer and stores an absolute Location', async () => {
    const fetch = fakeFetch((url, init) => {
      expect(url).toBe('http://mediamtx:8889/demo/whep');
      expect(init.method).toBe('POST');
      expect(new Headers(init.headers).get('content-type')).toBe('application/sdp');
      expect(init.body).toBe('v=0\r\no=- offer\r\n');
      return new Response('v=0\r\no=- answer\r\n', { status: 201, headers: { Location: 'http://mediamtx:8889/demo/whep/abc' } });
    });
    const client = new WhepClient('http://mediamtx:8889/demo/whep', { fetch, iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    const pc = client.pc as unknown as FakePeerConnection;
    expect(pc.config?.iceServers).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
    const video = document.createElement('video');
    const p = client.connect(video);
    await vi.advanceTimersByTimeAsync(0);
    pc.finishIceGathering();
    await p;
    expect(pc.transceivers.map((t) => t.kind)).toEqual(['video', 'audio']);
    expect(pc.transceivers.every((t) => t.init?.direction === 'recvonly')).toBe(true);
    expect(pc.remoteDescription).toEqual({ type: 'answer', sdp: 'v=0\r\no=- answer\r\n' });
    expect(client.resourceUrl).toBe('http://mediamtx:8889/demo/whep/abc');
  });

  it('resolves a relative Location against the endpoint', async () => {
    const fetch = fakeFetch(() => new Response('sdp', { status: 201, headers: { Location: '/demo/whep/xyz' } }));
    const client = new WhepClient('http://mediamtx:8889/demo/whep', { fetch });
    (client.pc as unknown as FakePeerConnection).iceGatheringState = 'complete';
    await client.connect(document.createElement('video'));
    expect(client.resourceUrl).toBe('http://mediamtx:8889/demo/whep/xyz');
  });

  it('does not wait longer than 1s for ICE gathering', async () => {
    const fetch = fakeFetch(() => new Response('sdp', { status: 201, headers: { Location: 'r' } }));
    const client = new WhepClient('http://h/whep', { fetch });
    const p = client.connect(document.createElement('video'));
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('throws WhepError with the HTTP status on non-201 responses', async () => {
    const fetch = fakeFetch(() => new Response('nope', { status: 404 }));
    const client = new WhepClient('http://h/whep', { fetch });
    (client.pc as unknown as FakePeerConnection).iceGatheringState = 'complete';
    const err = await client.connect(document.createElement('video')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WhepError);
    expect((err as WhepError).status).toBe(404);
  });

  it('close() DELETEs the resource (ignoring failures) and closes the peer connection', async () => {
    const calls: Array<{ url: string; method: string | undefined }> = [];
    const fetch = fakeFetch((url, init) => {
      calls.push({ url, method: init.method });
      if (init.method === 'DELETE') throw new Error('network down');
      return new Response('sdp', { status: 201, headers: { Location: 'http://h/whep/1' } });
    });
    const client = new WhepClient('http://h/whep', { fetch });
    const pc = client.pc as unknown as FakePeerConnection;
    pc.iceGatheringState = 'complete';
    await client.connect(document.createElement('video'));
    await expect(client.close()).resolves.toBeUndefined();
    expect(calls.at(-1)).toEqual({ url: 'http://h/whep/1', method: 'DELETE' });
    expect(pc.close).toHaveBeenCalledTimes(1);
    expect(client.resourceUrl).toBeNull();
  });

  it('attaches the remote stream to the video element on track', async () => {
    const fetch = fakeFetch(() => new Response('sdp', { status: 201 }));
    const client = new WhepClient('http://h/whep', { fetch });
    const pc = client.pc as unknown as FakePeerConnection;
    pc.iceGatheringState = 'complete';
    const video = document.createElement('video');
    await client.connect(video);
    const stream = { id: 'stream-1' } as unknown as MediaStream;
    pc.ontrack?.({ streams: [stream], track: {} } as unknown as RTCTrackEvent);
    expect(video.srcObject).toBe(stream);
  });
});
