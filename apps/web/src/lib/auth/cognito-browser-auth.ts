import { createCustomBrowserAuth } from "./custom-browser-auth";

/**
 * Lightweight facade for the Cognito browser authentication adapter.
 *
 * The actual `aws-amplify` configuration lives in
 * `cognito-browser-auth.runtime.ts` and is loaded **only** when a real
 * Cognito User Pool is being configured. Local development, unconfigured
 * Cognito, and invalid local-dev setups resolve synchronously through the
 * static fallback services below, which keep the `aws-amplify` graph out
 * of the initial client bundle entirely.
 *
 * `createCognitoBrowserAuth` is async so the facade can decide — at call
 * time, with the env vars in hand — whether to load the heavy runtime.
 * The auth provider calls this from a `useEffect`, so the synchronous
 * fallback service can be used as the initial state and replaced once
 * Cognito finishes loading.
 *
 * Tests mock `aws-amplify` and its subpaths at the module level. vitest
 * applies those mocks to the dynamic imports issued from here, so the
 * public contract under test is unchanged.
 */

export type AuthenticatedBrowserUser = {
  username: string;
};

export interface BrowserAuthService {
  readonly configured: boolean;
  readonly localDevelopment: boolean;
  readonly localDevelopmentConfigurationInvalid?: boolean;
  restoreSession(): Promise<AuthenticatedBrowserUser | null>;
  signIn(username: string, password: string, rememberMe?: boolean): Promise<AuthenticatedBrowserUser>;
  signOut(): Promise<void>;
  getAccessToken(): Promise<string | null>;
}

export class CognitoChallengeRequiredError extends Error {
  constructor(readonly step: string) {
    super(`Cognito requires an unsupported follow-up step: ${step}`);
    this.name = "CognitoChallengeRequiredError";
  }
}

function isPrivateIpv4Host(host: string): boolean {
  const octets = host.split(".");
  if (octets.length !== 4 || octets.some(octet => !/^(0|[1-9]\d{0,2})$/.test(octet))) return false;
  const values = octets.map(Number);
  if (values.some(value => value > 255)) return false;
  return values[0] === 10
    || (values[0] === 172 && values[1] >= 16 && values[1] <= 31)
    || (values[0] === 192 && values[1] === 168);
}

export function isAllowedLocalHttpApiBaseUrl(value: string, allowPrivateLan: boolean = false): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return parsed.protocol === "http:"
    && (host === "localhost" || host === "::1" || /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(host) || (allowPrivateLan && isPrivateIpv4Host(host)))
    && parsed.pathname === "/"
    && !parsed.search
    && !parsed.hash
    && !parsed.username
    && !parsed.password;
}

export function isLoopbackHttpApiBaseUrl(value: string): boolean {
  return isAllowedLocalHttpApiBaseUrl(value);
}

const unconfiguredAuthService: BrowserAuthService = {
  configured: false,
  localDevelopment: false,
  restoreSession: async () => null,
  signIn: async () => {
    throw new Error("Cognito browser authentication is not configured");
  },
  signOut: async () => undefined,
  getAccessToken: async () => null,
};

const localDevelopmentAuthService: BrowserAuthService = {
  configured: false,
  localDevelopment: true,
  restoreSession: async () => null,
  signIn: async () => {
    throw new Error("Cognito sign-in is disabled in local development auth mode");
  },
  signOut: async () => undefined,
  getAccessToken: async () => null,
};

const invalidLocalDevelopmentAuthService: BrowserAuthService = {
  configured: false,
  localDevelopment: false,
  localDevelopmentConfigurationInvalid: true,
  restoreSession: async () => null,
  signIn: async () => {
    throw new Error("Local development authentication requires a loopback API URL, or a private IPv4 API URL for custom-local LAN testing");
  },
  signOut: async () => undefined,
  getAccessToken: async () => null,
};

export function resolveSyncAuthFallback(): BrowserAuthService {
  const authMode = process.env.NEXT_PUBLIC_AUTH_MODE?.trim() || "cognito";
  if (authMode === "custom-local" && process.env.NODE_ENV !== "production") {
    if (!isAllowedLocalHttpApiBaseUrl(process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000", true)) {
      return invalidLocalDevelopmentAuthService;
    }
    return createCustomBrowserAuth();
  }
  if (authMode === "local-dev" && process.env.NODE_ENV !== "production") {
    if (!isAllowedLocalHttpApiBaseUrl(process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000")) {
      return invalidLocalDevelopmentAuthService;
    }
    return localDevelopmentAuthService;
  }
  return unconfiguredAuthService;
}

export async function createCognitoBrowserAuth(): Promise<BrowserAuthService> {
  const fallback = resolveSyncAuthFallback();
  if (fallback !== unconfiguredAuthService) return fallback;

  const userPoolId = process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID?.trim();
  const userPoolClientId = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID?.trim();

  if (!userPoolId || !userPoolClientId) return unconfiguredAuthService;

  // Defer the heavy runtime import to here. In local-dev mode the dynamic
  // import is never reached, so `aws-amplify` and its subpaths stay out of
  // the initial client bundle.
  const { createCognitoBrowserAuthRuntime } = await import("./cognito-browser-auth.runtime");
  return createCognitoBrowserAuthRuntime({ userPoolId, userPoolClientId });
}
