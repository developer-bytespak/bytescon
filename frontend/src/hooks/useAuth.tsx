import { createContext, useContext, useState, useMemo, useEffect, ReactNode } from 'react';
import { unregisterServiceWorker } from '../lib/registerServiceWorker';
import { identifyUser, resetAnalytics } from '../lib/analytics';

interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: 'ADMIN' | 'CONSULTANT';
}

interface Firm {
  id: string;
  name: string;
}

interface AuthState {
  token: string | null;
  user: User | null;
  firm: Firm | null;
}

interface AuthContextValue extends AuthState {
  login: (token: string, user: User, firm: Firm) => void;
  logout: () => void;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// The session token now lives in an http-only cookie, not localStorage — it is
// never persisted here. Only { user, firm } is stored so the UI can render the
// signed-in shell across reloads; the cookie carries auth on every request.
export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthState>(() => {
    try {
      const stored = localStorage.getItem('bytescon_auth');
      const parsed = stored ? JSON.parse(stored) : null;
      return { token: parsed?.token ?? null, user: parsed?.user ?? null, firm: parsed?.firm ?? null };
    } catch {
      return { token: null, user: null, firm: null };
    }
  });

  useEffect(() => {
    if (auth.user) {
      identifyUser(auth.user, auth.firm);
    }
  }, [auth.user, auth.firm]);

  const value = useMemo(() => ({
    ...auth,
    isAuthenticated: !!auth.user,
    login: (token: string, user: User, firm: Firm) => {
      setAuth({ token, user, firm });
      // Persist the bearer token alongside the display identity. The session
      // cookie is SameSite=Lax, which browsers refuse to attach on cross-site
      // XHR — and production serves the app (vercel.app) and the API
      // (onrender.com) from different sites, so the cookie alone cannot carry
      // auth there. api.ts's request interceptor reads this token. Once app
      // and API share one registrable domain the cookie works again and this
      // becomes redundant defense-in-depth.
      localStorage.setItem('bytescon_auth', JSON.stringify({ token, user, firm }));
      identifyUser(user, firm);
    },
    logout: () => {
      // Clear the http-only cookie server-side (page JS cannot touch it).
      void fetch(`${API_BASE}/api/auth/logout`, { method: 'POST', credentials: 'include' }).catch(() => {});
      setAuth({ token: null, user: null, firm: null });
      localStorage.removeItem('bytescon_auth');
      // §8.5 — drop the installed shell and everything it cached. It holds no
      // data, but a device that changes hands should keep nothing at all.
      void unregisterServiceWorker();
      resetAnalytics();
    },
  }), [auth]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}