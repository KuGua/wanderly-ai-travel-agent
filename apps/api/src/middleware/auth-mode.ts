export type AuthMode = "cognito" | "local-dev" | "custom-local";

export const LOCAL_DEV_EXTERNAL_ID = "local-dev:default-traveler";
export const LOCAL_DEV_DISPLAY_NAME = "Local Developer";
const LOCAL_DEV_NODE_ENVS = new Set(["development", "test"]);

export function resolveAuthMode(value: string | undefined = process.env.AUTH_MODE): AuthMode {
  const mode = value?.trim() || "cognito";
  if (mode === "cognito" || mode === "local-dev" || mode === "custom-local") return mode;
  throw new Error(`Unsupported AUTH_MODE: ${mode}`);
}

export function assertAuthModeEnvironment(mode: AuthMode, nodeEnv: string | undefined = process.env.NODE_ENV) {
  if ((mode === "local-dev" || mode === "custom-local") && !LOCAL_DEV_NODE_ENVS.has(nodeEnv ?? "")) {
    throw new Error(`AUTH_MODE=${mode} requires NODE_ENV to be development or test`);
  }
}

export function assertLocalDevServerHost(
  mode: AuthMode,
  host: string,
  allowContainerHost: boolean = process.env.LOCAL_DEV_CONTAINER === "true",
) {
  const isLocalMode = mode === "local-dev" || mode === "custom-local";
  // A Docker container must listen on all of its own interfaces for a
  // loopback-only host port mapping to reach it. This is safe only when the
  // Compose configuration binds the published port to 127.0.0.1; the explicit
  // flag keeps the exception unavailable to ordinary local processes.
  const isAllowedContainerHost = allowContainerHost && host === "0.0.0.0";
  // `custom-local` may serve every interface at once. Binding one private
  // address already exposes the API to every device on that network, so this
  // adds loopback rather than reach — and binding *only* the LAN address
  // silently breaks every `localhost` URL, which is what a developer
  // actually types. Deliberately not extended to `local-dev`: that mode
  // authenticates a fixed user with no password, so its binding stays
  // loopback-only. `custom-local` still requires a bcrypt password and a
  // signed JWT, and `assertAuthModeEnvironment` still confines it to
  // development/test.
  const isAllowedCustomLocalHost = mode === "custom-local"
    && (host === "0.0.0.0" || isPrivateIpv4Address(host));
  if (isLocalMode && !isLoopbackHost(host) && !isAllowedContainerHost && !isAllowedCustomLocalHost) {
    throw new Error(`AUTH_MODE=${mode} requires HOST to be a loopback address, or 0.0.0.0 / a private IPv4 address for custom-local`);
  }
}

export function assertCustomLocalJwtSecret(
  mode: AuthMode,
  value: string | undefined = process.env.JWT_SECRET,
) {
  if (mode !== "custom-local") return;
  if (!value?.trim() || value.trim().length < 32) {
    throw new Error("AUTH_MODE=custom-local requires JWT_SECRET with at least 32 characters");
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

export function isPrivateIpv4Address(address: string): boolean {
  const octets = address.trim().split(".");
  if (octets.length !== 4 || octets.some(octet => !/^(0|[1-9]\d{0,2})$/.test(octet))) return false;
  const values = octets.map(Number);
  if (values.some(value => value > 255)) return false;
  return values[0] === 10
    || (values[0] === 172 && values[1] >= 16 && values[1] <= 31)
    || (values[0] === 192 && values[1] === 168);
}

/**
 * Parse the only browser origins that may access either local authentication mode.
 * `local-dev` is intentionally limited to loopback HTTP origins. `custom-local`
 * may additionally use an exact RFC1918 IPv4 origin for an explicitly local
 * LAN test; it still requires a password-backed API JWT and development/test.
 */
export function resolveLocalDevAllowedOrigins(
  value: string | undefined = process.env.LOCAL_DEV_ALLOWED_ORIGINS,
  mode: AuthMode = resolveAuthMode(),
): string[] {
  const configured = value?.split(",").map(origin => origin.trim()).filter(Boolean) ?? [];
  if (configured.length === 0) {
    throw new Error("Local authentication requires LOCAL_DEV_ALLOWED_ORIGINS");
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
      || !(isLoopbackHost(parsed.hostname) || (mode === "custom-local" && isPrivateIpv4Address(parsed.hostname)))
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
      || parsed.username
      || parsed.password
      || parsed.origin !== origin
    ) {
      throw new Error(`LOCAL_DEV_ALLOWED_ORIGINS must contain exact loopback HTTP origins, or private IPv4 HTTP origins for custom-local: ${origin}`);
    }
    return parsed.origin;
  });

  return [...new Set(origins)];
}

export function isAllowedLocalDevOrigin(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
  return typeof origin === "string" && allowedOrigins.includes(origin);
}
