import type { AuthenticatedBrowserUser, BrowserAuthService } from "./cognito-browser-auth";

const TOKEN_KEY = "wanderly_auth_token";
const USER_KEY = "wanderly_auth_user";

function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:3000";
}

export function createCustomBrowserAuth(): BrowserAuthService {
  return {
    configured: true,
    localDevelopment: false,

    async restoreSession(): Promise<AuthenticatedBrowserUser | null> {
      try {
        const token = localStorage.getItem(TOKEN_KEY);
        const userJson = localStorage.getItem(USER_KEY);
        if (!token || !userJson) return null;

        const response = await fetch(`${getApiBaseUrl()}/api/v1/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!response.ok) {
          localStorage.removeItem(TOKEN_KEY);
          localStorage.removeItem(USER_KEY);
          return null;
        }

        const data = (await response.json()) as { user: { username: string } };
        return { username: data.user.username };
      } catch {
        return null;
      }
    },

    async signIn(identifier: string, password: string): Promise<AuthenticatedBrowserUser> {
      const response = await fetch(`${getApiBaseUrl()}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(error.message ?? "Login failed");
      }

      const data = (await response.json()) as {
        token: string;
        user: { id: string; username: string; email: string };
      };

      localStorage.setItem(TOKEN_KEY, data.token);
      localStorage.setItem(USER_KEY, JSON.stringify(data.user));
      return { username: data.user.username };
    },

    async signOut(): Promise<void> {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    },

    async getAccessToken(): Promise<string | null> {
      return localStorage.getItem(TOKEN_KEY);
    },
  };
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

  localStorage.setItem(TOKEN_KEY, data.token);
  localStorage.setItem(USER_KEY, JSON.stringify(data.user));
  return data;
}
