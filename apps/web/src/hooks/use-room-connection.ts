import { useEffect, useRef } from 'react';
import type { ClientFrame } from '@livelab/protocol';
import { createImClient, type ImClient } from '../lib/im-client';
import { useRoomStore } from '../stores/room';
import { useSession } from '../stores/session';

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

/** Opens the room WebSocket for the lifetime of the component and pipes frames into the room store. */
export function useRoomConnection(roomId: string) {
  const token = useSession((s) => s.token);
  const clientRef = useRef<ImClient | null>(null);

  useEffect(() => {
    if (!token) return;
    const store = useRoomStore.getState();
    store.reset(roomId);
    const client = createImClient({
      url: wsUrl(),
      room: roomId,
      token,
      onFrame: (f) => useRoomStore.getState().applyFrame(f),
      onStatus: (s, info) => useRoomStore.getState().setStatus(s, info?.attempt),
    });
    clientRef.current = client;
    return () => {
      client.close();
      clientRef.current = null;
    };
  }, [roomId, token]);

  return {
    send: (frame: ClientFrame) => clientRef.current?.send(frame) ?? false,
  };
}
