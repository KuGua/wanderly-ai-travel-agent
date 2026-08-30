/**
 * Distributed tracing bootstrap and shared helpers.
 *
 * This module is the single chokepoint for OpenTelemetry wiring in the API
 * and the Worker. Both processes call {@link initTracing} as their first
 * import, so the SDK starts before any instrumented module is required.
 *
 * Design constraints (see AGENTS.md and TECH_STACK.md):
 *  - No auto-instrumentations. Every span attribute is allow-listed to keep
 *    PII, credentials, and high-cardinality identifiers out of exporters.
 *  - Server keeps canonical ownership of the request id (`correlationId`).
 *    W3C `traceparent` is additive and lives alongside it.
 *  - In tests (`NODE_ENV=test`) the exporter is replaced by an in-memory
 *    collector that vitest drains at the end of each test.
 *  - In production the SDK is opt-in via `OTEL_EXPORTER_OTLP_ENDPOINT`; the
 *    default leaves spans in-process so an unset endpoint never costs the
 *    project anything.
 */

import {
  context,
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  propagation,
  Span as OtelSpan,
  SpanStatusCode,
  trace,
  Tracer,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { Resource } from "@opentelemetry/resources";
import {
  AlwaysOnSampler,
  BatchSpanProcessor,
  ConsoleSpanExporter,
  InMemorySpanExporter,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

/** OTel attribute keys that must never appear on a span. */
export const FORBIDDEN_SPAN_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  // authorization / credentials
  "authorization",
  "cookie",
  "password",
  "secret",
  "apiKey",
  "accessToken",
  "refreshToken",
  "x-api-key",
  "x-sandbox-signature",
  "set-cookie",
  "rawBody",
  // private profile fields (AGENTS.md / redaction list)
  "passportNumber",
  "documentNumber",
  "nationality",
  "dateOfBirth",
  "memberPreferences",
  // private chat / model content
  "privateConversation",
  "body",
  "message",
  "privateMessage",
  "redactedSummary",
  "prompt",
  "question",
  // high-cardinality identifiers (also forbidden as metric labels)
  "userId",
  "tripId",
  "planId",
  "bookingId",
  "conversationId",
  "threadId",
  "destination",
  "origin",
  "model",
  "timestamp",
  "name",
  "correlationId",
  "requestId",
  "orchestrationRequestId",
  "payload",
  // S4 location-introduction cache: identifiers, generated content and
  // coordinates must never appear on a span (PRD §5.11, AGENTS.md).
  "sourceId",
  "placeName",
  "canonicalPlaceId",
  "cacheKey",
  "content",
  "generatedContent",
  "latitude",
  "longitude",
  "coordinates",
]);

/** Header name carrying the W3C trace context. */
export const TRACEPARENT_HEADER = "traceparent";
export const TRACESTATE_HEADER = "tracestate";

const TRACEPARENT_REGEX = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-.*)?$/i;
const HEX_32 = /^[0-9a-f]{32}$/;
const HEX_16 = /^[0-9a-f]{16}$/;
const ALL_ZERO_TRACE = "00000000000000000000000000000000";
const ALL_ZERO_SPAN = "0000000000000000";

/**
 * Parse a W3C `traceparent` header. Returns `null` for malformed, all-zero, or
 * missing input — never throws, because the header is advisory.
 */
export function parseTraceparent(
  value: string | null | undefined,
): { traceId: string; spanId: string; flags: string } | null {
  if (!value || typeof value !== "string") return null;
  const match = TRACEPARENT_REGEX.exec(value.trim());
  if (!match) return null;
  const [, version, traceId, spanId, flags] = match;
  if (version !== "00") return null;
  if (traceId === ALL_ZERO_TRACE || spanId === ALL_ZERO_SPAN) return null;
  return { traceId, spanId, flags };
}

/** Build a W3C `traceparent` header value. Validates both ids. */
export function formatTraceparent(
  traceId: string,
  spanId: string,
  flags: string = "01",
): string {
  if (!HEX_32.test(traceId)) {
    throw new Error(`formatTraceparent: invalid traceId (${traceId})`);
  }
  if (!HEX_16.test(spanId)) {
    throw new Error(`formatTraceparent: invalid spanId (${spanId})`);
  }
  if (!/^[0-9a-f]{2}$/i.test(flags)) {
    throw new Error(`formatTraceparent: invalid flags (${flags})`);
  }
  return `00-${traceId}-${spanId}-${flags}`;
}

