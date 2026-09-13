import { useState } from 'react';

export function ReportIssue({ onReport }: { onReport: (description: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [done, setDone] = useState(false);
  return (
    <>
      <button onClick={() => { setOpen(true); setDone(false); }} className="rounded bg-black/60 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-black/80">报障</button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} className="w-80 space-y-3 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <h3 className="font-semibold">播放报障</h3>
            <p className="text-xs text-zinc-400">会附带最近 50 条播放器日志与近 60s 的媒体请求瀑布，强制 100% 上报。</p>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="描述现象，例如：卡了三次、黑屏有声音" className="w-full rounded border border-zinc-700 bg-zinc-950 p-2 text-sm" />
            {done ? <p className="text-sm text-green-400">已提交，感谢。</p> : (
              <button onClick={async () => { await onReport(text || '(no description)'); setDone(true); setText(''); }} className="w-full rounded bg-brand py-1.5 text-sm font-medium">提交</button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
