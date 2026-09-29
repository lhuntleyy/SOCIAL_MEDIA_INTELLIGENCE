import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { api, type Me, onToken, refreshSession, setToken } from "./api";

interface AuthState {
  me: Me | null;
  loading: boolean;
  login: (email: string, password: string, otp?: string) => Promise<"ok" | "setup_required">;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
}
const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    try {
      setMe(await api<Me>("/me"));
    } catch {
      setMe(null);
    }
  }, []);
  useEffect(() => {
    // pulihkan sesi dari cookie refresh (HttpOnly) saat halaman dibuka
    void refreshSession()
      .then((ok) => (ok ? reload() : undefined))
      .finally(() => setLoading(false));
    return onToken((t) => {
      if (!t) setMe(null);
    });
  }, [reload]);
  const login = useCallback(
    async (email: string, password: string, otp?: string) => {
      const r = await api<{ access_token: string; mfa: "ok" | "setup_required" }>("/auth/login", {
        method: "POST",
        json: { email, password, ...(otp ? { otp } : {}) },
      });
      setToken(r.access_token);
      await reload();
      return r.mfa;
    },
    [reload],
  );
  const logout = useCallback(async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    setToken(null);
    setMe(null);
  }, []);
  return <Ctx.Provider value={{ me, loading, login, logout, reload }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth di luar AuthProvider");
  return c;
}
