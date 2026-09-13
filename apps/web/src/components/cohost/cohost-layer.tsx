import { useEffect, useRef } from 'react';
import { WhepEngine } from '@livelab/player-core';
import type { Cohost } from '@livelab/protocol';
import { useRoomStore } from '../../stores/room';
import { useSession } from '../../stores/session';

function CohostTile({ cohost }: { cohost: Cohost }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = videoRef.current!;
    const engine = new WhepEngine();
    let alive = true;
    // A guest's stream appears on MediaMTX a moment after "accepted"; retry a few times.
    const attempt = async (n: number) => {
      try {
        await engine.load(video, cohost.whep, { targetLatencySec: 1 });
        void video.play().catch(() => {});
      } catch {
        if (alive && n < 10) setTimeout(() => attempt(n + 1), 1500);
      }
    };
    void attempt(0);
    return () => { alive = false; engine.destroy(); };
  }, [cohost.whep]);
  return (
    <div className="w-40 overflow-hidden rounded-lg border border-zinc-600 bg-black/80 shadow-lg">
      <video ref={videoRef} playsInline className="aspect-video w-full object-cover" />
      <div className="truncate px-2 py-0.5 text-[11px]">🎙 {cohost.name}</div>
    </div>
  );
}

/** Picture-in-picture tiles for every guest on air (from room state, so late joiners see them too). */
export function CohostLayer() {
  const cohosts = useRoomStore((s) => s.state.cohosts);
  const me = useSession((s) => s.user);
  const others = cohosts.filter((c) => c.userId !== me?.id);
  if (others.length === 0) return null;
  return (
    <div className="pointer-events-auto absolute right-3 top-12 flex flex-col gap-2">
      {others.map((c) => <CohostTile key={c.userId} cohost={c} />)}
    </div>
  );
}
