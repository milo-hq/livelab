import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { UserRef } from '@livelab/protocol';

interface SessionState {
  user: UserRef | null;
  token: string | null;
  setSession(user: UserRef, token: string): void;
  logout(): void;
}

export const useSession = create<SessionState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      setSession: (user, token) => set({ user, token }),
      logout: () => set({ user: null, token: null }),
    }),
    { name: 'livelab.session' },
  ),
);
