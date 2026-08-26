import { Amplify } from "aws-amplify";
import { fetchAuthSession, getCurrentUser, signIn, signOut } from "aws-amplify/auth";

export type AuthenticatedBrowserUser = {
  username: string;
};

export interface BrowserAuthService {
  readonly configured: boolean;
  readonly localDevelopment: boolean;
  readonly localDevelopmentConfigurationInvalid?: boolean;
  restoreSession(): Promise<AuthenticatedBrowserUser | null>;
  signIn(username: string, password: string): Promise<AuthenticatedBrowserUser>;
  signOut(): Promise<void>;
  getAccessToken(): Promise<string | null>;
}

export class CognitoChallengeRequiredError extends Error {
  constructor(readonly step: string) {
    super(`Cognito requires an unsupported follow-up step: ${step}`);
    this.name = "CognitoChallengeRequiredError";
  }
}

export function createCognitoBrowserAuth(): BrowserAuthService {
  const authMode = process.env.NEXT_PUBLIC_AUTH_MODE?.trim() || "cognito";
  if (authMode === "local-dev" && process.env.NODE_ENV !== "production") {
    if (!isLoopbackHttpApiBaseUrl(process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000")) {
      return invalidLocalDevelopmentAuthService;
    }
    return localDevelopmentAuthService;
  }

  const userPoolId = process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID?.trim();
  const userPoolClientId = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID?.trim();

  if (!userPoolId || !userPoolClientId) return unconfiguredAuthService;

  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId,
        userPoolClientId,
        loginWith: { email: true, phone: true, username: true },
      },
    },
  });

  return {
    configured: true,
    localDevelopment: false,
    async restoreSession() {
      try {
        const user = await getCurrentUser();
        return { username: user.username };
      } catch {
        return null;
      }
    },
    async signIn(username, password) {
      const result = await signIn({ username, password });
      if (!result.isSignedIn) {
        throw new CognitoChallengeRequiredError(result.nextStep.signInStep);
      }
      const user = await getCurrentUser();
      return { username: user.username };
    },
    async signOut() {
      await signOut();
    },
    async getAccessToken() {
      const session = await fetchAuthSession();
      return session.tokens?.accessToken.toString() ?? null;
    },
  };
}

export function isLoopbackHttpApiBaseUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return parsed.protocol === "http:"
    && (host === "localhost" || host === "::1" || /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(host))
    && parsed.pathname === "/"
    && !parsed.search
    && !parsed.hash
    && !parsed.username
    && !parsed.password;
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
    throw new Error("Local development authentication requires a loopback NEXT_PUBLIC_API_BASE_URL");
  },
  signOut: async () => undefined,
  getAccessToken: async () => null,
};
