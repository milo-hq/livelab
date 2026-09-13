import type { Config } from './config.js';
import type { Db } from './db.js';
import { RoomService } from './modules/rooms/service.js';
import type { QoeSummary, ServerMsg } from '@livelab/protocol';
import { WalletService } from './modules/wallet/service.js';
import { createTelemetrySink, type Sink } from './modules/telemetry/sink.js';
import { createQoeSummary } from './modules/telemetry/summary.js';

/** Shared services passed to route modules. Extended by later phases (hub, wallet, telemetry...). */
export interface AppContext {
  cfg: Config;
  db: Db;
  rooms: RoomService;
  /** Whether a MediaMTX path currently has a publisher. Replaced by the health module. */
  liveness: (streamPath: string) => boolean;
  /** Online viewers in a room. Replaced by the IM hub. */
  online: (roomId: string) => number;
  wallet: WalletService;
  /** QoE event sink: ClickHouse when `cfg.clickhouseUrl` is set, otherwise a console sink. */
  telemetry: Sink;
  /** 15-minute QoE summary from ClickHouse; undefined when ClickHouse is not configured. */
  qoeSummary?: () => Promise<QoeSummary>;
  /** Room broadcast hook (gift lane). Wired to the IM hub once it exists; callers use `ctx.broadcast?.()`. */
  broadcast?: (room: string, msg: Omit<ServerMsg, 'seq' | 'ts'>) => Promise<ServerMsg | null>;
}

export function createContext(cfg: Config, db: Db): AppContext {
  return {
    cfg,
    db,
    rooms: new RoomService(db, cfg),
    liveness: () => true,
    online: () => 0,
    wallet: new WalletService(db, cfg),
    telemetry: createTelemetrySink(cfg),
    qoeSummary: cfg.clickhouseUrl ? createQoeSummary({ url: cfg.clickhouseUrl, user: cfg.clickhouseUser, password: cfg.clickhousePassword }) : undefined,
  };
}
