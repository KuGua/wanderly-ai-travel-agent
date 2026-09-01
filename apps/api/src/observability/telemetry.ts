import path from "node:path";
import { appendFile, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { Writable } from "node:stream";
import pino from "pino";
import type { Context, Span } from "@opentelemetry/api";
import type { RequestContext } from "../utils/context.js";
import { getActiveSpan } from "./tracing.js";

export const LOGGER_REDACT_PATHS = [
  // Invitation tokens are part of an external URL and act as credentials.
  "req.url",
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-api-key']",
  "req.headers['x-sandbox-signature']",
  "req.body.password",
  "req.body.secret",
  "req.body.apiKey",
  "req.body.accessToken",
  "req.body.refreshToken",
  "req.body.passportNumber",
  "req.body.documentNumber",
  "req.body.nationality",
  "req.body.dateOfBirth",
  "req.body.prompt",
  "req.body.question",
  "req.body.privateConversation",
  "req.body.memberPreferences",
  "req.body.*.passportNumber",
  "req.body.*.documentNumber",
  "req.body.*.nationality",
  "req.body.*.dateOfBirth",
  "res.headers['set-cookie']",
  "res.body.passportNumber",
  "res.body.documentNumber",
  "res.body.nationality",
  "res.body.dateOfBirth",
  "res.body.violations",
  "err.config.headers.authorization",
  "err.config.headers['x-api-key']",
  "err.request.headers.authorization",
  "err.request.headers['x-sandbox-signature']",
  "err.response.data",
  "req.body.*.body",
  "req.body.*.message",
  "req.body.*.privateMessage",
  "res.body.*.body",
  "res.body.userMessage.content",
  "res.body.assistantMessage.content",
  "res.body.messages.*.content",
] as const;

export const LOGGER_REDACTION = {
  paths: [...LOGGER_REDACT_PATHS],
  censor: "[REDACTED]",
};

/**
 * Optional local NDJSON sink for safe runtime diagnostics. The file name is
 * deliberately constrained to the local `runtime/` directory so an env typo
 * cannot turn logging into an arbitrary filesystem write. It receives the
 * same Pino-redacted records as stdout and is intentionally independent from
 * OpenTelemetry export availability.
 */
const LOCAL_DEBUG_LOG_RETENTION_DAYS = 7;
const LOCAL_DEBUG_LOG_TIME_ZONE = process.env.LOCAL_LOG_TIMEZONE ?? "UTC";

export type LocalLogDescriptor = {
  directory: string;
  prefix: string;
  timeZone: string;
};

function localLogPrefix(value: string): string {
  if (value === "auto") {
    const entrypoint = process.argv.slice(1).join("/").toLowerCase();
    return entrypoint.includes("worker-main")
      ? "worker"
      : entrypoint.includes("sidecar-main")
        ? "location-reference"
        : "api";
  }
  return path.basename(value, ".ndjson").replace(/-runtime$/u, "");
}

function localDateParts(date: Date, timeZone: string): Record<string, string> {
  try {
    return Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(date)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
  } catch {
    throw new Error("LOCAL_LOG_TIMEZONE must be a valid IANA time zone");
  }
}

/** Format the configured local calendar day as a stable file-name segment. */
export function localDebugLogDate(date = new Date(), timeZone = LOCAL_DEBUG_LOG_TIME_ZONE): string {
  const parts = localDateParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dateDaysBefore(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

function resolveLocalLogDescriptor(value = process.env.LOCAL_DEBUG_LOG_FILE): LocalLogDescriptor | null {
  if (!value) return null;
  if (value !== "auto" && (path.isAbsolute(value) || value.includes("..") || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.ndjson$/.test(value))) {
    throw new Error('LOCAL_DEBUG_LOG_FILE must be "auto" or a simple .ndjson filename');
  }
  return {
    directory: path.join(process.cwd(), "runtime"),
    prefix: localLogPrefix(value),
    timeZone: LOCAL_DEBUG_LOG_TIME_ZONE,
  };
}

/** Resolve today's rotated NDJSON destination without creating a file. */
export function resolveLocalDebugLogPath(value = process.env.LOCAL_DEBUG_LOG_FILE, date = new Date()): string | null {
  const descriptor = resolveLocalLogDescriptor(value);
  if (!descriptor) return null;
  return path.join(descriptor.directory, `${descriptor.prefix}-${localDebugLogDate(date, descriptor.timeZone)}.ndjson`);
}

/** Remove only this process role's dated files that predate the 7-day window. */
export function pruneLocalDebugLogs(descriptor: LocalLogDescriptor, date = new Date()): void {
  mkdirSync(descriptor.directory, { recursive: true });
  const cutoff = dateDaysBefore(localDebugLogDate(date, descriptor.timeZone), LOCAL_DEBUG_LOG_RETENTION_DAYS - 1);
  const pattern = new RegExp(`^${descriptor.prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}-(\\d{4}-\\d{2}-\\d{2})\\.ndjson$`, "u");
  for (const name of readdirSync(descriptor.directory)) {
    const match = pattern.exec(name);
    if (match && match[1] < cutoff) unlinkSync(path.join(descriptor.directory, name));
  }
}

class DailyRotatingLogStream extends Writable {
  constructor(
    private readonly descriptor: LocalLogDescriptor,
    private readonly now: () => Date = () => new Date(),
  ) {
    super();
    pruneLocalDebugLogs(descriptor, now());
  }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      const target = path.join(
        this.descriptor.directory,
        `${this.descriptor.prefix}-${localDebugLogDate(this.now(), this.descriptor.timeZone)}.ndjson`,
      );
      appendFile(target, chunk, (error) => callback(error));
    } catch (error) {
      callback(error instanceof Error ? error : new Error("Unable to write local debug log"));
    }
  }
}

export function createDailyRotatingLogStream(
  descriptor: LocalLogDescriptor,
  now?: () => Date,
): Writable {
  return new DailyRotatingLogStream(descriptor, now);
}

function createLogStream(): pino.DestinationStream | NodeJS.WritableStream {
  const streams: pino.StreamEntry[] = [{
    stream: process.env.NODE_ENV === "production"
      ? pino.destination(1)
      : pino.transport({ target: "pino-pretty", options: { colorize: true } }),
  }];
  const localDescriptor = resolveLocalLogDescriptor();
  if (localDescriptor) {
    streams.push({ stream: createDailyRotatingLogStream(localDescriptor) });
  }
  return pino.multistream(streams);
}

export const pinoInstance: pino.Logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: LOGGER_REDACTION,
}, createLogStream());

