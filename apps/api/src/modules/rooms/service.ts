import type { Room, RoomWithKey } from '@livelab/protocol';
import type { Db } from '../../db.js';
import type { Config } from '../../config.js';
import { newId } from '../../lib/ids.js';

interface RoomRow { id: string; title: string; host_id: string; host_name: string; mode: string; stream_path: string; stream_key: string; cover_url: string; created_at: number }

export class RoomService {
  constructor(private db: Db, private cfg: Config) {
    this.seed();
  }

  private seed() {
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM rooms').get() as { n: number }).n;
    if (count > 0) return;
    const ins = this.db.prepare(`INSERT INTO rooms (id,title,host_id,host_name,mode,stream_path,stream_key,cover_url,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    const now = Date.now();
    ins.run('demo', 'LiveLab 演示间 · LL-HLS/FLV', 'host-demo', 'LiveLab Host', 'standard', 'demo', newId('sk'), '/covers/demo.svg', now);
    ins.run('demo-rt', 'LiveLab 互动间 · WebRTC 亚秒', 'host-demo', 'LiveLab Host', 'interactive', 'demo', newId('sk'), '/covers/demo-rt.svg', now);
  }

  private toRoom(r: RoomRow, live: boolean, viewers: number): Room {
    return {
      id: r.id, title: r.title, hostId: r.host_id, hostName: r.host_name,
      status: live ? 'live' : 'offline', mode: r.mode as Room['mode'], viewers,
      coverUrl: r.cover_url, streamPath: r.stream_path, createdAt: r.created_at,
    };
  }

  /** `liveness`/`viewers` are injected by the caller (MediaMTX health + IM hub online counts). */
  list(liveness: (path: string) => boolean = () => true, viewers: (id: string) => number = () => 0): Room[] {
    const rows = this.db.prepare('SELECT * FROM rooms ORDER BY created_at').all() as unknown as RoomRow[];
    return rows.map((r) => this.toRoom(r, liveness(r.stream_path), viewers(r.id)));
  }

  get(id: string, liveness: (path: string) => boolean = () => true, viewers = 0): Room | null {
    const r = this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as unknown as RoomRow | undefined;
    return r ? this.toRoom(r, liveness(r.stream_path), viewers) : null;
  }

  getWithKey(id: string): RoomWithKey | null {
    const r = this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as unknown as RoomRow | undefined;
    if (!r) return null;
    const base = this.toRoom(r, true, 0);
    return {
      ...base,
      streamKey: r.stream_key,
      ingest: {
        rtmp: `${this.cfg.mediamtxRtmp}/live/${r.stream_path}`,
        whip: `${this.cfg.mediamtxWebrtc}/live/${r.stream_path}/whip`,
        srt: `${this.cfg.mediamtxSrt}?streamid=publish:live/${r.stream_path}`,
      },
    };
  }

  resetKey(id: string): string {
    const key = newId('sk');
    this.db.prepare('UPDATE rooms SET stream_key = ? WHERE id = ?').run(key, id);
    return key;
  }
}
