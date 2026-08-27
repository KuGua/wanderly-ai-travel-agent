/**
 * Runtime for the Cognito browser authentication adapter.
 *
 * This module is the only place that statically imports `aws-amplify` and
 * its subpaths. The companion facade `cognito-browser-auth.ts` calls into
 * here via a dynamic `import()` so the entire `aws-amplify` graph is kept
 * out of the initial client bundle and only loads when a Cognito-mode
 * `AuthProvider` actually needs to configure a real User Pool.
 *
 * Tests mock `aws-amplify` and its subpaths at the module level; vitest
 * applies those mocks to the dynamic imports issued from the facade, so
 * the contract under test is unchanged.
 */

import { Amplify } from "aws-amplify";
import { fetchAuthSession, getCurrentUser, signIn, signOut } from "aws-amplify/auth";
import { cognitoUserPoolsTokenProvider } from "aws-amplify/auth/cognito";
import { defaultStorage, sessionStorage } from "aws-amplify/utils";

import { CognitoChallengeRequiredError, type BrowserAuthService } from "./cognito-browser-auth";

export interface CognitoRuntimeConfig {
  userPoolId: string;
  userPoolClientId: string;
}

export function createCognitoBrowserAuthRuntime(config: CognitoRuntimeConfig): BrowserAuthService {
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: config.userPoolId,
        userPoolClientId: config.userPoolClientId,
        loginWith: { username: true },
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
    async signIn(username, password, rememberMe = false) {
      cognitoUserPoolsTokenProvider.setKeyValueStorage(rememberMe ? defaultStorage : sessionStorage);
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