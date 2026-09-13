export interface Emitter<M> {
  on<K extends keyof M>(ev: K, cb: (p: M[K]) => void): () => void;
  emit<K extends keyof M>(ev: K, payload: M[K]): void;
  clear(): void;
}

/** Minimal typed event emitter. Listener exceptions are isolated so one bad subscriber cannot break playback. */
export function createEmitter<M>(): Emitter<M> {
  const listeners = new Map<keyof M, Set<(p: never) => void>>();
  return {
    on(ev, cb) {
      let set = listeners.get(ev);
      if (!set) {
        set = new Set();
        listeners.set(ev, set);
      }
      set.add(cb as (p: never) => void);
      return () => {
        set?.delete(cb as (p: never) => void);
      };
    },
    emit(ev, payload) {
      const set = listeners.get(ev);
      if (!set) return;
      for (const cb of Array.from(set)) {
        try {
          (cb as (p: M[typeof ev]) => void)(payload);
        } catch (err) {
          // Never let a subscriber crash the engine loop.
          console.error('[player-core] listener error', err);
        }
      }
    },
    clear() {
      listeners.clear();
    },
  };
}
