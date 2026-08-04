import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { api, ApiError, setUnauthorizedHandler } from "../api/client";
import type { Me } from "../api/types";

export type AuthState =
  | { status: "loading" }
  | { status: "unauthenticated"; sessionExpired: boolean }
  | { status: "error"; message: string }
  | { status: "authenticated"; user: Me };

interface AuthContextValue {
  state: AuthState;
  /** POST /api/me/acknowledge-banner, then unblock the shell (A.5.10). */
  acknowledgeBanner: () => Promise<void>;
  /** POST /api/auth/logout (CSRF header attached), then hard reload. */
  signOut: () => Promise<void>;
  /** Re-probe GET /api/me (used by the error screen's Retry). */
  reload: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const user = await api<Me>("/api/me", { on401: "silent" });
      setState({ status: "authenticated", user });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setState({ status: "unauthenticated", sessionExpired: false });
      } else {
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Unexpected error",
        });
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Session expiry (A.8.5): any notifying 401 from the API after login
  // returns the user to the login page with a "session expired" message.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setState({ status: "unauthenticated", sessionExpired: true });
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const acknowledgeBanner = useCallback(async () => {
    await api<void>("/api/me/acknowledge-banner", { method: "POST" });
    setState((previous) =>
      previous.status === "authenticated"
        ? { ...previous, user: { ...previous.user, bannerAcknowledged: true } }
        : previous,
    );
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api<void>("/api/auth/logout", { method: "POST", on401: "silent" });
    } catch {
      // Session may already be gone server-side; reload regardless.
    } finally {
      window.location.reload();
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ state, acknowledgeBanner, signOut, reload: () => void load() }),
    [state, acknowledgeBanner, signOut, load],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
