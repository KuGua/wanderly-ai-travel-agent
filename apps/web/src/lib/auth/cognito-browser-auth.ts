import { Amplify } from "aws-amplify";
import { fetchAuthSession, getCurrentUser, signIn, signOut } from "aws-amplify/auth";

export type AuthenticatedBrowserUser = {
  username: string;
};

export interface BrowserAuthService {
  readonly configured: boolean;
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

const unconfiguredAuthService: BrowserAuthService = {
  configured: false,
  restoreSession: async () => null,
  signIn: async () => {
    throw new Error("Cognito browser authentication is not configured");
  },
  signOut: async () => undefined,
  getAccessToken: async () => null,
};
