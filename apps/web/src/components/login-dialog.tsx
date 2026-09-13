import { useState } from 'react';
import { AuthResponse, type Role } from '@livelab/protocol';
import { api } from '../lib/api';
import { useSession } from '../stores/session';

export function LoginDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const setSession = useSession((s) => s.setSession);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post('/v1/auth/demo', { name, role }, AuthResponse);
      setSession(r.user, r.token);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()} className="w-80 space-y-4 rounded-lg border border-zinc-800 bg-zinc-900 p-5">
        <h2 className="text-lg font-semibold">演示登录</h2>
        <p className="text-xs text-zinc-400">无密码。同名同角色会得到同一个账号与钱包。</p>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="昵称" maxLength={24}
          className="w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 outline-none focus:border-brand" />
        <div className="flex gap-2 text-sm">
          {(['viewer', 'host', 'admin'] as Role[]).map((r) => (
            <label key={r} className={`flex-1 cursor-pointer rounded border px-2 py-1 text-center ${role === r ? 'border-brand text-zinc-100' : 'border-zinc-700 text-zinc-400'}`}>
              <input type="radio" className="hidden" checked={role === r} onChange={() => setRole(r)} />
              {r === 'viewer' ? '观众' : r === 'host' ? '主播' : '管理员'}
            </label>
          ))}
        </div>
        {err && <p className="text-sm text-red-400">{err}</p>}
        <button disabled={busy || !name.trim()} className="w-full rounded bg-brand py-2 font-medium disabled:opacity-50">进入</button>
      </form>
    </div>
  );
}
