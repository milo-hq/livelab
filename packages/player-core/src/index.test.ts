import { describe, expect, it } from 'vitest';
import * as api from './index.js';

describe('public API', () => {
  it('exports the documented surface', () => {
    const names = [
      'detectCapabilities', 'createEmitter', 'HlsEngine', 'FlvEngine', 'WhepEngine', 'NativeHlsEngine', 'WhepClient',
      'buildHlsConfig', 'createQoeProbe', 'createPlayerController', 'selectPathways', 'describePathway', 'createEngine',
    ] as const;
    for (const n of names) expect(typeof api[n], n).toBe('function');
  });

  it('createEngine lazily instantiates engines by kind', async () => {
    expect(await api.createEngine('native-hls')).toBeInstanceOf(api.NativeHlsEngine);
    expect(await api.createEngine('hls')).toBeInstanceOf(api.HlsEngine);
    expect(await api.createEngine('flv')).toBeInstanceOf(api.FlvEngine);
    expect(await api.createEngine('whep')).toBeInstanceOf(api.WhepEngine);
  });
});
