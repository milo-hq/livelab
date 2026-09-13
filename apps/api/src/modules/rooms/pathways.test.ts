import { describe, expect, it } from 'vitest';
import { buildMasterPlaylist, buildPathways, DEMO_RENDITIONS, policyFor, resolveRendition } from './pathways.js';

const cfg = { apiPublicUrl: 'http://api', mediamtxHls: 'http://hls', mediamtxWebrtc: 'http://rtc', srsFlv: 'http://flv' };

describe('buildPathways', () => {
  it('standard room prefers LL-HLS and has 4 pathways sorted by priority', () => {
    const p = buildPathways({ id: 'demo', mode: 'standard', streamPath: 'demo' }, cfg);
    expect(p).toHaveLength(4);
    expect(p.map((x) => x.protocol)).toEqual(['llhls', 'llhls', 'flv', 'whep']);
    expect(p.map((x) => x.priority)).toEqual([1, 2, 3, 4]);
    expect(p[0]!.url).toBe('http://api/v1/rooms/demo/master.m3u8');
    expect(p[3]!.url).toBe('http://rtc/live/demo/whep');
  });
  it('interactive room prefers WHEP', () => {
    const p = buildPathways({ id: 'x', mode: 'interactive', streamPath: 'demo' }, cfg);
    expect(p[0]!.protocol).toBe('whep');
    expect(policyFor({ mode: 'interactive' }).targetLatencySec).toBe(1);
  });
});

const MTX_INDEX = (session: string) => `#EXTM3U
#EXT-X-VERSION:10
#EXT-X-INDEPENDENT-SEGMENTS

#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio2",AUTOSELECT=YES,DEFAULT=YES,URI="audio2_stream.m3u8?session=${session}"

#EXT-X-STREAM-INF:BANDWIDTH=2555184,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=1280x720,FRAME-RATE=30.000,AUDIO="audio"
video1_stream.m3u8?session=${session}
`;

describe('resolveRendition + buildMasterPlaylist', () => {
  it('reuses the session-scoped media playlist urls MediaMTX hands out', async () => {
    const fakeFetch = (async (url: string | URL | Request) => {
      const u = String(url);
      const session = u.includes('demo_720') ? 'sess-720' : 'sess-360';
      return new Response(MTX_INDEX(session), { status: 200 });
    }) as unknown as typeof fetch;
    const resolved = await Promise.all(DEMO_RENDITIONS.map((r) => resolveRendition('http://hls', r, fakeFetch)));
    expect(resolved[0]!.videoUrl).toBe('http://hls/live/demo_720/video1_stream.m3u8?session=sess-720');
    expect(resolved[0]!.audioUrl).toBe('http://hls/live/demo_720/audio2_stream.m3u8?session=sess-720');
    expect(resolved[1]!.videoUrl).toBe('http://hls/live/demo_360/video1_stream.m3u8?session=sess-360');

    const m = buildMasterPlaylist(resolved);
    expect(m.match(/#EXT-X-STREAM-INF/g)).toHaveLength(2);
    expect(m).toContain('BANDWIDTH=2628000');
    expect(m).toContain('BANDWIDTH=764000');
    expect(m).toContain('\nhttp://hls/live/demo_360/video1_stream.m3u8?session=sess-360\n');
    expect(m).toContain('URI="http://hls/live/demo_720/audio2_stream.m3u8?session=sess-720"');
  });

  it('fails loudly when a rendition is not being published', async () => {
    const fakeFetch = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    await expect(resolveRendition('http://hls', DEMO_RENDITIONS[0]!, fakeFetch)).rejects.toThrow(/unavailable/);
  });
});
