import { useEffect, useState } from 'react';

/**
 * The test stream burns the encoder's UTC clock into the picture. Showing the viewer's UTC clock
 * next to it makes glass-to-glass latency readable by eye: (this clock) − (clock in the picture).
 */
export function UtcClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 250);
    return () => clearInterval(t);
  }, []);
  const s = now.toISOString().slice(11, 19);
  return <span className="rounded bg-black/60 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-zinc-300" title="本机 UTC 时间，减去画面中的时间即端到端延迟">现在 {s} UTC</span>;
}