/**
 * Content-free lifecycle record for LLM, tool, planner, and worker paths.
 * Keep this closed schema: prompts, completions, tool arguments/results, and
 * exception messages are never accepted here.
 */
export type SafeRuntimeEvent = {
  component: "llm" | "tool" | "planner" | "worker" | "ui";
  event: string;
  operation: string;
  outcome?: "started" | "success" | "failure" | "retrying" | "cancelled";
  errorCode?: string;
  latencyMs?: number;
  attempt?: number;
  toolName?: string;
  promptVersion?: string;
  outputHash?: string;
  tokenCount?: number;
  itemCount?: number;
  /** Fixed browser screen name; never a URL or route parameter. */
  screen?: "home" | "explore" | "projects" | "trip" | "profile" | "login" | "register" | "forgot_password" | "unknown";
  httpStatus?: number;
  /** Validated UUIDs only; log/trace correlation, never metric labels. */
  relatedCorrelationId?: string;
  relatedClientRequestId?: string;
  /**
   * Durable task identity. `agent_task_runs.id` and the immutable constraint
   * snapshot the run is bound to. UUIDs only, for log/trace correlation and
   * for joining a log line to its `provider_search_runs` evidence row. Never
   * metric labels.
   */
  relatedRunId?: string;
  relatedSnapshotId?: string;
  /**
   * Provider identity and the normalized provider outcome for an external
   * search. Both are bounded server-side enums, never supplier-supplied text.
   */
  provider?: "amadeus" | "flightapi" | "serpapi" | "unconfigured";
  providerStatus?: "LIVE" | "UNAVAILABLE";
  /**
   * Controlled route identifiers resolved through the airport reference
   * before the request leaves the process. These are catalogue ids (e.g.
   * `SIN`, `NRT`), never free-text user input, and never metric labels.
   */
  originId?: string;
  destinationId?: string;
};

export function logSafeRuntimeEvent(ctx: RequestContext, event: SafeRuntimeEvent): void {
  correlationChild(
    pinoInstance,
    ctx.correlationId,
    ctx.clientRequestId,
    ctx.traceId,
    ctx.spanId,
  ).info({ runtime_event: event }, "Safe runtime diagnostic");
}

export function correlationChild(
  base: pino.Logger,
  correlationId: string,
  clientRequestId?: string | null,
  traceId?: string,
  spanId?: string,
): pino.Logger {
  // If the caller didn't pass ids, pull from the active OpenTelemetry span.
  // The span context is only consulted when SDK is enabled; when disabled,
  // `getActiveSpan` returns undefined and the binding is skipped silently.
  const activeSpan = traceId === undefined || spanId === undefined ? getActiveSpan() : undefined;
  const spanContext = activeSpan?.spanContext();
  const resolvedTraceId = traceId ?? spanContext?.traceId;
  const resolvedSpanId = spanId ?? spanContext?.spanId;
  const bindings: Record<string, string> = { correlationId };
  if (clientRequestId) bindings.clientRequestId = clientRequestId;
  if (resolvedTraceId && resolvedTraceId !== "00000000000000000000000000000000") {
    bindings.trace_id = resolvedTraceId;
  }
  if (resolvedSpanId && resolvedSpanId !== "0000000000000000") {
    bindings.span_id = resolvedSpanId;
  }
  return base.child(bindings);
}

declare module "fastify" {
  interface FastifyRequest {
    correlationId: string;
    /**
     * W3C trace id (32 lowercase hex chars). Server-owned: derived from
     * `traceparent` when present, otherwise freshly minted by
     * `apps/api/src/observability/tracing.ts#newTraceId`. Distinct from
     * `correlationId`, which remains the canonical request UUID for logs
     * and audit.
     */
    traceId: string;
    /**
     * W3C span id for the inbound HTTP server span (16 lowercase hex chars).
     * Populated together with `traceId` in the `onRequest` hook.
     */
    spanId: string;
    /**
     * Client-generated request id (from the `X-Request-Id` header). The
     * server always owns `correlationId`; this field carries the client
     * id verbatim when supplied so logs can correlate browser → server.
     */
    clientRequestId?: string;
    rawBody?: string;
    /**
     * Internal: the OpenTelemetry span attached to this request. Set in
     * `onRequest`, ended in `onResponse`. Handlers that want to attach
     * attributes should reference this field rather than calling
     * `trace.getActiveSpan()` (the active span is also installed, but
     * this reference avoids one map lookup).
     */
    _otelSpan?: Span;
    /**
     * Internal: an OTel `Context` that carries the active span. Stored so
     * sub-tasks (notably the durable Worker handoff) can re-enter the
     * context without having to walk the call stack.
     */
    _otelContext?: Context;
  }
}

export type { RequestContext };