/** Read a hex character sequence into a fresh Uint8Array. */
function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  // Node 20+ exposes crypto.randomFillSync on globalThis; fall back to the
  // platform webcrypto when running under unusual runtimes.
  const g = globalThis as { crypto?: { randomFillSync?: (buf: Uint8Array) => Uint8Array } };
  if (g.crypto?.randomFillSync) {
    g.crypto.randomFillSync(bytes);
  } else {
    for (let i = 0; i < byteLength; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = "";
  for (let i = 0; i < byteLength; i += 1) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/** Generate a fresh trace id (32 hex chars). */
export function newTraceId(): string {
  return randomHex(16);
}

/** Generate a fresh span id (16 hex chars). */
export function newSpanId(): string {
  return randomHex(8);
}

/**
 * Set an attribute on a span only after confirming the key is allow-listed.
 * Throws when forbidden — production callers should use {@link safeSetAttribute}
 * with the awareness that the policy is enforced strictly.
 */
export function safeSetAttribute(
  span: OtelSpan | undefined,
  key: string,
  value: string | number | boolean,
): void {
  if (!span) return;
  if (FORBIDDEN_SPAN_ATTRIBUTE_KEYS.has(key)) {
    throw new Error(
      `safeSetAttribute: forbidden span attribute key "${key}" (see FORBIDDEN_SPAN_ATTRIBUTE_KEYS)`,
    );
  }
  span.setAttribute(key, value);
}

/**
 * Strict variant that returns a boolean instead of throwing. Useful for
 * derived-attribute code paths where a forbidden key should be silently
 * dropped rather than aborting the surrounding span.
 */
export function trySetAttribute(
  span: OtelSpan | undefined,
  key: string,
  value: string | number | boolean,
): boolean {
  try {
    safeSetAttribute(span, key, value);
    return true;
  } catch {
    return false;
  }
}

/** Record an error on the active span if one is present. */
export function recordSpanError(error: unknown): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  const err = error instanceof Error ? error : new Error(String(error));
  span.recordException(err);
  span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
}

type ExporterMode = "in-memory" | "console" | "otlp-http" | "otlp-proto" | "none";

let initPromise: Promise<void> | null = null;
let inMemoryExporter: InMemorySpanExporter | null = null;
let registeredProvider: NodeTracerProvider | null = null;
let propagatorRegistered = false;
let diagConfigured = false;
let serviceName = "ai-travel-agent-api";
let serviceVersion = "0.1.0";

function resolveExporterMode(): ExporterMode {
  if (process.env.OTEL_SDK_DISABLED === "true") return "none";
  const explicit = process.env.OTEL_TRACES_EXPORTER;
  if (explicit === "console") return "console";
  if (explicit === "otlp") return resolveOtlpVariant();
  if (explicit === "none" || explicit === "noop" || explicit === "") return "none";
  if (explicit && explicit !== "in-memory") {
    diag.warn(`tracing: unknown OTEL_TRACES_EXPORTER="${explicit}", defaulting to env-driven choice`);
  }
  if (process.env.NODE_ENV === "test") return "in-memory";
  if (process.env.NODE_ENV !== "production") return "console";
  return resolveOtlpVariant();
}

/**
 * Test-only export so unit tests can assert env-driven exporter selection
 * without exercising the lazy OTLP exporter module load. Production code
 * must call {@link initTracing} (which uses the same logic internally).
 */
export function resolveExporterModeForTests(): ExporterMode {
  return resolveExporterMode();
}

function resolveOtlpVariant(): ExporterMode {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return "none";
  const protocol = process.env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "http/protobuf";
  if (protocol === "http/protobuf") return "otlp-proto";
  if (protocol === "grpc") {
    diag.warn("tracing: grpc OTLP exporter is not bundled; falling back to otlp-http");
    return "otlp-http";
  }
  return "otlp-http";
}

function resolveSampler() {
  const ratioEnv = process.env.OTEL_TRACES_SAMPLER_ARG;
  const ratio = ratioEnv ? Number(ratioEnv) : Number.NaN;
  if (process.env.NODE_ENV !== "production") {
    return new ParentBasedSampler({ root: new AlwaysOnSampler() });
  }
  if (Number.isFinite(ratio) && ratio >= 0 && ratio <= 1) {
    return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) });
  }
  return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(0.05) });
}

/**
 * Idempotent. Safe to call from both `server.ts` and `worker-main.ts`. Reads
 * environment to pick exporter / sampler; registers the global propagator and
 * a no-op-safe provider. Subsequent calls reuse the first one.
 */
