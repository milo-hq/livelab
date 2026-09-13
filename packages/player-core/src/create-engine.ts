import type { EngineKind, PlayerEngine } from './types.js';

/**
 * Instantiates an engine by kind, importing the engine module lazily so hls.js / mpegts.js
 * only end up in the bundle chunk (and the network) for the protocol actually played.
 */
export async function createEngine(kind: EngineKind): Promise<PlayerEngine> {
  switch (kind) {
    case 'hls': {
      const { HlsEngine } = await import('./engines/hls.js');
      return new HlsEngine();
    }
    case 'flv': {
      const { FlvEngine } = await import('./engines/flv.js');
      return new FlvEngine();
    }
    case 'whep': {
      const { WhepEngine } = await import('./engines/whep.js');
      return new WhepEngine();
    }
    case 'native-hls': {
      const { NativeHlsEngine } = await import('./engines/native-hls.js');
      return new NativeHlsEngine();
    }
    default: {
      const never: never = kind;
      throw new Error(`Unknown engine kind: ${String(never)}`);
    }
  }
}
