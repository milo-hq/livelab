import type { Pathway, PlayPolicy, Room } from '@livelab/protocol';
import type { Config } from '../../config.js';

/**
 * Builds the ordered list of playable URLs for a room. Several pathways per room is what makes
 * client-side multi-CDN / multi-protocol failover possible: the player walks the list on failure.
 *
 *  - `local-abr`: multivariant playlist served by this api that stitches two MediaMTX renditions
 *                 (demo_720 / demo_360) so hls.js ABR has something to switch between.
 *  - `local-a`:   MediaMTX LL-HLS single rendition (what a plain CDN origin would look like).
 *  - `local-flv`: SRS HTTP-FLV (desktop low-latency path, needs `pnpm infra:flv`).
 *  - `local-rtc`: MediaMTX WHEP (sub-second interactive path).
 */
export function buildPathways(room: Pick<Room, 'id' | 'mode' | 'streamPath'>, cfg: Pick<Config, 'apiPublicUrl' | 'mediamtxHls' | 'mediamtxWebrtc' | 'srsFlv'>): Pathway[] {
  const abr: Pathway = { protocol: 'llhls', url: `${cfg.apiPublicUrl}/v1/rooms/${room.id}/master.m3u8`, cdn: 'local-abr', priority: 0 };
  const direct: Pathway = { protocol: 'llhls', url: `${cfg.mediamtxHls}/live/${room.streamPath}/index.m3u8`, cdn: 'local-a', priority: 0 };
  const flv: Pathway = { protocol: 'flv', url: `${cfg.srsFlv}/live/${room.streamPath}.flv`, cdn: 'local-flv', priority: 0 };
  const whep: Pathway = { protocol: 'whep', url: `${cfg.mediamtxWebrtc}/live/${room.streamPath}/whep`, cdn: 'local-rtc', priority: 0 };
  const order = room.mode === 'interactive' ? [whep, abr, direct, flv] : [abr, direct, flv, whep];
  return order.map((p, i) => ({ ...p, priority: i + 1 }));
}

export function policyFor(room: Pick<Room, 'mode'>): PlayPolicy {
  return room.mode === 'interactive'
    ? { preferred: 'whep', targetLatencySec: 1, maxStartupMs: 2000, stallLadder: ['switch_pathway', 'switch_protocol'] }
    : { preferred: 'llhls', targetLatencySec: 3, maxStartupMs: 3000, stallLadder: ['nudge', 'seek_live', 'downgrade', 'switch_pathway', 'switch_protocol'] };
}

export interface Rendition { path: string; bandwidth: number; width: number; height: number; codecs: string }

/**
 * Multivariant playlist that references MediaMTX media playlists of two separately published
 * renditions. MediaMTX names its media playlists `video1_stream.m3u8` / `audio2_stream.m3u8`
 * (verified against 1.21.0). A single audio group is shared so level switches only change video.
 */
export function buildMasterPlaylist(hlsBase: string, renditions: Rendition[]): string {
  const first = renditions[0];
  if (!first) throw new Error('no renditions');
  const lines = ['#EXTM3U', '#EXT-X-VERSION:10', '#EXT-X-INDEPENDENT-SEGMENTS', ''];
  lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio",AUTOSELECT=YES,DEFAULT=YES,URI="${hlsBase}/live/${first.path}/audio2_stream.m3u8"`, '');
  for (const r of renditions) {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth},AVERAGE-BANDWIDTH=${Math.round(r.bandwidth * 0.95)},CODECS="${r.codecs}",RESOLUTION=${r.width}x${r.height},FRAME-RATE=30.000,AUDIO="audio"`);
    lines.push(`${hlsBase}/live/${r.path}/video1_stream.m3u8`);
  }
  return lines.join('\n') + '\n';
}

export const DEMO_RENDITIONS: Rendition[] = [
  { path: 'demo_720', bandwidth: 2500000 + 128000, width: 1280, height: 720, codecs: 'avc1.4d401f,mp4a.40.2' },
  { path: 'demo_360', bandwidth: 700000 + 64000, width: 640, height: 360, codecs: 'avc1.4d401e,mp4a.40.2' },
];
