import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { PropsWithChildren } from "react";
import type { AuthUser } from "../../shared/types";
import { AUTH_ERROR_EVENT, ApiError, api } from "./api";

type AuthContextValue = {
  user: AuthUser | null;
  loading: boolean;
  isAuthenticated: boolean;
  errorMessage: string | null;
  refresh: () => Promise<AuthUser | null>;
  signIn: (identifier: string, password: string) => Promise<AuthUser | null>;
  signUp: (email: string, password: string) => Promise<AuthUser | null>;
  signInAnonymous: () => Promise<AuthUser | null>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const isMountedRef = useRef(true);

  const invalidatePendingRequests = () => {
    requestIdRef.current += 1;
    return requestIdRef.current;
  };

  const syncUser = async (options?: { clearOnFailure?: boolean }) => {
    const requestId = invalidatePendingRequests();

    try {
      const response = await api.me();
      if (isMountedRef.current && requestIdRef.current === requestId) {
        setUser(response.user);
        setErrorMessage(null);
      }
      return response.user;
    } catch (error) {
      if (
        isMountedRef.current &&
        requestIdRef.current === requestId &&
        (options?.clearOnFailure || (error instanceof ApiError && error.status === 401))
      ) {
        setUser(null);
        setErrorMessage(error instanceof Error ? error.message : "Authentication failed.");
      }
      throw error;
    }
  };

  const refresh = async () => {
    return await syncUser();
  };

  useEffect(() => {
    const handleAuthError = () => {
      invalidatePendingRequests();
      if (isMountedRef.current) {
        setUser(null);
      }
    };

    if (typeof window !== "undefined") {
      window.addEventListener(AUTH_ERROR_EVENT, handleAuthError);
    }

    void syncUser({ clearOnFailure: true })
      .catch(() => {
        if (isMountedRef.current) {
          setUser(null);
        }
      })
      .finally(() => {
        if (isMountedRef.current) {
          setLoading(false);
        }
      });

    return () => {
      isMountedRef.current = false;
      invalidatePendingRequests();
      if (typeof window !== "undefined") {
        window.removeEventListener(AUTH_ERROR_EVENT, handleAuthError);
      }
    };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      isAuthenticated: Boolean(user),
      errorMessage,
      refresh,
      signIn: async (identifier, password) => {
        const requestId = invalidatePendingRequests();
        const response = await api.signIn(identifier, password);
        if (isMountedRef.current && requestIdRef.current === requestId) {
          setUser(response.user);
          setErrorMessage(null);
        }
        return response.user;
      },
      signUp: async (email, password) => {
        const requestId = invalidatePendingRequests();
        const response = await api.signUp(email, password);
        if (isMountedRef.current && requestIdRef.current === requestId) {
          setUser(response.user);
          setErrorMessage(null);
        }
        return response.user;
      },
      signInAnonymous: async () => {
        const requestId = invalidatePendingRequests();
        const response = await api.signInAnonymous();
        if (isMountedRef.current && requestIdRef.current === requestId) {
          setUser(response.user);
          setErrorMessage(null);
        }
        return response.user;
      },
      signOut: async () => {
        const requestId = invalidatePendingRequests();
        await api.signOut();
        if (isMountedRef.current && requestIdRef.current === requestId) {
          setUser(null);
        }
      },
    }),
    [errorMessage, loading, user]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider.");
  }
  return context;
}
