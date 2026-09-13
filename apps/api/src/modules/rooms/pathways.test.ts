import { describe, expect, it } from 'vitest';
import { buildMasterPlaylist, buildPathways, DEMO_RENDITIONS, policyFor } from './pathways.js';

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

describe('buildMasterPlaylist', () => {
  it('lists two variants with absolute media playlist urls and a shared audio group', () => {
    const m = buildMasterPlaylist('http://hls', DEMO_RENDITIONS);
    expect(m.match(/#EXT-X-STREAM-INF/g)).toHaveLength(2);
    expect(m).toContain('BANDWIDTH=2628000');
    expect(m).toContain('BANDWIDTH=764000');
    expect(m).toContain('http://hls/live/demo_720/video1_stream.m3u8');
    expect(m).toContain('URI="http://hls/live/demo_720/audio2_stream.m3u8"');
  });
});
