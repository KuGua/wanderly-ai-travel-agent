import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_WINDOW_MS = 5 * 60_000;

export interface SandboxVerifyOptions {
  windowMs?: number;
  /** Test seam: override the wall clock for deterministic expiry tests. */
  now?: () => number;
}

export type SandboxVerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing_header" | "expired" | "bad_signature" };

function pickHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

/**
 * Verifies an X-Sandbox-Signature + X-Sandbox-Timestamp pair against an HMAC
 * secret. The signed payload is `${timestamp}.${rawBody}` so a replay outside
 * the time window is rejected even if the body itself is unchanged.
 */
export function verifySandboxSignature(
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  secret: string,
  options: SandboxVerifyOptions = {},
): SandboxVerifyResult {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const now = (options.now ?? Date.now)();
  const signature = pickHeader(headers, "x-sandbox-signature");
  const timestamp = pickHeader(headers, "x-sandbox-timestamp");

  if (!signature || !timestamp) {
    return { ok: false, reason: "missing_header" };
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: "missing_header" };
  }
  if (Math.abs(now - ts) > windowMs) {
    return { ok: false, reason: "expired" };
  }

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  let received: Buffer;
  try {
    received = Buffer.from(signature, "hex");
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  return { ok: true };
}

/** Test helper — build the canonical signature string for a given payload. */
export function __buildSandboxSignature(secret: string, timestamp: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}