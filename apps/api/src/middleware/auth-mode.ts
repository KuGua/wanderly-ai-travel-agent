export type AuthMode = "cognito" | "local-dev";

export const LOCAL_DEV_EXTERNAL_ID = "local-dev:default-traveler";
export const LOCAL_DEV_DISPLAY_NAME = "Local Developer";

export function resolveAuthMode(value: string | undefined = process.env.AUTH_MODE): AuthMode {
  const mode = value?.trim() || "cognito";
  if (mode === "cognito" || mode === "local-dev") return mode;
  throw new Error(`Unsupported AUTH_MODE: ${mode}`);
}

export function assertAuthModeEnvironment(mode: AuthMode, nodeEnv: string | undefined = process.env.NODE_ENV) {
  if (mode === "local-dev" && nodeEnv === "production") {
    throw new Error("AUTH_MODE=local-dev is forbidden when NODE_ENV=production");
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
  return /^127(?:\.\d{1,3}){3}$/.test(ipv4);
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || isLoopbackAddress(normalized);
}
