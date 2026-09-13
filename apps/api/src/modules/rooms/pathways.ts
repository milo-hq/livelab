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
export interface ResolvedRendition extends Rendition { videoUrl: string; audioUrl: string | null }

/**
 * MediaMTX (≥1.13) scopes every HLS viewer to a *session*: the multivariant playlist it serves
 * embeds `?session=<uuid>` into the media-playlist URIs (a cookie is used on HTTPS instead), and
 * media playlists / segments without a valid session get 401. So to stitch two MediaMTX
 * renditions into one ABR master we must first ask MediaMTX for each rendition's multivariant
 * playlist and reuse the session-scoped URIs it hands back — exactly what a real "playlist
 * stitching" origin does in front of a packager.
 */
export async function resolveRendition(hlsBase: string, r: Rendition, fetchImpl: typeof fetch = fetch): Promise<ResolvedRendition> {
  const indexUrl = `${hlsBase}/live/${r.path}/index.m3u8?cookieCheck=1`;
  const res = await fetchImpl(indexUrl, { headers: { origin: 'livelab-api' } });
  if (!res.ok) throw new Error(`rendition ${r.path} unavailable (${res.status})`);
  const text = await res.text();
  let audioUrl: string | null = null;
  let videoUrl: string | null = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('#EXT-X-MEDIA:') && line.includes('TYPE=AUDIO')) {
      const m = /URI="([^"]+)"/.exec(line);
      if (m) audioUrl = new URL(m[1]!, indexUrl).toString();
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const next = lines[i + 1]?.trim();
      if (next && !next.startsWith('#')) videoUrl = new URL(next, indexUrl).toString();
    }
  }
  if (!videoUrl) throw new Error(`rendition ${r.path}: no video playlist in multivariant playlist`);
  return { ...r, videoUrl, audioUrl };
}

/**
 * Multivariant playlist that references the session-scoped media playlists of two separately
 * published MediaMTX renditions. A single audio group (from the first rendition) is shared so a
 * level switch only changes video.
 */
export function buildMasterPlaylist(renditions: ResolvedRendition[]): string {
  const first = renditions[0];
  if (!first) throw new Error('no renditions');
  const lines = ['#EXTM3U', '#EXT-X-VERSION:10', '#EXT-X-INDEPENDENT-SEGMENTS', ''];
  if (first.audioUrl) lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio",AUTOSELECT=YES,DEFAULT=YES,URI="${first.audioUrl}"`, '');
  for (const r of renditions) {
    const audio = first.audioUrl ? ',AUDIO="audio"' : '';
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth},AVERAGE-BANDWIDTH=${Math.round(r.bandwidth * 0.95)},CODECS="${r.codecs}",RESOLUTION=${r.width}x${r.height},FRAME-RATE=30.000${audio}`);
    lines.push(r.videoUrl);
  }
  return lines.join('\n') + '\n';
}

export const DEMO_RENDITIONS: Rendition[] = [
  { path: 'demo_720', bandwidth: 2500000 + 128000, width: 1280, height: 720, codecs: 'avc1.4d401f,mp4a.40.2' },
  { path: 'demo_360', bandwidth: 700000 + 64000, width: 640, height: 360, codecs: 'avc1.4d401e,mp4a.40.2' },
];
