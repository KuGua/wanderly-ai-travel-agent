/**
 * Location-reference source abstraction.
 *
 * Both the public `POST /api/v1/explore/location-reference` route and the
 * internal `resolveConversationPlace()` helper in `policy/conversation-safety.ts`
 * resolve coordinates through this interface. The selected implementation
 * depends on the `LOCATION_REFERENCE_MODE` environment variable; the default
 * (`in-process`) preserves the pre-refactor behaviour behavior of every test
 * and every production deploy with zero configuration change.
 *
 * See `SIDECAR.md` for the failure-mode matrix and the observability gap
 * note for the dev-only `sidecar` mode.
 */

import { locationReferenceResponseSchema } from "../types/schemas.js";
import type { LocationReference } from "./location-reference-resolver.js";
import { getLocationReferenceResolver } from "./location-reference-resolver.js";

export type LocationReferenceMode = "in-process" | "sidecar" | "disabled";

/**
 * Thrown when a configured source cannot produce a result (resolver throw,
 * sidecar HTTP 5xx, timeout, schema drift). Callers translate this to the
 * route-specific error contract (`503 LOCATION_REFERENCE_UNAVAILABLE` for
 * the public endpoint, `sourceType: "INSPIRATION"` for the internal caller).
 */
export class LocationReferenceSourceError extends Error {
  override readonly name = "LocationReferenceSourceError";
  constructor(
    readonly reason: "UNAVAILABLE" | "TIMEOUT" | "SCHEMA_DRIFT" | "NETWORK",
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

export interface LocationReferenceSource {
  /**
   * Resolve `(latitude, longitude)` to a `LocationReference`. Always async
   * because the sidecar implementation is HTTP and the disabled implementation
   * yields once to keep the contract uniform across modes.
   */
  resolve(
    latitude: number,
    longitude: number,
    options?: { signal?: AbortSignal },
  ): Promise<LocationReference>;
  /** Mode string used to select this implementation; surfaced for logging/tests. */
  readonly mode: LocationReferenceMode;
}

class InProcessLocationReferenceSource implements LocationReferenceSource {
  readonly mode = "in-process" as const;

  async resolve(latitude: number, longitude: number): Promise<LocationReference> {
    // `getLocationReferenceResolver` is lazy; the first call performs the
    // ~70 MB JSON parse. Wrapping in a microtask yields once so the contract
    // matches the sidecar/disabled implementations.
    return new Promise((resolvePromise, rejectPromise) => {
      setImmediate(() => {
        try {
          const result = getLocationReferenceResolver().resolve(latitude, longitude);
          resolvePromise(result);
        } catch (error) {
          rejectPromise(error);
        }
      });
    });
  }
}

class DisabledLocationReferenceSource implements LocationReferenceSource {
  readonly mode = "disabled" as const;

  async resolve(): Promise<LocationReference> {
    return Promise.resolve({
      outcome: "NO_REFERENCE",
      source: "Natural Earth + GeoNames",
      datasetVersion: "disabled",
      checkedAt: new Date(0).toISOString(),
      isTravelFact: false,
    });
  }
}

interface SidecarConfig {
  url: string;
  timeoutMs: number;
}

function resolveSidecarConfig(env: NodeJS.ProcessEnv): SidecarConfig | null {
  const url = env.LOCATION_REFERENCE_SIDECAR_URL?.trim();
  if (!url) return null;
  const rawTimeout = env.LOCATION_REFERENCE_SIDECAR_TIMEOUT_MS ?? "2000";
  const timeoutMs = Number.parseInt(rawTimeout, 10);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error(
      `LOCATION_REFERENCE_SIDECAR_TIMEOUT_MS must be an integer 1..30000, got ${rawTimeout}`,
    );
  }
  return { url, timeoutMs };
}

class SidecarLocationReferenceSource implements LocationReferenceSource {
  readonly mode = "sidecar" as const;

  constructor(private readonly config: SidecarConfig) {}

  async resolve(
    latitude: number,
    longitude: number,
    options?: { signal?: AbortSignal },
  ): Promise<LocationReference> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const externalSignal = options?.signal;
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    try {
      const response = await fetch(`${this.config.url.replace(/\/$/, "")}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ latitude, longitude }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new LocationReferenceSourceError(
          response.status >= 500 ? "UNAVAILABLE" : "SCHEMA_DRIFT",
          `Sidecar returned HTTP ${response.status}`,
        );
      }
      const body = await response.json();
      const parsed = locationReferenceResponseSchema.safeParse(body);
      if (!parsed.success) {
        throw new LocationReferenceSourceError(
          "SCHEMA_DRIFT",
          `Sidecar response failed schema validation: ${parsed.error.message}`,
          parsed.error,
        );
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof LocationReferenceSourceError) throw error;
      const aborted = (error as { name?: string }).name === "AbortError";
      throw new LocationReferenceSourceError(
        aborted ? "TIMEOUT" : "NETWORK",
        aborted
          ? `Sidecar timed out after ${this.config.timeoutMs}ms`
          : `Sidecar request failed: ${(error as Error).message}`,
        error,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function resolveModeFromEnv(env: NodeJS.ProcessEnv): LocationReferenceMode {
  const raw = env.LOCATION_REFERENCE_MODE?.trim();
  if (!raw) return "in-process";
  if (raw === "in-process" || raw === "sidecar" || raw === "disabled") return raw;
  throw new Error(
    `LOCATION_REFERENCE_MODE must be one of "in-process", "sidecar", "disabled", got ${JSON.stringify(raw)}`,
  );
}

let cachedSource: LocationReferenceSource | null = null;

export function getLocationReferenceSource(
  env: NodeJS.ProcessEnv = process.env,
): LocationReferenceSource {
  if (cachedSource) return cachedSource;
  const mode = resolveModeFromEnv(env);
  if (mode === "in-process") {
    cachedSource = new InProcessLocationReferenceSource();
  } else if (mode === "disabled") {
    cachedSource = new DisabledLocationReferenceSource();
  } else {
    const config = resolveSidecarConfig(env);
    if (!config) {
      throw new Error(
        "LOCATION_REFERENCE_MODE=sidecar requires LOCATION_REFERENCE_SIDECAR_URL to be set",
      );
    }
    cachedSource = new SidecarLocationReferenceSource(config);
  }
  return cachedSource;
}

export function __resetLocationReferenceSourceForTests(): void {
  cachedSource = null;
}