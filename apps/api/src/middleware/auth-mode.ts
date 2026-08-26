export type AuthMode = "cognito" | "local-dev";

export const LOCAL_DEV_EXTERNAL_ID = "local-dev:default-traveler";
export const LOCAL_DEV_DISPLAY_NAME = "Local Developer";
const LOCAL_DEV_NODE_ENVS = new Set(["development", "test"]);

export function resolveAuthMode(value: string | undefined = process.env.AUTH_MODE): AuthMode {
  const mode = value?.trim() || "cognito";
  if (mode === "cognito" || mode === "local-dev") return mode;
  throw new Error(`Unsupported AUTH_MODE: ${mode}`);
}

export function assertAuthModeEnvironment(mode: AuthMode, nodeEnv: string | undefined = process.env.NODE_ENV) {
  if (mode === "local-dev" && !LOCAL_DEV_NODE_ENVS.has(nodeEnv ?? "")) {
    throw new Error("AUTH_MODE=local-dev requires NODE_ENV to be development or test");
  }
}

export function assertLocalDevServerHost(mode: AuthMode, host: string) {
  if (mode === "local-dev" && !isLoopbackHost(host)) {
    throw new Error("AUTH_MODE=local-dev requires HOST to be a loopback address");
  }
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().split("%", 1)[0];
  if (normalized === "::1") return true;
  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
  return /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(ipv4);
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || isLoopbackAddress(normalized);
}

/**
 * Parse the only browser origins that may access a fixed local-dev identity.
 * The value is intentionally limited to loopback HTTP origins: accepting a LAN
 * or public origin would let an unrelated site exercise the local identity.
 */
export function resolveLocalDevAllowedOrigins(value: string | undefined = process.env.LOCAL_DEV_ALLOWED_ORIGINS): string[] {
  const configured = value?.split(",").map(origin => origin.trim()).filter(Boolean) ?? [];
  if (configured.length === 0) {
    throw new Error("AUTH_MODE=local-dev requires LOCAL_DEV_ALLOWED_ORIGINS");
  }

  const origins = configured.map((origin) => {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`LOCAL_DEV_ALLOWED_ORIGINS contains an invalid origin: ${origin}`);
    }

    if (
      parsed.protocol !== "http:"
      || !isLoopbackHost(parsed.hostname)
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
      || parsed.username
      || parsed.password
      || parsed.origin !== origin
    ) {
      throw new Error(`LOCAL_DEV_ALLOWED_ORIGINS must contain exact loopback HTTP origins: ${origin}`);
    }
    return parsed.origin;
  });

  return [...new Set(origins)];
}

export function isAllowedLocalDevOrigin(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
  return typeof origin === "string" && allowedOrigins.includes(origin);
}
