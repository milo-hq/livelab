import type { Config } from './config.js';
import type { Db } from './db.js';
import { RoomService } from './modules/rooms/service.js';
import type { QoeSummary } from '@livelab/protocol';
import { createHealthService, type HealthService } from './modules/rooms/health.js';
import { createMemoryBus, createRedisBus, type Bus } from './modules/im/bus.js';
import { createMemoryHistory, createRedisHistory, type History } from './modules/im/history.js';
import { RoomHub } from './modules/im/hub.js';
import { Moderation } from './modules/im/moderation.js';

/** Shared services passed to route modules. Extended by later phases (hub, wallet, telemetry...). */
export interface AppContext {
  cfg: Config;
  db: Db;
  rooms: RoomService;
  /** Whether a MediaMTX path currently has a publisher. Replaced by the health module. */
  liveness: (streamPath: string) => boolean;
  /** Online viewers in a room. Replaced by the IM hub. */
  online: (roomId: string) => number;
  /** IM gateway: rooms, seq, batching, fan-out. */
  hub: RoomHub;
  moderation: Moderation;
  /** MediaMTX stream health (cached). */
  health: HealthService;
  /** Fan-out bus (Redis when configured and reachable, else in-memory). */
  bus: Bus;
  history: History;
  /** QoE summary for the admin overview; wired by the telemetry module when ClickHouse is configured. */
  qoeSummary?: () => Promise<QoeSummary>;
}

export interface ContextLogger { info: (msg: string) => void; warn: (msg: string) => void }

export async function createContext(cfg: Config, db: Db, log: ContextLogger = console): Promise<AppContext> {
  const { bus, history } = await pickImBackend(cfg, log);
  const moderation = new Moderation(db);
  const hub = new RoomHub({ bus, history, initialState: (room) => ({ slowModeSec: moderation.slowModeSec(room) }) });
  const health = createHealthService(cfg);
  return {
    cfg,
    db,
    rooms: new RoomService(db, cfg),
    liveness: (streamPath) => health.isReadyCached(streamPath),
    online: (roomId) => hub.online(roomId),
    hub,
    moderation,
    health,
    bus,
    history,
  };
}

/**
 * Redis is optional: with `REDIS_URL` set and reachable within 2s the api is horizontally scalable
 * (shared seq/history + pub/sub fan-out); otherwise everything lives in this process, which is all a
 * single dev instance needs.
 */
async function pickImBackend(cfg: Config, log: ContextLogger): Promise<{ bus: Bus; history: History }> {
  if (cfg.redisUrl) {
    const redisBus = createRedisBus(cfg.redisUrl, { onError: (e) => log.warn(`redis: ${(e as Error).message}`) });
    try {
      await redisBus.ready(2000);
      log.info(`im: using redis bus/history at ${cfg.redisUrl}`);
      return { bus: redisBus, history: createRedisHistory(redisBus.client) };
    } catch (e) {
      await redisBus.close();
      log.warn(`im: redis unavailable (${(e as Error).message}); falling back to in-memory bus/history`);
    }
  } else {
    log.info('im: REDIS_URL not set; using in-memory bus/history');
  }
  return { bus: createMemoryBus(), history: createMemoryHistory() };
}
