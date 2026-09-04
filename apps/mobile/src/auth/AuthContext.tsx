import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { AuthResponse, PublicUser } from '@wardrobe/shared';
import { apiRequest, ApiClientError } from '../api/client';
import { clearToken, loadToken, saveToken } from './tokenStore';

export type AuthStatus = 'restoring' | 'authenticated' | 'anonymous';

interface AuthValue {
  status: AuthStatus;
  user: PublicUser | null;
  token: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (name: string, email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('restoring');
  const [user, setUser] = useState<PublicUser | null>(null);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const stored = await loadToken();
      if (cancelled) return;

      if (!stored) {
        setStatus('anonymous');
        return;
      }

      try {
        const res = await apiRequest<{ user: PublicUser }>('/auth/me', { token: stored });
        if (cancelled) return;
        setToken(stored);
        setUser(res.user);
        setStatus('authenticated');
      } catch (err) {
        if (cancelled) return;
        // Only discard the token if the SERVER rejected it. A network failure
        // means we could not ask, so the token may still be perfectly valid.
        if (err instanceof ApiClientError && err.code === 'UNAUTHORIZED') {
          await clearToken();
        }
        setStatus('anonymous');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const adopt = useCallback(async (res: AuthResponse) => {
    await saveToken(res.token);
    setToken(res.token);
    setUser(res.user);
    setStatus('authenticated');
  }, []);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const res = await apiRequest<AuthResponse>('/auth/login', { method: 'POST', body: { email, password } });
      await adopt(res);
    },
    [adopt],
  );

  const signUp = useCallback(
    async (name: string, email: string, password: string) => {
      const res = await apiRequest<AuthResponse>('/auth/register', { method: 'POST', body: { name, email, password } });
      await adopt(res);
    },
    [adopt],
  );

  const signOut = useCallback(async () => {
    await clearToken();
    setToken(null);
    setUser(null);
    setStatus('anonymous');
  }, []);

  const value = useMemo(
    () => ({ status, user, token, signIn, signUp, signOut }),
    [status, user, token, signIn, signUp, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside an AuthProvider');
  return ctx;
}
