"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { clearViewerScopedStorage } from "./viewer-scoped-storage";

import {
  CognitoChallengeRequiredError,
  resolveSyncAuthFallback,
  type AuthenticatedBrowserUser,
  type BrowserAuthService,
} from "./cognito-browser-auth";

type AuthStatus = "CHECKING" | "LOCAL_DEV" | "LOCAL_DEV_INVALID" | "UNCONFIGURED" | "SIGNED_OUT" | "SIGNED_IN";
type AuthError = "SIGN_IN_FAILED" | "CHALLENGE_REQUIRED" | "SIGN_OUT_FAILED" | null;

type AuthContextValue = {
  status: AuthStatus;
  user: AuthenticatedBrowserUser | null;
  error: AuthError;
  busy: boolean;
  sessionRevision: number;
  getAccessToken: () => Promise<string | null>;
  signIn: (username: string, password: string, rememberMe?: boolean) => Promise<boolean>;
  signOut: () => Promise<boolean>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export { AuthContext };

export function AuthProvider({ children, service: suppliedService }: {
  children: ReactNode;
  service?: BrowserAuthService;
}) {
  // Initial state comes from the sync fallback service. In local-dev /
  // unconfigured / supplied-service modes this is the final service — no
  // async work, no `aws-amplify` load. In Cognito mode the fallback is
  // `unconfiguredAuthService` and the real service is loaded below.
  const [service, setService] = useState<BrowserAuthService>(
    () => suppliedService ?? resolveSyncAuthFallback(),
  );
  const [status, setStatus] = useState<AuthStatus>(
    service.localDevelopment ? "LOCAL_DEV" : service.localDevelopmentConfigurationInvalid ? "LOCAL_DEV_INVALID" : service.configured ? "CHECKING" : "UNCONFIGURED",
  );
  const [user, setUser] = useState<AuthenticatedBrowserUser | null>(null);
  const [error, setError] = useState<AuthError>(null);
  const [busy, setBusy] = useState(false);
  const [sessionRevision, setSessionRevision] = useState(0);

  useEffect(() => {
    if (suppliedService) return;
    let active = true;
    void (async () => {
      // Dynamic import keeps `cognito-browser-auth.runtime.ts` — and
      // therefore all of `aws-amplify` — out of the initial bundle. Only
      // this `useEffect` ever triggers the load.
      const { createCognitoBrowserAuth } = await import("./cognito-browser-auth");
      const next = await createCognitoBrowserAuth();
      if (!active) return;
      setService(next);
      setStatus(
        next.localDevelopment
          ? "LOCAL_DEV"
          : next.localDevelopmentConfigurationInvalid
            ? "LOCAL_DEV_INVALID"
            : next.configured
              ? "CHECKING"
              : "UNCONFIGURED",
      );
    })();
    return () => { active = false; };
  }, [suppliedService]);

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

  const handleSignIn = useCallback(async (username: string, password: string, rememberMe = false) => {
    setBusy(true);
    setError(null);
    try {
      const authenticatedUser = await service.signIn(username, password, rememberMe);
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
      // The query cache goes with `sessionRevision` below; these pointers live
      // outside it and carry no user in their key, so they have to be dropped
      // explicitly or the next traveller inherits them.
      clearViewerScopedStorage();
      setUser(null);
      setStatus(service.localDevelopment ? "LOCAL_DEV" : service.localDevelopmentConfigurationInvalid ? "LOCAL_DEV_INVALID" : service.configured ? "SIGNED_OUT" : "UNCONFIGURED");
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

/**
 * Optional variant that returns null instead of throwing when no
 * AuthProvider is mounted in the tree. Used by isolated providers (such
 * as ExplorationSessionProvider) that must work both inside the full app
 * shell and inside leaner test harnesses.
 */
export function useOptionalAuth() {
  return useContext(AuthContext);
}

export function createLocalDevBrowserAuth(): BrowserAuthService {
  return resolveSyncAuthFallback();
}