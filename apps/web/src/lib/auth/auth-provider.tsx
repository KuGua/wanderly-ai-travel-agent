"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

import {
  CognitoChallengeRequiredError,
  createCognitoBrowserAuth,
  type AuthenticatedBrowserUser,
  type BrowserAuthService,
} from "./cognito-browser-auth";

type AuthStatus = "CHECKING" | "UNCONFIGURED" | "SIGNED_OUT" | "SIGNED_IN";
type AuthError = "SIGN_IN_FAILED" | "CHALLENGE_REQUIRED" | "SIGN_OUT_FAILED" | null;

type AuthContextValue = {
  status: AuthStatus;
  user: AuthenticatedBrowserUser | null;
  error: AuthError;
  busy: boolean;
  sessionRevision: number;
  getAccessToken: () => Promise<string | null>;
  signIn: (username: string, password: string) => Promise<boolean>;
  signOut: () => Promise<boolean>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children, service: suppliedService }: {
  children: ReactNode;
  service?: BrowserAuthService;
}) {
  const [service] = useState(() => suppliedService ?? createCognitoBrowserAuth());
  const [status, setStatus] = useState<AuthStatus>(service.configured ? "CHECKING" : "UNCONFIGURED");
  const [user, setUser] = useState<AuthenticatedBrowserUser | null>(null);
  const [error, setError] = useState<AuthError>(null);
  const [busy, setBusy] = useState(false);
  const [sessionRevision, setSessionRevision] = useState(0);

  useEffect(() => {
    if (!service.configured) return;
    let active = true;
    void service.restoreSession().then((restored) => {
      if (!active) return;
      setUser(restored);
      setStatus(restored ? "SIGNED_IN" : "SIGNED_OUT");
      setSessionRevision((current) => current + 1);
    });
    return () => { active = false; };
  }, [service]);

  const getAccessToken = useCallback(() => service.getAccessToken(), [service]);

  const handleSignIn = useCallback(async (username: string, password: string) => {
    setBusy(true);
    setError(null);
    try {
      const authenticatedUser = await service.signIn(username, password);
      setUser(authenticatedUser);
      setStatus("SIGNED_IN");
      setSessionRevision((current) => current + 1);
      return true;
    } catch (cause) {
      setError(cause instanceof CognitoChallengeRequiredError ? "CHALLENGE_REQUIRED" : "SIGN_IN_FAILED");
      return false;
    } finally {
      setBusy(false);
    }
  }, [service]);

  const handleSignOut = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await service.signOut();
      setUser(null);
      setStatus(service.configured ? "SIGNED_OUT" : "UNCONFIGURED");
      setSessionRevision((current) => current + 1);
      return true;
    } catch {
      setError("SIGN_OUT_FAILED");
      return false;
    } finally {
      setBusy(false);
    }
  }, [service]);

  return (
    <AuthContext.Provider value={{
      status,
      user,
      error,
      busy,
      sessionRevision,
      getAccessToken,
      signIn: handleSignIn,
      signOut: handleSignOut,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error("useAuth must be used within AuthProvider");
  return auth;
}