export function initTracing(
  overrides: { serviceName?: string; serviceVersion?: string } = {},
): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (overrides.serviceName) serviceName = overrides.serviceName;
    if (overrides.serviceVersion) serviceVersion = overrides.serviceVersion;

    const level = (process.env.OTEL_LOG_LEVEL ?? "warn").toLowerCase();
    const diagLevel: DiagLogLevel =
      level === "debug" ? DiagLogLevel.DEBUG
      : level === "info" ? DiagLogLevel.INFO
      : level === "error" ? DiagLogLevel.ERROR
      : DiagLogLevel.WARN;
    if (!diagConfigured) {
      diag.setLogger(new DiagConsoleLogger(), diagLevel);
      diagConfigured = true;
    }

    const mode = resolveExporterMode();
    if (mode === "none") {
      // With no SDK provider, install the propagator ourselves so inbound
      // traceparent headers remain readable. An SDK provider registers its own
      // propagator; registering twice causes OpenTelemetry to reject it.
      if (!propagatorRegistered) {
        propagation.setGlobalPropagator(new W3CTraceContextPropagator());
        propagatorRegistered = true;
      }
      diag.info(
        `tracing: SDK disabled (exporter=none, OTEL_SDK_DISABLED=${process.env.OTEL_SDK_DISABLED ?? "unset"})`,
      );
      return;
    }

    // This process owns its OpenTelemetry SDK. A dev runner or a prior test
    // module can leave a global propagator behind; clear it before the SDK
    // installs its own so provider registration cannot be rejected as a
    // duplicate global registration.
    propagation.disable();
    propagatorRegistered = false;

    const resource = new Resource({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: serviceVersion,
      "deployment.environment": process.env.NODE_ENV ?? "development",
    });

    const provider = new NodeTracerProvider({
      resource,
      sampler: resolveSampler(),
    });

    if (mode === "in-memory") {
      inMemoryExporter = new InMemorySpanExporter();
      provider.addSpanProcessor(new SimpleSpanProcessor(inMemoryExporter));
    } else if (mode === "console") {
      provider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()));
    } else if (mode === "otlp-http" || mode === "otlp-proto") {
      // Lazy require to keep the OTLP exporters out of the cold path when
      // they're never configured.
      const exporterModule = await (mode === "otlp-http"
        ? import("@opentelemetry/exporter-trace-otlp-http")
        : import("@opentelemetry/exporter-trace-otlp-proto"));
      const ExporterCtor = (exporterModule as { OTLPTraceExporter: new () => unknown })
        .OTLPTraceExporter;
      const exporter = new ExporterCtor() as ConstructorParameters<typeof BatchSpanProcessor>[0];
      provider.addSpanProcessor(new BatchSpanProcessor(exporter));
    }

    provider.register();
    propagatorRegistered = true;
    registeredProvider = provider;
    diag.info(`tracing: initialized (exporter=${mode}, service=${serviceName})`);
  })();
  return initPromise;
}

/**
 * Flush and shut down the provider. Safe to call when init never ran.
 */
export async function shutdownTracing(): Promise<void> {
  if (!initPromise) return;
  await initPromise;
  if (!registeredProvider) return;
  await registeredProvider.shutdown();
  registeredProvider = null;
}

/**
 * Returns the in-memory exporter for tests. `null` in non-test environments.
 */
export function getInMemoryExporter(): InMemorySpanExporter | null {
  return inMemoryExporter;
}

/**
 * Drain all spans the in-memory exporter has captured so far. Convenience
 * helper for tests that don't want to dig through the SDK internals.
 */
export function drainInMemorySpans(): ReadableSpan[] {
  if (!inMemoryExporter) return [];
  return inMemoryExporter.getFinishedSpans();
}

/**
 * Reset module-level state. Intended for test isolation only — production
 * callers should rely on the idempotent nature of {@link initTracing}.
 */
export function _resetTracingForTests(): void {
  initPromise = null;
  inMemoryExporter = null;
  registeredProvider = null;
  propagatorRegistered = false;
  diagConfigured = false;
  // Reset the global OTel state so the next init can install a fresh provider.
  // Only valid in test contexts where serial execution is guaranteed.
  try {
    trace.disable();
    context.disable();
    propagation.disable();
  } catch {
    // best-effort; tests will surface real failures separately
  }
}

/**
 * Get a tracer using the configured service name/version. Safe to call
 * before {@link initTracing}; returns a no-op tracer in that case.
 */
export function getTracer(name = "ai-travel-agent-api"): Tracer {
  return trace.getTracer(name, serviceVersion);
}

/**
 * Re-export the OTel context API so callers can grab it without depending on
 * `@opentelemetry/api` directly. This keeps imports tidy across the codebase.
 */
export const otelContext = context;

/** Re-export the active span accessor for ergonomics. */
export function getActiveSpan(): OtelSpan | undefined {
  return trace.getActiveSpan();
}
