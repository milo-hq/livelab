import { Link, NavLink, Outlet } from 'react-router';
import { useSession } from '../stores/session';
import { LoginDialog } from './login-dialog';
import { useState } from 'react';

const nav = [
  { to: '/', label: '直播间' },
  { to: '/lab', label: '播放实验室' },
  { to: '/admin', label: '管理后台' },
];

export function Layout() {
  const { user, logout } = useSession();
  const [login, setLogin] = useState(false);
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-6 border-b border-zinc-800 px-4">
        <Link to="/" className="flex items-center gap-2 font-semibold">
          <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-brand" /> LiveLab
        </Link>
        <nav className="flex gap-4 text-sm text-zinc-400">
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive ? 'text-zinc-100' : 'hover:text-zinc-200')}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm">
          {user ? (
            <>
              <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">{user.role}</span>
              <span>{user.name}</span>
              <button className="text-zinc-400 hover:text-zinc-200" onClick={logout}>退出</button>
            </>
          ) : (
            <button className="rounded bg-brand px-3 py-1 font-medium hover:bg-brand-dim" onClick={() => setLogin(true)}>登录</button>
          )}
        </div>
      </header>
      <main className="min-h-0 flex-1">
        <Outlet />
      </main>
      {login && <LoginDialog onClose={() => setLogin(false)} />}
    </div>
  );
}
