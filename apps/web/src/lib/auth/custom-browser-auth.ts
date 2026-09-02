import { resolveApiBaseUrl } from "@/lib/api";
import type { AuthenticatedBrowserUser, BrowserAuthService } from "./cognito-browser-auth";

const TOKEN_KEY = "wanderly_auth_token";
const USER_KEY = "wanderly_auth_user";
const REMEMBER_KEY = "wanderly_remember_me";

let rememberMe = false;

try {
  rememberMe = localStorage.getItem(REMEMBER_KEY) === "1";
} catch { /* SSR or storage unavailable */ }

function getStorage(): Storage {
  return rememberMe ? localStorage : sessionStorage;
}

function clearStoredSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(USER_KEY);
}

const getApiBaseUrl = resolveApiBaseUrl;

export function setRememberMe(value: boolean) {
  rememberMe = value;
  try {
    if (value) {
      localStorage.setItem(REMEMBER_KEY, "1");
    } else {
      localStorage.removeItem(REMEMBER_KEY);
    }
  } catch { /* storage unavailable */ }
}

export function createCustomBrowserAuth(): BrowserAuthService {
  return {
    configured: true,
    localDevelopment: false,

    async restoreSession(): Promise<AuthenticatedBrowserUser | null> {
      try {
        const token = localStorage.getItem(TOKEN_KEY) ?? sessionStorage.getItem(TOKEN_KEY);
        const userJson = localStorage.getItem(USER_KEY) ?? sessionStorage.getItem(USER_KEY);
        if (!token || !userJson) return null;

        const response = await fetch(`${getApiBaseUrl()}/api/v1/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!response.ok) {
          localStorage.removeItem(TOKEN_KEY);
          localStorage.removeItem(USER_KEY);
          sessionStorage.removeItem(TOKEN_KEY);
          sessionStorage.removeItem(USER_KEY);
          return null;
        }

        const data = (await response.json()) as { user: { username: string } };
        return { username: data.user.username };
      } catch {
        return null;
      }
    },

    async signIn(username: string, password: string, shouldRemember = false): Promise<AuthenticatedBrowserUser> {
      setRememberMe(shouldRemember);
      const response = await fetch(`${getApiBaseUrl()}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, rememberMe }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(error.message ?? "Login failed");
      }

      const data = (await response.json()) as {
        token: string;
        user: { id: string; username: string; email: string };
      };

      clearStoredSession();
      const storage = getStorage();
      storage.setItem(TOKEN_KEY, data.token);
      storage.setItem(USER_KEY, JSON.stringify(data.user));
      return { username: data.user.username };
    },

    async signOut(): Promise<void> {
      clearStoredSession();
    },

    async getAccessToken(): Promise<string | null> {
      return localStorage.getItem(TOKEN_KEY) ?? sessionStorage.getItem(TOKEN_KEY);
    },
  };
}

export async function checkEmailExists(email: string): Promise<boolean> {
  const response = await fetch(`${getApiBaseUrl()}/api/v1/auth/check-email?email=${encodeURIComponent(email)}`);
  if (!response.ok) return false;
  const data = (await response.json()) as { exists: boolean };
  return data.exists;
}

export async function registerUser(body: {
  username: string;
  email: string;
  password: string;
  confirmPassword: string;
}): Promise<{ token: string; user: { id: string; username: string; email: string } }> {
  const response = await fetch(`${getApiBaseUrl()}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(error.message ?? "Registration failed");
  }

  const data = (await response.json()) as {
    token: string;
    user: { id: string; username: string; email: string };
  };

  const storage = getStorage();
  storage.setItem(TOKEN_KEY, data.token);
  storage.setItem(USER_KEY, JSON.stringify(data.user));
  return data;
}

export type PasswordResetRequest = {
  mode: "direct" | "email-code";
  resetToken?: string;
  developmentCode?: string;
  retryAfterSeconds?: number;
};

export async function requestPasswordReset(email: string): Promise<PasswordResetRequest> {
  const response = await fetch(`${getApiBaseUrl()}/api/v1/auth/forgot-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(error.message ?? "Failed to start password reset");
  }

  return (await response.json()) as PasswordResetRequest;
}

export async function verifyResetCode(email: string, code: string): Promise<string> {
  const response = await fetch(`${getApiBaseUrl()}/api/v1/auth/verify-reset-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(error.message ?? "Invalid verification code");
  }

  const data = (await response.json()) as { resetToken: string };
  return data.resetToken;
}

export async function resetPassword(body: {
  email: string;
  resetToken: string;
  password: string;
  confirmPassword: string;
}): Promise<void> {
  const response = await fetch(`${getApiBaseUrl()}/api/v1/auth/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(error.message ?? "Failed to reset password");
  }
}
