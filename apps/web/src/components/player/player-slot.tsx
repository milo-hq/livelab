/**
 * Placeholder until `@livelab/player-core` lands; replaced by <LivePlayer/> in Task 1.6.
 */
export function PlayerSlot({ roomId }: { roomId: string; muted?: boolean }) {
  return <div className="flex h-full w-full items-center justify-center text-sm text-zinc-500">播放器加载中… ({roomId})</div>;
}
