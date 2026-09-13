import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePeerConnection } from '../test/fake-rtc.js';
import { WhipClient } from './whip-client.js';

const fakeStream = () => ({ getTracks: () => [{ kind: 'video' }, { kind: 'audio' }] }) as unknown as MediaStream;

describe('WhipClient', () => {
  beforeEach(() => {
    FakePeerConnection.instances = [];
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('publishes local tracks as sendonly, POSTs the offer and applies the answer', async () => {
    const fetchImpl = vi.fn(async () => new Response('v=0\r\no=- answer\r\n', { status: 201, headers: { location: '/cohost/demo/u1/whip/abc' } }));
    const c = new WhipClient('http://rtc/cohost/demo/u1/whip', { fetch: fetchImpl as unknown as typeof fetch, iceGatheringTimeoutMs: 5 });
    await c.publish(fakeStream());
    const pc = FakePeerConnection.instances[0]!;
    expect(pc.transceivers.map((t) => t.init?.direction)).toEqual(['sendonly', 'sendonly']);
    expect(fetchImpl).toHaveBeenCalledWith('http://rtc/cohost/demo/u1/whip', expect.objectContaining({ method: 'POST', body: 'v=0\r\no=- offer\r\n' }));
    expect(pc.remoteDescription?.sdp).toContain('answer');
    expect(c.resourceUrl).toBe('http://rtc/cohost/demo/u1/whip/abc');
    await c.close();
    expect(fetchImpl).toHaveBeenLastCalledWith('http://rtc/cohost/demo/u1/whip/abc', { method: 'DELETE' });
    expect(pc.close).toHaveBeenCalled();
  });

  it('throws with the HTTP status when the server refuses', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 400 }));
    const c = new WhipClient('http://rtc/x/whip', { fetch: fetchImpl as unknown as typeof fetch, iceGatheringTimeoutMs: 5 });
    await expect(c.publish(fakeStream())).rejects.toMatchObject({ status: 400 });
  });
});
