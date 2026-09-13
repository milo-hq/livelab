import type { Config } from './config.js';
import type { Db } from './db.js';
import { RoomService } from './modules/rooms/service.js';

/** Shared services passed to route modules. Extended by later phases (hub, wallet, telemetry...). */
export interface AppContext {
  cfg: Config;
  db: Db;
  rooms: RoomService;
  /** Whether a MediaMTX path currently has a publisher. Replaced by the health module. */
  liveness: (streamPath: string) => boolean;
  /** Online viewers in a room. Replaced by the IM hub. */
  online: (roomId: string) => number;
}

export function createContext(cfg: Config, db: Db): AppContext {
  return {
    cfg,
    db,
    rooms: new RoomService(db, cfg),
    liveness: () => true,
    online: () => 0,
  };
}
